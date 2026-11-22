const mongoose = require('mongoose');

// A customer's personal notification inbox (order updates, offers, price drops…).
// Old entries are removed automatically after 60 days.
const userNotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true },
  body: { type: String, default: '' },
  url: { type: String, default: '/' },
  image: { type: String, default: '' },
  type: { type: String, enum: ['order', 'offer', 'price', 'chat', 'reward', 'system'], default: 'system' },
  read: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 24 * 60 * 60 },
});
userNotificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('UserNotification', userNotificationSchema);
