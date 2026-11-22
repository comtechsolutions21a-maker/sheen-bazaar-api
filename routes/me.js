// Customer "me" endpoints: notification inbox, wishlist sync, price alerts, Spin & Win
const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const UserNotification = require('../models/UserNotification');
const { effectivePrice } = require('../utils/pricing');
const { notifyLater } = require('../utils/notify');

const router = express.Router();
router.use(auth(true));

// ─── Notification inbox ───
// GET /api/me/notifications → { items, unread }
router.get('/notifications', async (req, res) => {
  const [items, unread] = await Promise.all([
    UserNotification.find({ user: req.userId }).sort({ createdAt: -1 }).limit(60),
    UserNotification.countDocuments({ user: req.userId, read: false }),
  ]);
  res.json({ items, unread });
});

router.post('/notifications/read-all', async (req, res) => {
  await UserNotification.updateMany({ user: req.userId, read: false }, { $set: { read: true } });
  res.json({ unread: 0 });
});

router.post('/notifications/:id/read', async (req, res) => {
  await UserNotification.updateOne({ _id: req.params.id, user: req.userId }, { $set: { read: true } });
  const unread = await UserNotification.countDocuments({ user: req.userId, read: false });
  res.json({ unread });
});

router.delete('/notifications', async (req, res) => {
  await UserNotification.deleteMany({ user: req.userId });
  res.json({ unread: 0 });
});

// ─── Wishlist sync (the app keeps the full list; the server keeps ids for alerts) ───
const cleanIds = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite))].slice(0, 500);

router.get('/wishlist', async (req, res) => {
  const u = await User.findById(req.userId).select('wishlist');
  res.json({ ids: u?.wishlist || [] });
});
// PUT { ids, merge } — merge=true adds the phone's list to what's saved (used right after login)
router.put('/wishlist', async (req, res) => {
  const u = await User.findById(req.userId).select('wishlist');
  if (!u) return res.status(404).json({ message: 'User not found' });
  u.wishlist = cleanIds(req.body.merge ? [...u.wishlist, ...(req.body.ids || [])] : req.body.ids);
  await u.save();
  res.json({ ids: u.wishlist });
});
router.post('/wishlist/:productId', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $addToSet: { wishlist: Number(req.params.productId) } });
  res.json({ ok: true });
});
router.delete('/wishlist/:productId', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $pull: { wishlist: Number(req.params.productId) } });
  res.json({ ok: true });
});

// ─── Price alerts: "notify me when it drops below ₹X" ───
router.get('/price-alerts', async (req, res) => {
  const u = await User.findById(req.userId).select('priceAlerts');
  res.json(u?.priceAlerts || []);
});
router.post('/price-alerts', async (req, res) => {
  const productId = Number(req.body.productId);
  const targetPrice = Math.round(Number(req.body.targetPrice));
  const product = await Product.findOne({ id: productId, active: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const now = effectivePrice(product);
  if (!targetPrice || targetPrice <= 0) return res.status(400).json({ message: 'Enter the price you want to pay' });
  if (targetPrice >= now) return res.status(400).json({ message: `It's already ₹${now} — enter a price lower than that.` });
  const u = await User.findById(req.userId).select('priceAlerts');
  u.priceAlerts = (u.priceAlerts || []).filter((a) => a.productId !== productId);
  u.priceAlerts.push({ productId, targetPrice });
  if (u.priceAlerts.length > 50) u.priceAlerts = u.priceAlerts.slice(-50);
  await u.save();
  res.json(u.priceAlerts);
});
router.delete('/price-alerts/:productId', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $pull: { priceAlerts: { productId: Number(req.params.productId) } } });
  res.json({ ok: true });
});

// ─── Spin & Win (one spin every 24 hours → personal one-time coupon) ───
const SPIN_EVERY_MS = 24 * 60 * 60 * 1000;
// Segments shown on the wheel, in order. weight = chance.
const PRIZES = [
  { label: '5% OFF', percent: 5, weight: 34 },
  { label: 'Try again', percent: 0, weight: 12 },
  { label: '10% OFF', percent: 10, weight: 28 },
  { label: '7% OFF', percent: 7, weight: 14 },
  { label: '15% OFF', percent: 15, weight: 8 },
  { label: 'Try again', percent: 0, weight: 2 },
  { label: '20% OFF', percent: 20, weight: 1.5 },
  { label: '12% OFF', percent: 12, weight: 0.5 },
];
const SPIN_MIN_ORDER = 299;

router.get('/spin', async (req, res) => {
  const u = await User.findById(req.userId).select('lastSpinAt');
  const next = u?.lastSpinAt ? new Date(u.lastSpinAt.getTime() + SPIN_EVERY_MS) : null;
  const settings = await Settings.get();
  const active = (settings.coupons || []).filter((c) => c.userId && String(c.userId) === String(req.userId) && c.active !== false && (c.uses || 0) < (c.maxUses || 1) && (!c.expiresAt || new Date(c.expiresAt) > new Date()));
  res.json({
    prizes: PRIZES.map((p) => p.label),
    canSpin: !next || next <= new Date(),
    nextSpinAt: next && next > new Date() ? next : null,
    minOrder: SPIN_MIN_ORDER,
    myCoupons: active.map((c) => ({ code: c.code, discountPercent: c.discountPercent, expiresAt: c.expiresAt, minOrderValue: c.minOrderValue })),
  });
});

router.post('/spin', async (req, res) => {
  // Atomic "claim the spin" so double-taps can't spin twice
  const cutoff = new Date(Date.now() - SPIN_EVERY_MS);
  const u = await User.findOneAndUpdate(
    { _id: req.userId, $or: [{ lastSpinAt: null }, { lastSpinAt: { $lte: cutoff } }] },
    { $set: { lastSpinAt: new Date() } },
    { new: true }
  );
  if (!u) return res.status(429).json({ message: 'You already spun today — come back tomorrow!' });

  const total = PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = (crypto.randomInt(0, 1_000_000) / 1_000_000) * total;
  let index = 0;
  for (; index < PRIZES.length - 1; index++) { r -= PRIZES[index].weight; if (r < 0) break; }
  const prize = PRIZES[index];

  let coupon = null;
  if (prize.percent > 0) {
    const settings = await Settings.get();
    const code = `SPIN${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    coupon = {
      code, discountPercent: prize.percent, maxUses: 1, uses: 0,
      expiresAt: new Date(Date.now() + SPIN_EVERY_MS).toISOString(),
      minOrderValue: SPIN_MIN_ORDER, active: true, showOnOffers: false,
      userId: String(u._id), description: 'Spin & Win reward',
    };
    // Drop this user's old expired/used spin coupons so the list stays small
    settings.coupons = (settings.coupons || []).filter((c) => !(c.userId && String(c.userId) === String(u._id) && ((c.uses || 0) >= (c.maxUses || 1) || (c.expiresAt && new Date(c.expiresAt) < new Date()))));
    settings.coupons.push(coupon);
    settings.markModified('coupons');
    await settings.save();
    notifyLater(u._id, { title: `🎉 You won ${prize.percent}% OFF!`, body: `Use code ${code} on orders above ₹${SPIN_MIN_ORDER}. Valid for 24 hours.`, url: '/spin', type: 'reward' }, { push: false });
  }
  res.json({ index, prize: prize.label, coupon, nextSpinAt: new Date(u.lastSpinAt.getTime() + SPIN_EVERY_MS) });
});

module.exports = router;
