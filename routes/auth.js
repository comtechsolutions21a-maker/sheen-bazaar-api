const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Store OTPs temporarily in memory (in production use Redis)
const otpStore = new Map();

// Store Twitter/X PKCE state <-> code_verifier temporarily (5 min TTL)
const twitterStateStore = new Map();

// Generates a random, unique-ish name/email suffix for social signups that
// don't share a usable display name up front.
function randomPassword() {
  return crypto.randomBytes(24).toString('hex');
}

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
    const { name, email, password, phone, role, businessName, referralCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    const safeRole = ['seller', 'reseller'].includes(role) ? role : 'customer';
    if (safeRole === 'seller' && !businessName) {
      return res.status(400).json({ message: 'Business name is required for seller accounts' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' });

    // Generate a unique referral code for this new user, e.g. SHEEN-A1B2C3
    let newCode;
    for (let i = 0; i < 5; i++) {
      const candidate = `SHEEN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!(await User.findOne({ referralCode: candidate }))) { newCode = candidate; break; }
    }

    // Link to the referrer, if a valid code was supplied
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) referredBy = referrer._id;
    }

    const user = await User.create({
      name, email, password, phone,
      role: safeRole,
      businessName: safeRole === 'seller' || safeRole === 'reseller' ? businessName : '',
      sellerApproved: false,
      referralCode: newCode,
      referredBy,
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

// ---------------------------------------------------------------------------
// Social login — Google, Facebook, X (Twitter)
// ---------------------------------------------------------------------------

// Finds an existing user by provider id (or by email, to link accounts that
// already signed up the normal way), or creates a brand-new one.
async function findOrCreateSocialUser({ providerField, providerId, email, name, avatar }) {
  let user = await User.findOne({ [providerField]: providerId });
  if (user) return user;

  if (email) {
    user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user[providerField] = providerId;
      if (avatar && !user.avatar) user.avatar = avatar;
      await user.save();
      return user;
    }
  }

  user = await User.create({
    name: name || 'Sheen Bazaar User',
    email: email ? email.toLowerCase() : `${providerId}@${providerField.replace('Id', '')}.sheenbazaar.com`,
    password: randomPassword(),
    avatar: avatar || '',
    role: 'customer',
    [providerField]: providerId,
  });
  return user;
}

// POST /api/auth/google — body: { credential } (the ID token from Google Identity Services)
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ message: 'Missing Google credential' });
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ message: 'Google login is not configured on the server (missing GOOGLE_CLIENT_ID)' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) return res.status(401).json({ message: 'Invalid Google token' });

    const user = await findOrCreateSocialUser({
      providerField: 'googleId',
      providerId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatar: payload.picture,
    });

    const token = signToken(user._id);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(401).json({ message: 'Google sign-in failed', error: err.message });
  }
});

// POST /api/auth/facebook — body: { accessToken } (from the Facebook JS SDK's FB.login)
router.post('/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ message: 'Missing Facebook access token' });
    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
      return res.status(500).json({ message: 'Facebook login is not configured on the server' });
    }

    // Verify the token actually belongs to our app before trusting it.
    const appToken = `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`;
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${appToken}`
    );
    const debugData = await debugRes.json();
    if (!debugData?.data?.is_valid || debugData.data.app_id !== process.env.FACEBOOK_APP_ID) {
      return res.status(401).json({ message: 'Invalid Facebook token' });
    }

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`
    );
    const profile = await profileRes.json();
    if (!profile?.id) return res.status(401).json({ message: 'Could not fetch Facebook profile' });

    const user = await findOrCreateSocialUser({
      providerField: 'facebookId',
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      avatar: profile.picture?.data?.url,
    });

    const token = signToken(user._id);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(401).json({ message: 'Facebook sign-in failed', error: err.message });
  }
});

// GET /api/auth/twitter/login — kicks off the X (Twitter) OAuth 2.0 + PKCE redirect flow
router.get('/twitter/login', (req, res) => {
  if (!process.env.TWITTER_CLIENT_ID) {
    return res.status(500).send('X login is not configured on the server (missing TWITTER_CLIENT_ID)');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  twitterStateStore.set(state, { codeVerifier, expiresAt: Date.now() + 5 * 60 * 1000 });

  const redirectUri = process.env.TWITTER_CALLBACK_URL;
  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.TWITTER_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'tweet.read users.read offline.access');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(authUrl.toString());
});

// GET /api/auth/twitter/callback — X redirects here after the user approves the login
router.get('/twitter/callback', async (req, res) => {
  const frontendUrl = process.env.CLIENT_ORIGIN?.split(',')[0] || 'http://localhost:5173';
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${frontendUrl}/auth/callback?error=${encodeURIComponent(error)}`);

    const stored = twitterStateStore.get(state);
    twitterStateStore.delete(state);
    if (!stored || Date.now() > stored.expiresAt) {
      return res.redirect(`${frontendUrl}/auth/callback?error=expired_state`);
    }

    const basicAuth = Buffer.from(`${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        code: String(code),
        grant_type: 'authorization_code',
        client_id: process.env.TWITTER_CLIENT_ID,
        redirect_uri: process.env.TWITTER_CALLBACK_URL,
        code_verifier: stored.codeVerifier,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.redirect(`${frontendUrl}/auth/callback?error=token_exchange_failed`);
    }

    const profileRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profileData = await profileRes.json();
    const twitterUser = profileData?.data;
    if (!twitterUser?.id) {
      return res.redirect(`${frontendUrl}/auth/callback?error=profile_fetch_failed`);
    }

    // X's basic OAuth scopes don't return an email address, so social accounts
    // created this way get a placeholder email the user can update in their profile.
    const user = await findOrCreateSocialUser({
      providerField: 'twitterId',
      providerId: twitterUser.id,
      name: twitterUser.name,
      avatar: twitterUser.profile_image_url,
    });

    const jwtToken = signToken(user._id);
    res.redirect(`${frontendUrl}/auth/callback?token=${jwtToken}`);
  } catch (err) {
    res.redirect(`${frontendUrl}/auth/callback?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/auth/me
router.get('/me', auth(true), async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ user: user.toSafeJSON() });
});

module.exports = router;

// Store email OTPs
const emailOtpStore = new Map();

// POST /api/auth/send-email-otp
router.post('/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    emailOtpStore.set(email.toLowerCase(), { otp, expiresAt, attempts: 0 });

    // Send via nodemailer if SMTP configured, else log
    if (process.env.SMTP_HOST) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Sheen Bazaar <noreply@sheenbazaar.com>',
        to: email,
        subject: `Your Sheen Bazaar OTP: ${otp}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#FFF6F2;border-radius:16px">
            <h2 style="color:#A8114F;margin:0 0 8px">🛍️ Sheen Bazaar</h2>
            <p style="color:#2B1330;font-size:15px">Your one-time login code is:</p>
            <div style="font-size:42px;font-weight:900;letter-spacing:10px;color:#D9276B;text-align:center;padding:20px;background:#fff;border-radius:12px;margin:16px 0">${otp}</div>
            <p style="color:#8A7A87;font-size:13px">This OTP expires in 5 minutes. Do not share it with anyone.</p>
            <hr style="border:none;border-top:1px solid #EFE1E7;margin:20px 0">
            <p style="color:#8A7A87;font-size:12px">If you didn't request this, ignore this email.</p>
          </div>
        `,
      });
    } else {
      console.log(`[EMAIL OTP] To: ${email} | OTP: ${otp}`);
    }

    res.json({ success: true, message: `OTP sent to ${email}` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send OTP email', error: err.message });
  }
});

