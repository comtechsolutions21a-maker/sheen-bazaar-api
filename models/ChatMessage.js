const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  from: { type: String, enum: ['customer', 'admin'], required: true },
  text: { type: String, required: true },
  at: { type: Date, default: Date.now },
}, { _id: false });

const chatThreadSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  messages: { type: [chatMessageSchema], default: [] },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  lastMessageAt: { type: Date, default: Date.now },
  unreadByAdmin: { type: Boolean, default: true },
  unreadByCustomer: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('ChatThread', chatThreadSchema);
