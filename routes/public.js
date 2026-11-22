// Truly public, unauthenticated storefront config endpoints.
// Mounted at /api/admin BEFORE the auth-walled admin router in server.js,
// so these specific paths are reachable by anyone while everything else
// under /api/admin still requires an admin login.
const express = require('express');
const SiteContent = require('../models/SiteContent');
const Notification = require('../models/Notification');
const Settings = require('../models/Settings');
const Product = require('../models/Product');
const { checkPincode } = require('../utils/pincode');

const router = express.Router();

// GET /api/admin/public/site-content — hero text, banners, maintenance mode, etc.
router.get('/public/site-content', async (req, res) => {
  const content = await SiteContent.get();
  const safe = content.toObject();
  delete safe.razorpayKeySecret;
  delete safe.cashfreeSecretKey;
  res.json(safe);
});

// GET /api/admin/public/notifications?role=customer|seller|reseller
router.get('/public/notifications', async (req, res) => {
  const now = new Date();
  const filter = { isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  if (req.query.role) filter.targetRole = { $in: ['all', req.query.role] };
  const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(30);
  res.json(notifications);
});

// GET /api/admin/public/offers — coupons the admin chose to show publicly +
// products currently on a flash sale (for the Offers page and countdowns).
router.get('/public/offers', async (req, res) => {
  const settings = await Settings.get();
  const now = new Date();
  const coupons = (settings.coupons || [])
    .filter(c => c && c.active !== false && c.showOnOffers !== false &&
      (c.maxUses == null || (c.uses || 0) < c.maxUses) &&
      (!c.expiresAt || new Date(c.expiresAt) >= now))
    .map(c => ({
      code: c.code, discountPercent: c.discountPercent, minOrderValue: c.minOrderValue || 0,
      expiresAt: c.expiresAt || null, description: c.description || '',
      usesLeft: c.maxUses != null ? Math.max(0, c.maxUses - (c.uses || 0)) : null,
    }));

  const flash = await Product.find({ active: true, flashPrice: { $gt: 0 }, flashEndsAt: { $gt: now } })
    .select('-reviews -questions -qna -stockAlerts')
    .sort({ flashEndsAt: 1 })
    .limit(40);

  res.json({ coupons, flashSales: flash.filter(p => p.flashPrice < p.price) });
});

// GET /api/admin/public/pincode/:pin?productId=123 — delivery estimate + COD check
router.get('/public/pincode/:pin', async (req, res) => {
  const settings = await Settings.get();
  let days = 5;
  if (req.query.productId) {
    const p = await Product.findOne({ id: Number(req.query.productId) }).select('deliveryDays');
    if (p?.deliveryDays) days = p.deliveryDays;
  }
  res.json(checkPincode(settings, req.params.pin, days));
});

// GET /api/admin/public/gateways — which payment gateways are live, and which is primary
router.get('/public/gateways', async (req, res) => {
  const content = await SiteContent.get();
  res.json({
    razorpay: !!(content.razorpayEnabled && content.razorpayKeyId),
    cashfree: !!(content.cashfreeEnabled && content.cashfreeAppId),
    primary: content.primaryGateway || 'razorpay',
  });
});

// GET /api/admin/public/tax-config — GST status/rate, for printing compliant invoices
router.get('/public/tax-config', async (req, res) => {
  const settings = await Settings.get();
  res.json({
    gstEnabled: !!settings.gstEnabled,
    gstin: settings.gstEnabled ? settings.gstin : '',
    gstPercent: settings.gstPercent || 18,
  });
});

// GET /api/admin/public/social — social media links & WhatsApp contact for footer, buttons, etc.
router.get('/public/social', async (req, res) => {
  const settings = await Settings.get();
  res.json({
    whatsappNumber: settings.whatsappNumber || '',
    whatsappMessage: settings.whatsappMessage || 'Hi! I have a question about a product on Sheen Bazaar.',
    facebookUrl: settings.facebookUrl || '',
    instagramUrl: settings.instagramUrl || '',
    twitterUrl: settings.twitterUrl || '',
    youtubeUrl: settings.youtubeUrl || '',
    linkedinUrl: settings.linkedinUrl || '',
    pinterestUrl: settings.pinterestUrl || '',
    telegramUrl: settings.telegramUrl || '',
    threadsUrl: settings.threadsUrl || '',
    supportEmail: settings.supportEmail || '',
    supportPhone: settings.supportPhone || '',
    address: settings.address || '',
  });
});

// POST /api/admin/public/track-visit — anonymous page-view tracking for the
// admin analytics dashboard. No auth, no personal info — just a path and a
// random visitor id the frontend keeps in localStorage.
router.post('/public/track-visit', async (req, res) => {
  try {
    const { path, visitorId } = req.body;
    if (!path || !visitorId) return res.status(400).json({ message: 'path and visitorId are required' });
    const Visit = require('../models/Visit');
    // Fire-and-forget from the frontend's perspective — but we still await
    // here so a DB error doesn't become an unhandled rejection.
    await Visit.create({ path: String(path).slice(0, 200), visitorId: String(visitorId).slice(0, 100) });
    res.status(204).end();
  } catch (err) {
    // Never let analytics break the page — just log it.
    console.error('track-visit failed:', err.message);
    res.status(204).end();
  }
});

module.exports = router;