// POST /api/auth/verify-email-otp
router.post('/verify-email-otp', async (req, res) => {
  try {
    const { email, otp, name } = req.body;
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });

    const stored = emailOtpStore.get(email.toLowerCase());
    if (!stored) return res.status(400).json({ message: 'OTP expired or not sent. Request a new one.' });
    if (Date.now() > stored.expiresAt) {
      emailOtpStore.delete(email.toLowerCase());
      return res.status(400).json({ message: 'OTP expired. Request a new one.' });
    }
    stored.attempts++;
    if (stored.attempts > 5) {
      emailOtpStore.delete(email.toLowerCase());
      return res.status(400).json({ message: 'Too many attempts. Request a new OTP.' });
    }
    if (stored.otp !== otp) {
      return res.status(400).json({ message: `Incorrect OTP. ${5 - stored.attempts} attempts left.` });
    }

    emailOtpStore.delete(email.toLowerCase());

    // Find or create user by email
    let user = await User.findOne({ email: email.toLowerCase() });
    const isNewUser = !user;
    if (!user) {
      user = await User.create({
        name: name || email.split('@')[0],
        email: email.toLowerCase(),
        password: Math.random().toString(36) + Math.random().toString(36),
        role: 'customer',
      });
    }

    const token = signToken(user._id);
    res.json({ token, user: user.toSafeJSON(), isNewUser });
  } catch (err) {
    res.status(500).json({ message: 'Verification failed', error: err.message });
  }
});

