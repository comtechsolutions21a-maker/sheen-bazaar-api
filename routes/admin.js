const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');
const SiteContent = require('../models/SiteContent');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const { recordCodCollection } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');

const router = express.Router();
router.use(auth(true), requireRole('admin'));

// ─── STATS ───
router.get('/stats', async (req, res) => {
  try {
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
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayRevenue = orders.filter(o => o.paymentStatus === 'paid' && new Date(o.createdAt) >= todayStart).reduce((s, o) => s + o.total, 0);
    const ordersByStatus = orders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const revenueByMonth = {};
    orders.filter(o => o.paymentStatus === 'paid' && new Date(o.createdAt) > sixMonthsAgo).forEach(o => {
      const month = new Date(o.createdAt).toLocaleString('default', { month: 'short', year: '2-digit' });
      revenueByMonth[month] = (revenueByMonth[month] || 0) + o.total;
    });

    res.json({ customerCount, sellerCount, pendingSellerCount, productCount, orderCount, collectedRevenue, pendingRevenue, commissionEarned, todayRevenue, commissionPercent: settings.commissionPercent, ordersByStatus, lowStockProducts, recentOrders, revenueByMonth });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── SETTINGS ───
router.get('/settings', async (req, res) => { res.json(await Settings.get()); });
router.put('/settings', async (req, res) => {
  const settings = await Settings.get();
  const allowed = ['commissionPercent','siteName','supportEmail','supportPhone','address','whatsappNumber','facebookUrl','instagramUrl','twitterUrl','lowStockThreshold'];
  allowed.forEach(k => { if (req.body[k] !== undefined) settings[k] = req.body[k]; });
  await settings.save();
  res.json(settings);
});

// ─── SITE CONTENT ───
router.get('/site-content', async (req, res) => { res.json(await SiteContent.get()); });
router.put('/site-content', async (req, res) => {
  const content = await SiteContent.get();
  const allowed = ['heroTitle','heroSubtitle','heroBadge','heroCta','announcementText','announcementActive','flashSaleActive','flashSaleText','flashSaleSubtext','maintenanceMode','maintenanceMessage','razorpayKeyId','razorpayKeySecret','razorpayLiveMode','razorpayEnabled','cashfreeAppId','cashfreeSecretKey','cashfreeLiveMode','cashfreeEnabled','primaryGateway'];
  allowed.forEach(k => { if (req.body[k] !== undefined) content[k] = req.body[k]; });
  await content.save();
  res.json(content);
});

// Public route for site content (no auth needed)
router.get('/public/site-content', async (req, res) => {
  const content = await SiteContent.get();
  // Don't expose secret keys publicly
  const safe = content.toObject();
  delete safe.razorpayKeySecret;
  delete safe.cashfreeSecretKey;
  res.json(safe);
});

// ─── USERS ───
router.get('/users', async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.search) filter.$or = [{ name: new RegExp(req.query.search, 'i') }, { email: new RegExp(req.query.search, 'i') }];
  const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

router.patch('/users/:id', async (req, res) => {
  const { sellerApproved, role, name, email, phone, membershipTier, banned } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (sellerApproved !== undefined) user.sellerApproved = !!sellerApproved;
  if (role && ['customer','seller','reseller','admin'].includes(role)) user.role = role;
  if (name) user.name = name;
  if (email) user.email = email;
  if (phone !== undefined) user.phone = phone;
  if (membershipTier !== undefined) user.membershipTier = membershipTier;
  if (banned !== undefined) user.banned = banned;
  await user.save();
  res.json(user.toSafeJSON ? user.toSafeJSON() : user);
});

router.patch('/users/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'Min 6 characters' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  user.password = newPassword;
  await user.save();
  res.json({ success: true });
});

router.post('/users/:id/email', async (req, res) => {
  const { subject, message } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT || 587, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.SMTP_FROM || 'Sheen Bazaar <noreply@sheenbazaar.online>', to: user.email, subject, html: `<div style="font-family:sans-serif;max-width:600px;margin:auto"><h2>${subject}</h2><p>${message}</p></div>` });
  } else { console.log(`[EMAIL] To: ${user.email} | ${subject}`); }
  res.json({ success: true });
});

