const mongoose = require('mongoose');

const siteContentSchema = new mongoose.Schema({
  singleton: { type: String, default: 'singleton', unique: true },
  // Hero section
  heroTitle: { type: String, default: 'Flat 50% off on your first order' },
  heroSubtitle: { type: String, default: 'Discover thousands of deals across fashion, home essentials and electronics.' },
  heroBadge: { type: String, default: '🎉 New User Offer' },
  heroCta: { type: String, default: 'Start Shopping' },
  // Announcement bar
  announcementText: { type: String, default: '🚚 Free delivery on orders above ₹499' },
  announcementActive: { type: Boolean, default: true },
  // Flash sale
  flashSaleActive: { type: Boolean, default: true },
  flashSaleText: { type: String, default: '⚡ Flash Sale — up to 80% off' },
  flashSaleSubtext: { type: String, default: 'Limited time offer — grab it before it\'s gone!' },
  // Maintenance
  maintenanceMode: { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: 'Site is under maintenance. Back soon!' },
  // Razorpay
  razorpayKeyId: { type: String, default: '' },
  razorpayKeySecret: { type: String, default: '' },
  razorpayLiveMode: { type: Boolean, default: false },
  razorpayEnabled: { type: Boolean, default: true },
  // Cashfree
  cashfreeAppId: { type: String, default: '' },
  cashfreeSecretKey: { type: String, default: '' },
  cashfreeLiveMode: { type: Boolean, default: false },
  cashfreeEnabled: { type: Boolean, default: false },
  // Which gateway is primary: 'razorpay' or 'cashfree'
  primaryGateway: { type: String, enum: ['razorpay', 'cashfree'], default: 'razorpay' },
}, { timestamps: true });

siteContentSchema.statics.get = async function () {
  let doc = await this.findOne({ singleton: 'singleton' });
  if (!doc) doc = await this.create({ singleton: 'singleton' });
  return doc;
};

module.exports = mongoose.model('SiteContent', siteContentSchema);
