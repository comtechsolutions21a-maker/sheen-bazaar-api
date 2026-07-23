const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['info', 'promo', 'order', 'alert'], default: 'info' },
  targetRole: { type: String, enum: ['all', 'customer', 'seller', 'reseller'], default: 'all' },
  isActive: { type: Boolean, default: true },
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
