const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const { APPROVED_COURIERS, PLATFORM_COURIER_NAME } = require('../constants');
const { recordCodCollection } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');

const router = express.Router();
router.use(auth(true), requireRole('seller'));

async function nextProductId() {
  const last = await Product.findOne().sort({ id: -1 }).select('id');
  return last ? last.id + 1 : 1;
}

// GET /api/seller/me — seller's own profile + approval status
router.get('/me', (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

// GET /api/seller/couriers — platform-approved couriers for self-ship orders
router.get('/couriers', (req, res) => {
  res.json({ approvedCouriers: APPROVED_COURIERS, platformCourierName: PLATFORM_COURIER_NAME });
});

// GET /api/seller/products — this seller's own listings
router.get('/products', async (req, res) => {
  const products = await Product.find({ seller: req.user._id }).sort({ createdAt: -1 });
  res.json(products);
});

// POST /api/seller/products — create a new listing
router.post('/products', async (req, res) => {
  try {
    const { name, icon, image, price, old, rating, badge, cat, desc, stock } = req.body;
    if (!name || !price || !cat) {
      return res.status(400).json({ message: 'name, price and cat are required' });
    }
    const product = await Product.create({
      id: await nextProductId(),
      name,
      icon: icon || '🛍️',
      image: image || '',
      price,
      old: old || price,
      rating: rating || 4.0,
      badge: badge || '',
      cat,
      desc: desc || '',
      stock: stock ?? 100,
      seller: req.user._id,
      // Listing goes live immediately only if the seller is already approved.
      active: !!req.user.sellerApproved,
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create product', error: err.message });
  }
});

// PUT /api/seller/products/:id — update own listing
router.put('/products/:id', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id), seller: req.user._id });
  if (!product) return res.status(404).json({ message: 'Listing not found' });

  const fields = ['name', 'icon', 'image', 'price', 'old', 'rating', 'badge', 'cat', 'desc', 'stock', 'active'];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) product[f] = req.body[f];
  });
  await product.save();
  res.json(product);
});

// DELETE /api/seller/products/:id — remove own listing
router.delete('/products/:id', async (req, res) => {
  const result = await Product.deleteOne({ id: Number(req.params.id), seller: req.user._id });
  if (result.deletedCount === 0) return res.status(404).json({ message: 'Listing not found' });
  res.json({ deleted: true });
});

// GET /api/seller/orders — orders containing at least one item from this seller
router.get('/orders', async (req, res) => {
  const orders = await Order.find({ 'items.seller': req.user._id }).sort({ createdAt: -1 });
  // Only return the line items that belong to this seller, to avoid leaking other sellers' data.
  const scoped = orders.map((o) => ({
    _id: o._id,
    createdAt: o.createdAt,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    transactionId: o.transactionId,
    shipping: o.shipping,
    address: o.address,
    items: o.items.filter((i) => String(i.seller) === String(req.user._id)),
  }));
  res.json(scoped);
});

// GET /api/seller/earnings — how much money has actually reached this seller's
// business account (paid orders) vs what's still outstanding (pending COD).
router.get('/earnings', async (req, res) => {
  const orders = await Order.find({ 'items.seller': req.user._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });

  let paidTotal = 0;
  let pendingTotal = 0;
  let paidOrders = 0;
  let pendingOrders = 0;

  const transactions = orders.map((o) => {
    const myItems = o.items.filter((i) => String(i.seller) === String(req.user._id));
    const grossAmount = myItems.reduce((sum, i) => sum + (i.basePrice ?? i.price) * i.qty, 0);
    // Step 7 — Commission: once paid, each item carries the platform's cut and
    // the supplier's payout as settled at that time. Before that, nothing has
    // been split yet, so payout shows as the full (unsettled) amount.
    const commission = myItems.reduce((sum, i) => sum + (i.commissionAmount || 0), 0);
    const payoutAmount = o.paymentStatus === 'paid' ? myItems.reduce((sum, i) => sum + i.payoutAmount, 0) : grossAmount;

    if (o.paymentStatus === 'paid') {
      paidTotal += payoutAmount;
      paidOrders += 1;
    } else {
      pendingTotal += payoutAmount;
      pendingOrders += 1;
    }

    return {
      orderId: o._id,
      date: o.createdAt,
      grossAmount,
      commission,
      amount: payoutAmount,
      commissionPercent: o.commissionPercent,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      transactionId: o.transactionId,
      orderStatus: o.status,
    };
  });

  res.json({ paidTotal, pendingTotal, paidOrders, pendingOrders, transactions });
});

// PATCH /api/seller/orders/:id/status — advance the fulfillment status of an order
// containing this seller's items. Sellers can move it forward but not to "delivered"
// (reserved for confirmation flows) or "cancelled" (admin/customer only, kept simple here).
router.patch('/orders/:id/status', async (req, res) => {
  const { status, note, shippingMethod, courierPartner, trackingNumber } = req.body;
  const allowed = ['confirmed', 'shipped', 'out_for_delivery'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
  }

  const order = await Order.findOne({ _id: req.params.id, 'items.seller': req.user._id });
  if (!order) return res.status(404).json({ message: 'Order not found' });

  // Shipping — Step 5: the seller must pick how the order leaves them.
  if (status === 'shipped') {
    if (!['courier_pickup', 'self_ship'].includes(shippingMethod)) {
      return res.status(400).json({ message: 'shippingMethod must be "courier_pickup" or "self_ship"' });
    }
    if (shippingMethod === 'self_ship') {
      if (!APPROVED_COURIERS.includes(courierPartner)) {
        return res.status(400).json({ message: `courierPartner must be one of the platform's approved couriers: ${APPROVED_COURIERS.join(', ')}` });
      }
      if (!trackingNumber || !trackingNumber.trim()) {
        return res.status(400).json({ message: 'trackingNumber is required for self-ship orders' });
      }
      order.shipping = { method: 'self_ship', courierPartner, trackingNumber: trackingNumber.trim() };
    } else {
      // Platform's courier partner picks the order up — no tracking number required from the seller.
      order.shipping = { method: 'courier_pickup', courierPartner: PLATFORM_COURIER_NAME, trackingNumber: trackingNumber?.trim() || '' };
    }
  }

  order.status = status;
  order.statusHistory.push({ status, note: note || '' });

  // Step 6 — Payment: COD money reaches the business account when it's actually
  // collected at the door, i.e. on delivery. Online payments are already 'paid'.
  if (status === 'delivered' && order.paymentMethod === 'COD' && order.paymentStatus !== 'paid') {
    const collection = recordCodCollection(order._id);
    order.paymentStatus = 'paid';
    order.transactionId = collection.transactionId;
    // Step 7 — Commission: cash just landed, so split it between the
    // platform's commission and the supplier's payout now.
    await applyCommission(order);
  }

  await order.save();
  res.json(order);
});

module.exports = router;

// PATCH /api/seller/orders/:id/return — approve or reject return
router.patch('/orders/:id/return', async (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'
  const order = await Order.findOne({ _id: req.params.id, 'items.seller': req.user._id });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  order.returnStatus = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve') { order.status = 'returned'; order.statusHistory.push({ status: 'returned', note: 'Return approved by seller', updatedBy: 'seller' }); }
  await order.save();
  res.json(order);
});
