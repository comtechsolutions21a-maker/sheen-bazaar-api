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
    facebookUrl: { type: String, default: '' },
    instagramUrl: { type: String, default: '' },
    twitterUrl: { type: String, default: '' },
    // Coupon codes
    coupons: { type: Array, default: [] },
    // Low stock threshold
    lowStockThreshold: { type: Number, default: 10 },
  },
  { timestamps: true }
);

settingsSchema.statics.get = async function () {
  let doc = await this.findOne({ singleton: 'singleton' });
  if (!doc) doc = await this.create({ singleton: 'singleton' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
