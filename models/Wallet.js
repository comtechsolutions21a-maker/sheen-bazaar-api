const mongoose = require('mongoose');

const walletTxnSchema = new mongoose.Schema({
  type: { type: String, enum: ['add_money', 'order_payment', 'refund', 'cashback', 'transfer_in', 'transfer_out'], required: true },
  amount: { type: Number, required: true }, // positive = credit, negative = debit
  balance: { type: Number, required: true }, // balance after this txn
  description: { type: String, default: '' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  razorpayPaymentId: { type: String, default: '' },
  status: { type: String, enum: ['success', 'pending', 'failed'], default: 'success' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  balance: { type: Number, default: 0, min: 0 },
  transactions: { type: [walletTxnSchema], default: [] },
}, { timestamps: true });

walletSchema.statics.getOrCreate = async function (userId) {
  let wallet = await this.findOne({ user: userId });
  if (!wallet) wallet = await this.create({ user: userId, balance: 0 });
  return wallet;
};

walletSchema.methods.credit = function (amount, type, description, extra = {}) {
  this.balance += amount;
  this.transactions.unshift({ type, amount, balance: this.balance, description, ...extra });
  return this.save();
};

walletSchema.methods.debit = function (amount, type, description, extra = {}) {
  if (this.balance < amount) throw new Error('Insufficient wallet balance');
  this.balance -= amount;
  this.transactions.unshift({ type, amount: -amount, balance: this.balance, description, ...extra });
  return this.save();
};

module.exports = mongoose.model('Wallet', walletSchema);
