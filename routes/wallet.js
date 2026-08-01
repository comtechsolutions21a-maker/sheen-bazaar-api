const express = require('express');
const crypto = require('crypto');
const Wallet = require('../models/Wallet');
const SiteContent = require('../models/SiteContent');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth(true));

// GET /api/wallet — balance + recent transactions
router.get('/', async (req, res) => {
  const wallet = await Wallet.getOrCreate(req.user._id);
  res.json({ balance: wallet.balance, transactions: wallet.transactions.slice(0, 50) });
});

// POST /api/wallet/add-money/create — create Razorpay order to add money
router.post('/add-money/create', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 10 || amount > 50000) return res.status(400).json({ message: 'Amount must be ₹10 – ₹50,000' });
    const content = await SiteContent.get();
    if (!content.razorpayKeyId || !content.razorpayKeySecret) return res.status(400).json({ message: 'Payments not configured yet. Contact support.' });
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({ key_id: content.razorpayKeyId, key_secret: content.razorpayKeySecret });
    const order = await razorpay.orders.create({ amount: amount * 100, currency: 'INR', receipt: `wallet_${Date.now()}` });
    res.json({ orderId: order.id, keyId: content.razorpayKeyId, amount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/wallet/add-money/verify — verify payment and credit wallet
router.post('/add-money/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
    const content = await SiteContent.get();
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', content.razorpayKeySecret).update(sign).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ message: 'Payment verification failed' });

    const wallet = await Wallet.getOrCreate(req.user._id);
    await wallet.credit(Number(amount), 'add_money', `Added ₹${amount} via Razorpay`, { razorpayPaymentId: razorpay_payment_id });
    res.json({ success: true, balance: wallet.balance });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/wallet/pay — pay for an order using wallet balance
router.post('/pay', async (req, res) => {
  try {
    const { amount, orderId, description } = req.body;
    const wallet = await Wallet.getOrCreate(req.user._id);
    await wallet.debit(Number(amount), 'order_payment', description || `Order payment ₹${amount}`, { orderId });
    res.json({ success: true, balance: wallet.balance });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /api/wallet/transfer — send money to another Sheen Bazaar user by email
router.post('/transfer', async (req, res) => {
  try {
    const { toEmail, amount } = req.body;
    const amt = Number(amount);
    if (!toEmail || !amt || amt < 1) return res.status(400).json({ message: 'Valid email and amount required' });
    const User = require('../models/User');
    const toUser = await User.findOne({ email: toEmail.toLowerCase() });
    if (!toUser) return res.status(404).json({ message: 'No Sheen Bazaar user with that email' });
    if (String(toUser._id) === String(req.user._id)) return res.status(400).json({ message: "You can't transfer to yourself" });

    const fromWallet = await Wallet.getOrCreate(req.user._id);
    const toWallet = await Wallet.getOrCreate(toUser._id);
    await fromWallet.debit(amt, 'transfer_out', `Sent ₹${amt} to ${toUser.name} (${toUser.email})`);
    await toWallet.credit(amt, 'transfer_in', `Received ₹${amt} from ${req.user.name} (${req.user.email})`);
    res.json({ success: true, balance: fromWallet.balance });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
