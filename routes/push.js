const express = require('express');
const auth = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');
const { getVapid, pushToUser } = require('../utils/push');

const router = express.Router();

// GET /api/push/public-key — the app needs this to subscribe
router.get('/public-key', async (req, res) => {
  const { publicKey } = await getVapid();
  res.json({ publicKey });
});

// POST /api/push/subscribe { subscription } — save this device for the logged-in user
router.post('/subscribe', auth(true), async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ message: 'Invalid subscription' });
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { user: req.userId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Welcome notification so the customer sees it working straight away
  pushToUser(req.userId, { title: 'Sheen Bazaar 🛍️', body: 'Notifications are on! We\'ll tell you when your orders move.', url: '/orders', tag: 'welcome' });
  res.json({ success: true });
});

// POST /api/push/unsubscribe { endpoint }
router.post('/unsubscribe', auth(true), async (req, res) => {
  if (req.body?.endpoint) await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.userId });
  res.json({ success: true });
});

module.exports = router;
