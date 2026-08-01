// Truly public, unauthenticated storefront config endpoints.
// Mounted at /api/admin BEFORE the auth-walled admin router in server.js,
// so these specific paths are reachable by anyone while everything else
// under /api/admin still requires an admin login.
const express = require('express');
const SiteContent = require('../models/SiteContent');
const Notification = require('../models/Notification');
const Settings = require('../models/Settings');

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
  });
});

module.exports = router;
