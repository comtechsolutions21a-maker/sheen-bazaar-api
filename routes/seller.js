const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const { APPROVED_COURIERS, PLATFORM_COURIER_NAME } = require('../constants');
const { recordCodCollection } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');

const { notifyOrderStatus } = require('../utils/mailer');
const { onProductPriceChange, snapshot } = require('../utils/priceWatch');
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
// Every product field a seller is allowed to set. (Previously only name /
// price / first image etc. were saved — brand, extra photos, highlights,
// specifications and delivery/return days were silently dropped.)
// `rating` is intentionally NOT here: ratings come from real reviews only.
const SELLER_PRODUCT_FIELDS = [
  'name', 'icon', 'image', 'images', 'price', 'old', 'badge', 'cat', 'desc', 'stock',
  'brand', 'sku', 'highlights', 'specifications', 'variants', 'tags',
  'deliveryDays', 'returnDays', 'warrantyMonths', 'returnPolicy',
  'flashPrice', 'flashEndsAt', 'weightKg',
];

function pickProductFields(body) {
  const out = {};
  for (const f of SELLER_PRODUCT_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (Array.isArray(out.images)) out.images = out.images.filter((x) => typeof x === 'string').slice(0, 8);
  if (out.images?.length && !out.image) out.image = out.images[0];
  if (out.flashPrice !== undefined) out.flashPrice = Math.max(0, Number(out.flashPrice) || 0);
  if (out.flashEndsAt !== undefined) out.flashEndsAt = out.flashEndsAt ? new Date(out.flashEndsAt) : null;
  if (out.flashEndsAt && Number.isNaN(out.flashEndsAt.getTime())) out.flashEndsAt = null;
  return out;
}

router.post('/products', async (req, res) => {
  try {
    const data = pickProductFields(req.body);
    if (!data.name || !data.price || !data.cat) {
      return res.status(400).json({ message: 'name, price and cat are required' });
    }
    const product = await Product.create({
      icon: '🛍️',
      ...data,
      id: await nextProductId(),
      old: data.old || data.price,
      stock: data.stock ?? 100,
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

  const wasOutOfStock = product.stock === 0;
  const before = snapshot(product);
  const data = pickProductFields(req.body);
  Object.assign(product, data);
  if (req.body.active !== undefined) product.active = !!req.body.active && !!req.user.sellerApproved;
  await product.save();
  onProductPriceChange(before, product); // automatic price-drop / flash-sale alerts
  if (wasOutOfStock && product.stock > 0) {
    const { notifyBackInStock } = require('../utils/stockAlerts');
    notifyBackInStock(product).catch((err) => console.error('notifyBackInStock failed:', err.message));
  }
  res.json(product);
});

// POST /api/seller/products/bulk { rows: [...] }
// Bulk upload from the Excel/CSV template. A row whose SKU matches one of this
// seller's products UPDATES it (only the filled-in columns change, so a sheet
// with just sku + price + stock works as a quick price/stock sync); any other
// row CREATES a new product.
router.post('/products/bulk', async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 500) : [];
  if (!rows.length) return res.status(400).json({ message: 'No rows found in the file' });

  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const num = (v) => { const n = Number(String(v).replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
  const list = (v) => String(v).split('|').map((x) => x.trim()).filter(Boolean);

  const skus = rows.map((r) => String(r.sku || '').trim()).filter(Boolean);
  const existing = await Product.find({ seller: req.user._id, sku: { $in: skus } });
  const bySku = new Map(existing.map((p) => [p.sku, p]));
  const seen = new Set();
  const result = { created: 0, updated: 0, failed: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = Number(r.__row) || i + 2;
    try {
      const sku = String(r.sku || '').trim();
      if (sku && seen.has(sku)) throw new Error(`SKU "${sku}" appears twice in the file`);
      if (sku) seen.add(sku);

      const data = {};
      if (has(r.name)) data.name = String(r.name).trim().slice(0, 200);
      if (has(r.category)) data.cat = String(r.category).trim();
      if (has(r.price)) { data.price = num(r.price); if (!(data.price > 0)) throw new Error('price must be a number above 0'); }
      if (has(r.mrp)) { data.old = num(r.mrp); if (!(data.old >= 0)) throw new Error('mrp must be a number'); }
      if (has(r.stock)) { data.stock = Math.floor(num(r.stock)); if (!(data.stock >= 0)) throw new Error('stock must be 0 or more'); }
      if (has(r.brand)) data.brand = String(r.brand).trim().slice(0, 80);
      if (has(r.description)) data.desc = String(r.description).trim().slice(0, 5000);
      if (has(r.image_urls)) {
        data.images = list(r.image_urls).filter((u) => /^https?:\/\//i.test(u)).slice(0, 8);
        if (data.images.length) data.image = data.images[0];
      }
      if (has(r.highlights)) data.highlights = list(r.highlights).slice(0, 10);
      if (has(r.delivery_days)) data.deliveryDays = Math.max(1, Math.floor(num(r.delivery_days)) || 5);
      if (has(r.return_days)) data.returnDays = Math.max(0, Math.floor(num(r.return_days)) || 0);
      if (has(r.weight_kg)) data.weightKg = Math.max(0, num(r.weight_kg) || 0);
      if (has(r.flash_price)) data.flashPrice = Math.max(0, num(r.flash_price) || 0);
      if (has(r.flash_ends)) {
        const d = new Date(String(r.flash_ends).trim().replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) throw new Error('flash_ends must look like 2026-12-31 18:00');
        data.flashEndsAt = d;
      }

      const product = sku ? bySku.get(sku) : null;
      if (product) {
        const before = snapshot(product);
        const wasOutOfStock = product.stock === 0;
        Object.assign(product, data);
        await product.save();
        onProductPriceChange(before, product);
        if (wasOutOfStock && product.stock > 0) {
          const { notifyBackInStock } = require('../utils/stockAlerts');
          notifyBackInStock(product).catch(() => {});
        }
        result.updated++;
      } else {
        if (!data.name || !data.price || !data.cat) throw new Error('new products need name, category and price');
        const created = await Product.create({
          icon: '🛍️', ...data, sku,
          id: await nextProductId(),
          old: data.old || data.price,
          stock: data.stock ?? 100,
          seller: req.user._id,
          active: !!req.user.sellerApproved,
        });
        if (sku) bySku.set(sku, created);
        result.created++;
      }
    } catch (err) {
      result.failed.push({ row: rowNo, sku: r.sku || '', name: r.name || '', error: err.message });
    }
  }
  res.json(result);
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
    total: o.total,
    shipments: (o.shipments || []).filter((s) => String(s.seller) === String(req.user._id)),
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
    const payoutSettled = o.paymentStatus === 'paid' && myItems.every((i) => i.payoutSettled);

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
      payoutSettled,
      commissionPercent: o.commissionPercent,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      transactionId: o.transactionId,
      orderStatus: o.status,
    };
  });

  res.json({ paidTotal, pendingTotal, paidOrders, pendingOrders, transactions });
});

// GET /api/seller/report — monthly sales/payout figures + best sellers for charts
router.get('/report', async (req, res) => {
  const me = String(req.user._id);
  const since = new Date(); since.setMonth(since.getMonth() - 11); since.setDate(1); since.setHours(0, 0, 0, 0);
  const orders = await Order.find({ 'items.seller': req.user._id }).sort({ createdAt: 1 });

  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(since); d.setMonth(since.getMonth() + i);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }), orders: 0, sales: 0, payout: 0, commission: 0 });
  }
  const monthMap = new Map(months.map((m) => [m.key, m]));
  const products = new Map();
  const totals = { orders: 0, sales: 0, commission: 0, settled: 0, awaitingPayout: 0, pendingCod: 0, cancelled: 0, returned: 0, delivered: 0 };

  for (const o of orders) {
    const mine = o.items.filter((i) => String(i.seller) === me);
    if (!mine.length) continue;
    if (o.status === 'cancelled') { totals.cancelled++; continue; }
    if (o.status === 'returned') { totals.returned++; continue; }
    if (o.status === 'delivered') totals.delivered++;

    const gross = mine.reduce((s, i) => s + (i.basePrice ?? i.price) * i.qty, 0);
    const commission = o.paymentStatus === 'paid' ? mine.reduce((s, i) => s + (i.commissionAmount || 0), 0) : 0;
    const payout = o.paymentStatus === 'paid' ? mine.reduce((s, i) => s + (i.payoutAmount || 0), 0) : gross;

    totals.orders++; totals.sales += gross; totals.commission += commission;
    if (o.paymentStatus !== 'paid') totals.pendingCod += payout;
    else if (mine.every((i) => i.payoutSettled)) totals.settled += payout;
    else totals.awaitingPayout += payout;

    const d = new Date(o.createdAt);
    const m = monthMap.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    if (m) { m.orders++; m.sales += gross; m.payout += payout; m.commission += commission; }

    for (const i of mine) {
      const p = products.get(i.productId) || { productId: i.productId, name: i.name, qty: 0, sales: 0 };
      p.qty += i.qty; p.sales += (i.basePrice ?? i.price) * i.qty;
      products.set(i.productId, p);
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  months.forEach((m) => { m.sales = round(m.sales); m.payout = round(m.payout); m.commission = round(m.commission); });
  Object.keys(totals).forEach((k) => { totals[k] = round(totals[k]); });
  const top = [...products.values()].sort((a, b) => b.sales - a.sales).slice(0, 8).map((p) => ({ ...p, sales: round(p.sales) }));
  res.json({ months, totals, topProducts: top });
});

