const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema({
  name: { type: String, enum: ['Free', 'Basic', 'Pro', 'VIP'], required: true },
  price: { type: Number, required: true }, // monthly price in INR
  discountPercent: { type: Number, default: 0 }, // extra discount on every order
  freeDelivery: { type: Boolean, default: false },
  prioritySupport: { type: Boolean, default: false },
  badge: { type: String, default: '' }, // emoji badge shown on profile
  color: { type: String, default: '#8A7A87' },
  features: [{ type: String }],
  active: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Membership', membershipSchema);
