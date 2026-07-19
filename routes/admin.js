const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const { recordCodCollection } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');
const nodemailer = require('nodemailer');

const router = express.Router();
router.use(auth(true), requireRole('admin'));

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  const [customerCount, sellerCount, pendingSellerCount, productCount, orderCount, orders, settings, lowStockProducts, recentOrders] = await Promise.all([
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'seller' }),
    User.countDocuments({ role: 'seller', sellerApproved: false }),
    Product.countDocuments({}),
    Order.countDocuments({}),
    Order.find({}).select('total status paymentStatus items createdAt'),
    Settings.get(),
    Product.find({ stock: { $lte: 10 }, active: true }).select('name stock icon'),
    Order.find({}).sort({ createdAt: -1 }).limit(5).populate('user', 'name email').select('total status createdAt user items'),
  ]);

  const collectedRevenue = orders.filter(o => o.status !== 'cancelled' && o.paymentStatus === 'paid').reduce((s, o) => s + o.total, 0);
  const pendingRevenue = orders.filter(o => o.status !== 'cancelled' && o.paymentStatus !== 'paid').reduce((s, o) => s + o.total, 0);
  const commissionEarned = orders.filter(o => o.status !== 'cancelled' && o.paymentStatus === 'paid').reduce((s, o) => s + o.items.reduce((si, i) => si + (i.commissionAmount || 0), 0), 0);
  const resellerPayouts = orders.filter(o => o.status !== 'cancelled' && o.paymentStatus === 'paid').reduce((s, o) => s + o.items.reduce((si, i) => si + (i.resellerCommissionAmount || 0), 0), 0);
  const ordersByStatus = orders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});

  // Revenue by month (last 6 months)
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const revenueByMonth = {};
  orders.filter(o => o.paymentStatus === 'paid' && new Date(o.createdAt) > sixMonthsAgo).forEach(o => {
    const month = new Date(o.createdAt).toLocaleString('default', { month: 'short', year: '2-digit' });
    revenueByMonth[month] = (revenueByMonth[month] || 0) + o.total;
  });

  res.json({
    customerCount, sellerCount, pendingSellerCount, productCount, orderCount,
    revenue: collectedRevenue, collectedRevenue, pendingRevenue, commissionEarned, resellerPayouts,
    commissionPercent: settings.commissionPercent, ordersByStatus,
    lowStockProducts, recentOrders, revenueByMonth,
  });
});

// GET /api/admin/settings
router.get('/settings', async (req, res) => {
  const settings = await Settings.get();
  res.json(settings);
});

// PUT /api/admin/settings
router.put('/settings', async (req, res) => {
  const settings = await Settings.get();
  const allowed = ['commissionPercent','siteName','supportEmail','supportPhone','address','whatsappNumber','facebookUrl','instagramUrl','twitterUrl','lowStockThreshold'];
  allowed.forEach(k => { if (req.body[k] !== undefined) settings[k] = req.body[k]; });
  await settings.save();
  res.json(settings);
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.search) filter.$or = [{ name: new RegExp(req.query.search, 'i') }, { email: new RegExp(req.query.search, 'i') }];
  const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', async (req, res) => {
  const { sellerApproved, role, name, email, phone } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (sellerApproved !== undefined) user.sellerApproved = !!sellerApproved;
  if (role && ['customer', 'seller', 'reseller', 'admin'].includes(role)) user.role = role;
  if (name) user.name = name;
  if (email) user.email = email;
  if (phone !== undefined) user.phone = phone;
  await user.save();
  res.json(user.toSafeJSON());
});

// PATCH /api/admin/users/:id/reset-password
router.patch('/users/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  user.password = newPassword;
  await user.save();
  res.json({ success: true });
});

// POST /api/admin/users/:id/email — send email to a user
router.post('/users/:id/email', async (req, res) => {
  const { subject, message } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const settings = await Settings.get();

  if (!process.env.SMTP_HOST) {
    console.log(`[EMAIL] To: ${user.email} | Subject: ${subject} | Message: ${message}`);
    return res.json({ success: true, note: 'Logged to console (SMTP not configured)' });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: process.env.SMTP_PORT || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `${settings.siteName} <noreply@sheenbazaar.com>`,
    to: user.email, subject,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:auto"><h2>${subject}</h2><p>${message}</p><hr><small>${settings.siteName}</small></div>`,
  });
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) return res.status(400).json({ message: "You can't delete your own admin account" });
  const result = await User.deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ message: 'User not found' });
  res.json({ deleted: true });
});

// GET /api/admin/products
router.get('/products', async (req, res) => {
  const products = await Product.find({}).populate('seller', 'name businessName email').sort({ createdAt: -1 });
  res.json(products);
});

// POST /api/admin/products — admin adds a product directly
router.post('/products', async (req, res) => {
  try {
    const lastProduct = await Product.findOne({}).sort({ id: -1 });
    const newId = lastProduct ? lastProduct.id + 1 : 100;
    const product = await Product.create({ ...req.body, id: newId });
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH /api/admin/products/:id
router.patch('/products/:id', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const allowed = ['active', 'name', 'price', 'old', 'stock', 'badge', 'desc', 'icon', 'image', 'cat'];
  allowed.forEach(k => { if (req.body[k] !== undefined) product[k] = req.body[k]; });
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
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const orders = await Order.find(filter).populate('user', 'name email').sort({ createdAt: -1 });
  res.json(orders);
});

// PATCH /api/admin/orders/:id/status
router.patch('/orders/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order not found' });
  order.status = status;
  order.statusHistory.push({ status, note: note || '' });
  if (status === 'delivered' && order.paymentMethod === 'COD' && order.paymentStatus !== 'paid') {
    const collection = recordCodCollection(order._id);
    order.paymentStatus = 'paid';
    order.transactionId = collection.transactionId;
    await applyCommission(order);
  }
  await order.save();
  res.json(order);
});

// POST /api/admin/coupons — create coupon
router.post('/coupons', async (req, res) => {
  const { code, discountPercent, maxUses, expiresAt } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ message: 'code and discountPercent required' });
  const settings = await Settings.get();
  const existing = settings.coupons.find(c => c.code.toUpperCase() === code.toUpperCase());
  if (existing) return res.status(400).json({ message: 'Coupon code already exists' });
  settings.coupons.push({ code: code.toUpperCase(), discountPercent: Number(discountPercent), maxUses: maxUses || 999, uses: 0, expiresAt: expiresAt || null, active: true });
  await settings.save();
  res.json(settings.coupons);
});

// DELETE /api/admin/coupons/:code
router.delete('/coupons/:code', async (req, res) => {
  const settings = await Settings.get();
  settings.coupons = settings.coupons.filter(c => c.code !== req.params.code.toUpperCase());
  await settings.save();
  res.json(settings.coupons);
});

module.exports = router;
