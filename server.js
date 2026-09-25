require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const productRoutes = require('./routes/products');
const authRoutes = require('./routes/auth');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const sellerRoutes = require('./routes/seller');
const resellerRoutes = require('./routes/reseller');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const feedbackRoutes = require('./routes/feedback');
const chatRoutes = require('./routes/chat');
const { startAbandonedCartJob } = require('./utils/abandonedCart');

const app = express();

// CORS — only allow requests from the configured frontend origin.
// In production, CLIENT_ORIGIN must be set to your Netlify URL.
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
const strictCors = cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin} is not in CLIENT_ORIGIN`));
  },
  credentials: true,
});
app.use((req, res, next) => {
  // Razorpay's redirect-mode callback is a real cross-site form POST from
  // Razorpay's own checkout domain, not a script-based fetch from some
  // unknown frontend — so it isn't something CORS is meant to gate, and the
  // browser never reads its response via JS anyway. The strict check above
  // was rejecting Razorpay's own payment confirmation outright (after the
  // customer had already paid), so this one path is exempt from it.
  if (req.path === '/api/orders/razorpay/callback') return next();
  return strictCors(req, res, next);
});

// Raised limit so sellers can upload product photos as base64 data URLs.
app.use(express.json({ limit: '8mb' }));

// Health-check — useful for Render's uptime monitor.
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ⚠️ TEMPORARY — one-time admin promotion route, since Render's free plan has
// no Shell access to run scripts/makeAdmin.js directly. Protected by a secret
// query param so it can't be triggered by anyone who doesn't know it.
// DELETE THIS ENTIRE BLOCK (and remove the import above it) once you've used
// it — it should never stay live on a production site.
const User = require('./models/User');
app.get('/api/one-time-make-admin', async (req, res) => {
  const { email, secret } = req.query;
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ message: 'Invalid secret' });
  if (!email) return res.status(400).json({ message: 'Provide ?email=youremail@example.com' });
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) return res.status(404).json({ message: `No account found with email: ${email}` });
  const previousRole = user.role;
  user.role = 'admin';
  await user.save();
  res.json({ success: true, message: `${user.email} promoted from "${previousRole}" to "admin". DELETE this route from server.js now.` });
});

app.use('/api/products', productRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/reseller', resellerRoutes);
// Public storefront config (site content, notifications, gateways, tax) must be
// mounted BEFORE the auth-walled admin router, since both share the /api/admin/public/*
// path prefix and Express matches routes in registration order.
app.use('/api/admin', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/chat', chatRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message || err);
  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    message: 'Something went wrong',
    ...(isDev && { error: err.message }),
  });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Sheen Bazaar API running on port ${PORT}`));
  startAbandonedCartJob();
});