router.post('/users/broadcast-email', async (req, res) => {
  const { subject, message, role } = req.body;
  const filter = role && role !== 'all' ? { role } : {};
  const users = await User.find(filter).select('email name');
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT || 587, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    for (const u of users) {
      await transporter.sendMail({ from: process.env.SMTP_FROM || 'Sheen Bazaar <noreply@sheenbazaar.online>', to: u.email, subject, html: `<div style="font-family:sans-serif;max-width:600px;margin:auto"><h2>Hi ${u.name},</h2><p>${message}</p></div>` });
    }
  } else { console.log(`[BROADCAST] ${subject} → ${users.length} users`); }
  res.json({ success: true, sent: users.length });
});

router.delete('/users/:id', async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) return res.status(400).json({ message: "Can't delete your own account" });
  await User.deleteOne({ _id: req.params.id });
  res.json({ deleted: true });
});

// ─── PRODUCTS ───
router.get('/products', async (req, res) => {
  const products = await Product.find({}).populate('seller', 'name businessName email').sort({ createdAt: -1 });
  res.json(products);
});

router.post('/products', async (req, res) => {
  try {
    const lastProduct = await Product.findOne({}).sort({ id: -1 });
    const newId = lastProduct ? lastProduct.id + 1 : 100;
    const product = await Product.create({ ...req.body, id: newId });
    res.status(201).json(product);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

router.patch('/products/:id', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const allowed = ['active','name','price','old','stock','badge','desc','icon','image','cat'];
  allowed.forEach(k => { if (req.body[k] !== undefined) product[k] = req.body[k]; });
  await product.save();
  res.json(product);
});

router.delete('/products/:id', async (req, res) => {
  await Product.deleteOne({ id: Number(req.params.id) });
  res.json({ deleted: true });
});

// ─── ORDERS ───
router.get('/orders', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const orders = await Order.find(filter).populate('user', 'name email phone').sort({ createdAt: -1 });
  res.json(orders);
});

router.patch('/orders/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['placed','confirmed','shipped','out_for_delivery','delivered','cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status' });
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

// ─── COUPONS ───
router.post('/coupons', async (req, res) => {
  const { code, discountPercent, maxUses, expiresAt, minOrderValue } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ message: 'code and discountPercent required' });
  const settings = await Settings.get();
  if (settings.coupons.find(c => c.code.toUpperCase() === code.toUpperCase())) return res.status(400).json({ message: 'Code already exists' });
  settings.coupons.push({ code: code.toUpperCase(), discountPercent: Number(discountPercent), maxUses: maxUses || 999, uses: 0, expiresAt: expiresAt || null, minOrderValue: minOrderValue || 0, active: true });
  await settings.save();
  res.json(settings.coupons);
});

router.delete('/coupons/:code', async (req, res) => {
  const settings = await Settings.get();
  settings.coupons = settings.coupons.filter(c => c.code !== req.params.code.toUpperCase());
  await settings.save();
  res.json(settings.coupons);
});

// ─── MEMBERSHIPS ───
router.get('/memberships', async (req, res) => { res.json(await Membership.find({})); });

router.post('/memberships', async (req, res) => {
  const membership = await Membership.create(req.body);
  res.status(201).json(membership);
});

router.patch('/memberships/:id', async (req, res) => {
  const membership = await Membership.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(membership);
});

router.delete('/memberships/:id', async (req, res) => {
  await Membership.deleteOne({ _id: req.params.id });
  res.json({ deleted: true });
});

// ─── NOTIFICATIONS ───
router.get('/notifications', async (req, res) => { res.json(await Notification.find({}).sort({ createdAt: -1 })); });

router.post('/notifications', async (req, res) => {
  const notification = await Notification.create(req.body);
  res.status(201).json(notification);
});

router.patch('/notifications/:id', async (req, res) => {
  const notification = await Notification.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(notification);
});

