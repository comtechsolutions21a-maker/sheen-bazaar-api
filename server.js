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
const walletRoutes = require('./routes/wallet');
const feedbackRoutes = require('./routes/feedback');
const chatRoutes = require('./routes/chat');

const app = express();

// CORS — only allow requests from the configured frontend origin.
// In production, CLIENT_ORIGIN must be set to your Netlify URL.
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin} is not in CLIENT_ORIGIN`));
  },
  credentials: true,
}));

// Raised limit so sellers can upload product photos as base64 data URLs.
app.use(express.json({ limit: '8mb' }));

// Health-check — useful for Render's uptime monitor.
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

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
app.use('/api/wallet', walletRoutes);
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

// Safety net: an uncaught error thrown inside an async route handler (e.g. a
// bug like req.user being undefined, or a bad value reaching a database
// query) does NOT get caught by the app.use((err, req, res, next) => ...)
// middleware above — Express only catches errors passed to next(err) or
// thrown synchronously. An uncaught exception in async code instead crashes
// the entire Node process, taking down every single request being served at
// that moment (this is exactly what was happening: one broken route was
// intermittently killing the whole server, which looked like random,
// unrelated features — including payments — failing).
//
// These two handlers log the real error for debugging but keep the process
// alive, so one bad request can no longer take the whole site down. Fixing
// the actual bugs (as done throughout routes/*.js) remains the real fix —
// this is a backstop for whatever slips through in the future.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] — server stayed alive, but this needs fixing:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] — server stayed alive, but this needs fixing:', reason);
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Sheen Bazaar API running on port ${PORT}`));
});
