const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'singleton', unique: true },
    commissionPercent: { type: Number, default: null, min: 0, max: 100 },
    // Site info
    siteName: { type: String, default: 'Sheen Bazaar' },
    supportEmail: { type: String, default: '' },
    supportPhone: { type: String, default: '' },
    address: { type: String, default: '' },
    whatsappNumber: { type: String, default: '911234567890' },
    whatsappMessage: { type: String, default: 'Hi! I have a question about a product on Sheen Bazaar.' },
    facebookUrl: { type: String, default: '' },
    instagramUrl: { type: String, default: '' },
    twitterUrl: { type: String, default: '' },
    youtubeUrl: { type: String, default: '' },
    linkedinUrl: { type: String, default: '' },
    pinterestUrl: { type: String, default: '' },
    telegramUrl: { type: String, default: '' },
    threadsUrl: { type: String, default: '' },
    // Coupon codes
    coupons: { type: Array, default: [] },
    // Low stock threshold
    lowStockThreshold: { type: Number, default: 10 },
    // GST / tax registration — used to print GST-compliant invoices once registered
    gstin: { type: String, default: '' },
    gstEnabled: { type: Boolean, default: false },
    gstPercent: { type: Number, default: 18 }, // default GST slab; seller/admin can override per product later
    // Referral program
    referralRewardAmount: { type: Number, default: 50 }, // wallet credit for both referrer & referee
  },
  { timestamps: true }
);

settingsSchema.statics.get = async function () {
  let doc = await this.findOne({ singleton: 'singleton' });
  if (!doc) doc = await this.create({ singleton: 'singleton' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