// PATCH /api/seller/orders/:id/status — advance the fulfillment status of an order
// containing this seller's items. Sellers can move it forward but not to "delivered"
// (reserved for confirmation flows) or "cancelled" (admin/customer only, kept simple here).
router.patch('/orders/:id/status', async (req, res) => {
  const { status, note, shippingMethod, courierPartner, trackingNumber } = req.body;
  const allowed = ['confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
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

  const previousStatus = order.status;
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

    // Refer & Earn: mark this customer's first paid order (COD counts too) so
    // admins can see who's eligible for a referral reward and follow up.
    try {
      const User = require('../models/User');
      const orderUser = await User.findById(order.user);
      if (orderUser?.referredBy && !orderUser.referralRewardGiven) {
        orderUser.referralRewardGiven = true;
        await orderUser.save();
      }
    } catch (refErr) { console.error('Referral tracking failed:', refErr.message); }
  }

  await order.save();
  if (previousStatus !== status) notifyOrderStatus(order, status);
  res.json(order);
});

// PATCH /api/seller/orders/:id/return — approve or reject a customer's return request
router.patch('/orders/:id/return', async (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'
  const order = await Order.findOne({ _id: req.params.id, 'items.seller': req.user._id });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  order.returnStatus = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve') { order.status = 'returned'; order.statusHistory.push({ status: 'returned', note: 'Return approved by seller', updatedBy: 'seller' }); }
  await order.save();
  notifyOrderStatus(order, action === 'approve' ? 'returned' : 'return_rejected');
  res.json(order);
});

module.exports = router;
