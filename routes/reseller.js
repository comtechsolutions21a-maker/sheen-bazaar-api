const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth(true), requireRole('reseller'));

// GET /api/reseller/me
router.get('/me', (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

// GET /api/reseller/catalog — every active product a reseller could choose to
// resell, with this reseller's own listing (if any) attached so the UI can
// show "already listed at ₹X" vs "not listed yet".
router.get('/catalog', async (req, res) => {
  const products = await Product.find({ active: true }).populate('seller', 'name businessName').sort({ createdAt: -1 });
  const listings = await ResellerListing.find({ reseller: req.user._id });
  const listingMap = new Map(listings.map((l) => [l.productId, l]));

  const catalog = products.map((p) => ({
    product: p,
    listing: listingMap.get(p.id) || null,
  }));
  res.json(catalog);
});

// GET /api/reseller/listings — this reseller's own listings, with product info
router.get('/listings', async (req, res) => {
  const listings = await ResellerListing.find({ reseller: req.user._id }).sort({ createdAt: -1 });
  const productIds = listings.map((l) => l.productId);
  const products = await Product.find({ id: { $in: productIds } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  res.json(listings.map((l) => ({
    _id: l._id,
    productId: l.productId,
    resellPrice: l.resellPrice,
    active: l.active,
    product: productMap.get(l.productId) || null,
    commission: productMap.get(l.productId) ? l.resellPrice - productMap.get(l.productId).price : null,
  })));
});

// POST /api/reseller/listings  { productId, resellPrice } — create or update
// this reseller's listing for a product. resellPrice must be entered manually
// and must be at least the product's own price (a reseller can't sell below
// cost and still earn a commission).
router.post('/listings', async (req, res) => {
  const { productId, resellPrice } = req.body;
  if (!productId || resellPrice === undefined) {
    return res.status(400).json({ message: 'productId and resellPrice are required' });
  }
  const product = await Product.findOne({ id: Number(productId), active: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const price = Number(resellPrice);
  if (Number.isNaN(price) || price < product.price) {
    return res.status(400).json({ message: `resellPrice must be at least the product's price (₹${product.price})` });
  }

  const listing = await ResellerListing.findOneAndUpdate(
    { reseller: req.user._id, productId: product.id },
    { resellPrice: price, active: true },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json(listing);
});

// PATCH /api/reseller/listings/:productId — update price and/or pause a listing
router.patch('/listings/:productId', async (req, res) => {
  const listing = await ResellerListing.findOne({ reseller: req.user._id, productId: Number(req.params.productId) });
  if (!listing) return res.status(404).json({ message: 'Listing not found' });

  if (req.body.resellPrice !== undefined) {
    const product = await Product.findOne({ id: listing.productId });
    const price = Number(req.body.resellPrice);
    if (Number.isNaN(price) || (product && price < product.price)) {
      return res.status(400).json({ message: `resellPrice must be at least the product's price${product ? ` (₹${product.price})` : ''}` });
    }
    listing.resellPrice = price;
  }
  if (req.body.active !== undefined) listing.active = !!req.body.active;

  await listing.save();
  res.json(listing);
});

// DELETE /api/reseller/listings/:productId
router.delete('/listings/:productId', async (req, res) => {
  const result = await ResellerListing.deleteOne({ reseller: req.user._id, productId: Number(req.params.productId) });
  if (result.deletedCount === 0) return res.status(404).json({ message: 'Listing not found' });
  res.json({ deleted: true });
});

// GET /api/reseller/orders — orders containing at least one item sold through
// this reseller's listing. The reseller doesn't fulfill anything (the
// supplier does), this is just visibility into what's selling.
router.get('/orders', async (req, res) => {
  const orders = await Order.find({ 'items.reseller': req.user._id }).sort({ createdAt: -1 });
  const scoped = orders.map((o) => ({
    _id: o._id,
    createdAt: o.createdAt,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    items: o.items.filter((i) => String(i.reseller) === String(req.user._id)),
  }));
  res.json(scoped);
});

// GET /api/reseller/earnings — the markup this reseller has earned. Paid once
// the order's payment is actually collected (see utils/commission.js).
router.get('/earnings', async (req, res) => {
  const orders = await Order.find({ 'items.reseller': req.user._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });

  let paidTotal = 0;
  let pendingTotal = 0;
  let paidOrders = 0;
  let pendingOrders = 0;

  const transactions = orders.map((o) => {
    const myItems = o.items.filter((i) => String(i.reseller) === String(req.user._id));
    const potentialCommission = myItems.reduce((sum, i) => sum + (i.price - i.basePrice) * i.qty, 0);
    const settledCommission = myItems.reduce((sum, i) => sum + (i.resellerCommissionAmount || 0), 0);
    const amount = o.paymentStatus === 'paid' ? settledCommission : potentialCommission;

    if (o.paymentStatus === 'paid') {
      paidTotal += amount;
      paidOrders += 1;
    } else {
      pendingTotal += amount;
      pendingOrders += 1;
    }

    return {
      orderId: o._id,
      date: o.createdAt,
      amount,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      orderStatus: o.status,
    };
  });

  res.json({ paidTotal, pendingTotal, paidOrders, pendingOrders, transactions });
});

module.exports = router;
