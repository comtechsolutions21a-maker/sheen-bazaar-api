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
const walletRoutes = require('./routes/wallet');
const feedbackRoutes = require('./routes/feedback');

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
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/feedback', feedbackRoutes);

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
  app.listen(PORT, () => console.log(`Sheen Bazaar API running on port ${PORT}`));
});
