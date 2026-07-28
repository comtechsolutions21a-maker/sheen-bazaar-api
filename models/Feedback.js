const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, default: 'Customer' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  type: { type: String, enum: ['order', 'recharge', 'wallet', 'general'], default: 'general' },
  city: { type: String, default: '' },
  approved: { type: Boolean, default: true }, // admin can hide bad ones
  featured: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