router.delete('/notifications/:id', async (req, res) => {
  await Notification.deleteOne({ _id: req.params.id });
  res.json({ deleted: true });
});

// Public route for active notifications
router.get('/public/notifications', async (req, res) => {
  const now = new Date();
  const notifications = await Notification.find({ isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).sort({ createdAt: -1 });
  res.json(notifications);
});

// ─── RAZORPAY ───
router.post('/razorpay/create-order', async (req, res) => {
  try {
    const content = await SiteContent.get();
    if (!content.razorpayKeyId || !content.razorpayKeySecret) return res.status(400).json({ message: 'Razorpay not configured. Add keys in Admin → Settings → Payments.' });
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({ key_id: content.razorpayKeyId, key_secret: content.razorpayKeySecret });
    const order = await razorpay.orders.create({ amount: req.body.amount * 100, currency: 'INR', receipt: `receipt_${Date.now()}` });
    res.json({ orderId: order.id, keyId: content.razorpayKeyId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/razorpay/verify', async (req, res) => {
  try {
    const content = await SiteContent.get();
    const crypto = require('crypto');
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto.createHmac('sha256', content.razorpayKeySecret).update(sign).digest('hex');
    if (expectedSign !== razorpay_signature) return res.status(400).json({ message: 'Payment verification failed' });
    // Mark order as paid
    const order = await Order.findById(orderId);
    if (order) {
      order.paymentStatus = 'paid';
      order.transactionId = razorpay_payment_id;
      order.status = 'confirmed';
      order.statusHistory.push({ status: 'confirmed', note: `Paid via Razorpay — ${razorpay_payment_id}` });
      await applyCommission(order);
      await order.save();
    }
    res.json({ success: true, paymentId: razorpay_payment_id });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ─── CASHFREE ───
router.post('/cashfree/create-order', async (req, res) => {
  try {
    const content = await SiteContent.get();
    if (!content.cashfreeAppId || !content.cashfreeSecretKey) return res.status(400).json({ message: 'Cashfree not configured. Add keys in Admin → Payments.' });
    const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
    const orderId = `cf_${Date.now()}`;
    const response = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': content.cashfreeAppId,
        'x-client-secret': content.cashfreeSecretKey,
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: req.body.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: String(req.user._id),
          customer_name: req.user.name,
          customer_email: req.user.email,
          customer_phone: req.user.phone || '9999999999',
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Cashfree order creation failed');
    res.json({ orderId, paymentSessionId: data.payment_session_id, liveMode: content.cashfreeLiveMode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cashfree/verify', async (req, res) => {
  try {
    const content = await SiteContent.get();
    const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
    const { cfOrderId, orderId } = req.body;
    const response = await fetch(`${base}/orders/${cfOrderId}/payments`, {
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': content.cashfreeAppId,
        'x-client-secret': content.cashfreeSecretKey,
      },
    });
    const payments = await response.json();
    const successPayment = Array.isArray(payments) ? payments.find(p => p.payment_status === 'SUCCESS') : null;
    if (!successPayment) return res.status(400).json({ message: 'Payment not confirmed yet' });
    // Mark order paid
    const order = await Order.findById(orderId);
    if (order) {
      order.paymentStatus = 'paid';
      order.transactionId = successPayment.cf_payment_id;
      order.status = 'confirmed';
      order.statusHistory.push({ status: 'confirmed', note: `Paid via Cashfree — ${successPayment.cf_payment_id}` });
      await applyCommission(order);
      await order.save();
    }
    res.json({ success: true, paymentId: successPayment.cf_payment_id });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Public gateway status — tells frontend which gateways are available
router.get('/public/gateways', async (req, res) => {
  const content = await SiteContent.get();
  res.json({
    razorpay: !!(content.razorpayEnabled && content.razorpayKeyId),
    cashfree: !!(content.cashfreeEnabled && content.cashfreeAppId),
    primary: content.primaryGateway || 'razorpay',
  });
});

module.exports = router;
