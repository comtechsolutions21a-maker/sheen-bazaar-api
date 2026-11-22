const mongoose = require('mongoose');

// Admin "push campaign": an offer/announcement sent to phones as a notification.
const campaignSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  url: { type: String, default: '/offers' },
  image: { type: String, default: '' },
  // all | customers | sellers | cart (items left in cart) | wishlist | inactive (no order in 30 days) | guests
  audience: { type: String, default: 'all' },
  scheduledAt: { type: Date, default: null },
  status: { type: String, enum: ['scheduled', 'sending', 'sent', 'cancelled', 'failed'], default: 'scheduled', index: true },
  recipients: { type: Number, default: 0 },   // people/devices targeted
  delivered: { type: Number, default: 0 },    // phones the notification actually reached
  sentAt: { type: Date, default: null },
  error: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Campaign', campaignSchema);
