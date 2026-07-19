const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

// Store OTPs temporarily in memory (in production use Redis)
const otpStore = new Map();

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP via Fast2SMS
async function sendOTP(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.log(`[OTP] Phone: ${phone} | OTP: ${otp} (FAST2SMS_API_KEY not set)`);
    return true;
  }
  const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&variables_values=${otp}&route=otp&numbers=${phone}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('[Fast2SMS]', data);
  return data.return === true;
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.length !== 10) {
      return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
    }
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStore.set(phone, { otp, expiresAt, attempts: 0 });
    await sendOTP(phone, otp);
    res.json({ success: true, message: `OTP sent to ${phone}` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send OTP', error: err.message });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!phone || !otp) return res.status(400).json({ message: 'Phone and OTP required' });

    const stored = otpStore.get(phone);
    if (!stored) return res.status(400).json({ message: 'OTP expired or not sent. Request a new one.' });
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ message: 'OTP expired. Request a new one.' });
    }
    stored.attempts++;
    if (stored.attempts > 5) {
      otpStore.delete(phone);
      return res.status(400).json({ message: 'Too many attempts. Request a new OTP.' });
    }
    if (stored.otp !== otp) {
      return res.status(400).json({ message: `Incorrect OTP. ${5 - stored.attempts} attempts left.` });
    }

    otpStore.delete(phone);

    // Find or create user by phone
    let user = await User.findOne({ phone });
    if (!user) {
      // New user — create account
      user = await User.create({
        name: name || `User${phone.slice(-4)}`,
        email: `${phone}@phone.sheenbazaar.com`,
        password: Math.random().toString(36),
        phone,
        role: 'customer',
      });
    }

    const token = signToken(user._id);
    res.json({ token, user: user.toSafeJSON(), isNewUser: !name });
  } catch (err) {
    res.status(500).json({ message: 'Verification failed', error: err.message });
  }
});

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, phone, role, businessName } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    const safeRole = ['seller', 'reseller'].includes(role) ? role : 'customer';
    if (safeRole === 'seller' && !businessName) {
      return res.status(400).json({ message: 'Business name is required for seller accounts' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' });

    const user = await User.create({
      name, email, password, phone,
      role: safeRole,
      businessName: safeRole === 'seller' || safeRole === 'reseller' ? businessName : '',
      sellerApproved: false,
    });
    const token = signToken(user._id);
    res.status(201).json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: 'Signup failed', error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
    const token = signToken(user._id);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: 'Login failed', error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', auth(true), async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ user: user.toSafeJSON() });
});

module.exports = router;