// POST /api/auth/seller-docs — seller submits KYC documents for review
router.post('/seller-docs', auth(true), async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ message: 'Not authenticated' });
    if (user.role !== 'seller') return res.status(403).json({ message: 'Only seller accounts can submit documents' });
    const { panCard, aadhaarFront, aadhaarBack, gstCertificate, bankProof, shopPhoto } = req.body;
    if (!panCard || !aadhaarFront || !aadhaarBack || !bankProof) {
      return res.status(400).json({ message: 'PAN card, Aadhaar (front & back) and bank proof are required' });
    }
    user.sellerDocs = {
      panCard, aadhaarFront, aadhaarBack,
      gstCertificate: gstCertificate || '',
      bankProof,
      shopPhoto: shopPhoto || '',
      submittedAt: new Date(),
    };
    user.sellerDocsStatus = 'pending';
    user.sellerDocsRejectReason = '';
    await user.save();
    res.json({ success: true, status: 'pending' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/auth/seller-docs — seller checks their own submission status
router.get('/seller-docs', auth(true), async (req, res) => {
  const user = await User.findById(req.userId);
  res.json({
    status: user.sellerDocsStatus,
    rejectReason: user.sellerDocsRejectReason,
    submittedAt: user.sellerDocs?.submittedAt || null,
    sellerApproved: user.sellerApproved,
  });
});

// GET /api/auth/referral — my referral code, how many people I've referred, total earned
router.get('/referral', auth(true), async (req, res) => {
  const user = await User.findById(req.userId);
  const referredUsers = await User.find({ referredBy: user._id }).select('name createdAt referralRewardGiven');
  const successfulReferrals = referredUsers.filter(u => u.referralRewardGiven).length;
  const Settings = require('../models/Settings');
  const settings = await Settings.get();
  res.json({
    referralCode: user.referralCode,
    rewardAmount: settings.referralRewardAmount || 50,
    totalReferred: referredUsers.length,
    successfulReferrals,
    totalEarned: successfulReferrals * (settings.referralRewardAmount || 50),
    referredUsers: referredUsers.map(u => ({ name: u.name, joinedAt: u.createdAt, rewarded: u.referralRewardGiven })),
  });
});

// PATCH /api/auth/profile — update own name/phone
router.patch('/profile', auth(true), async (req, res) => {
  const { name, phone } = req.body;
  const user = await User.findById(req.userId);
  if (name) user.name = name;
  if (phone !== undefined) user.phone = phone;
  await user.save();
  res.json({ user: user.toSafeJSON() });
});
