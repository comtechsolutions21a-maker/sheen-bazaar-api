const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const { recordCodCollection } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');

const router = express.Router();
router.use(auth(true), requireRole('admin'));

// GET /api/admin/stats — headline dashboard numbers
router.get('/stats', async (req, res) => {
  const [customerCount, sellerCount, pendingSellerCount, productCount, orderCount, orders, settings] = await Promise.all([
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'seller' }),
    User.countDocuments({ role: 'seller', sellerApproved: false }),
    Product.countDocuments({}),
    Order.countDocuments({}),
    Order.find({}).select('total status paymentStatus items'),
    Settings.get(),
  ]);

  const collectedRevenue = orders
    .filter((o) => o.status !== 'cancelled' && o.paymentStatus === 'paid')
    .reduce((sum, o) => sum + o.total, 0);
  const pendingRevenue = orders
    .filter((o) => o.status !== 'cancelled' && o.paymentStatus !== 'paid')
    .reduce((sum, o) => sum + o.total, 0);

  // Step 7 — Commission: sum of what the platform has actually kept so far,
  // across every settled (paid) order's line items.
  const commissionEarned = orders
    .filter((o) => o.status !== 'cancelled' && o.paymentStatus === 'paid')
    .reduce((sum, o) => sum + o.items.reduce((s, i) => s + (i.commissionAmount || 0), 0), 0);

  // Step 7 (extended) — total markup paid out to resellers so far, across
  // every settled order. This comes out of the supplier/reseller side, not
  // the platform's own cut.
  const resellerPayouts = orders
    .filter((o) => o.status !== 'cancelled' && o.paymentStatus === 'paid')
    .reduce((sum, o) => sum + o.items.reduce((s, i) => s + (i.resellerCommissionAmount || 0), 0), 0);

  const ordersByStatus = orders.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    customerCount, sellerCount, pendingSellerCount, productCount, orderCount,
    revenue: collectedRevenue, // kept for backward compatibility
    collectedRevenue,
    pendingRevenue,
    commissionEarned,
    resellerPayouts,
    commissionPercent: settings.commissionPercent,
    ordersByStatus,
  });
});

// GET /api/admin/settings — current platform settings (e.g. commission rate)
router.get('/settings', async (req, res) => {
  const settings = await Settings.get();
  res.json({ commissionPercent: settings.commissionPercent });
});

// PUT /api/admin/settings — admin manually sets the commission rate (%) kept
// on every order going forward. There is no built-in default rate; it must
// be entered here before commission is deducted from anyone's payout.
router.put('/settings', async (req, res) => {
  const { commissionPercent } = req.body;
  if (commissionPercent === undefined || commissionPercent === null || commissionPercent === '') {
    return res.status(400).json({ message: 'commissionPercent is required' });
  }
  const value = Number(commissionPercent);
  if (Number.isNaN(value) || value < 0 || value > 100) {
    return res.status(400).json({ message: 'commissionPercent must be a number between 0 and 100' });
  }
  const settings = await Settings.get();
  settings.commissionPercent = value;
  await settings.save();
  res.json({ commissionPercent: settings.commissionPercent });
});

// GET /api/admin/users?role=seller
router.get('/users', async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

// PATCH /api/admin/users/:id — approve/reject a seller, or change a user's role
router.patch('/users/:id', async (req, res) => {
  const { sellerApproved, role } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  if (sellerApproved !== undefined) user.sellerApproved = !!sellerApproved;
  if (role && ['customer', 'seller', 'admin'].includes(role)) user.role = role;

  await user.save();
  res.json(user.toSafeJSON());
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(400).json({ message: "You can't delete your own admin account" });
  }
  const result = await User.deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ message: 'User not found' });
  res.json({ deleted: true });
});

// GET /api/admin/products
router.get('/products', async (req, res) => {
  const products = await Product.find({}).populate('seller', 'name businessName email').sort({ createdAt: -1 });
  res.json(products);
});

// PATCH /api/admin/products/:id — e.g. deactivate a listing
router.patch('/products/:id', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (req.body.active !== undefined) product.active = !!req.body.active;
  await product.save();
  res.json(product);
});

// DELETE /api/admin/products/:id
router.delete('/products/:id', async (req, res) => {
  const result = await Product.deleteOne({ id: Number(req.params.id) });
  if (result.deletedCount === 0) return res.status(404).json({ message: 'Product not found' });
  res.json({ deleted: true });
});

// GET /api/admin/orders
router.get('/orders', async (req, res) => {
  const orders = await Order.find({}).populate('user', 'name email').sort({ createdAt: -1 });
  res.json(orders);
});

// PATCH /api/admin/orders/:id/status — admin can set any status, including cancelled
router.patch('/orders/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
  }
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order not found' });

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
