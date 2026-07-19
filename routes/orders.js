const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { chargeOnline } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');

const router = express.Router();
router.use(auth(true));

// Notifies every seller who has at least one item in this order — via email,
// and implicitly via their seller dashboard (GET /api/seller/orders already
// includes it). Runs after the response is sent and never throws, so a slow
// or failing mail server can't hold up or break checkout.
async function notifySellers(order) {
  const sellerIds = [...new Set(order.items.filter((i) => i.seller).map((i) => String(i.seller)))];
  if (sellerIds.length === 0) return;

  const sellers = await User.find({ _id: { $in: sellerIds } });
  for (const seller of sellers) {
    const myItems = order.items.filter((i) => String(i.seller) === String(seller._id));
    const lines = myItems.map((i) => `  • ${i.name} × ${i.qty} — ₹${i.basePrice * i.qty}`).join('\n');
    const myTotal = myItems.reduce((sum, i) => sum + i.basePrice * i.qty, 0);

    sendMail({
      to: seller.email,
      subject: `New order #${String(order._id).slice(-6).toUpperCase()} on Sheen Bazaar`,
      text:
        `Hi ${seller.businessName || seller.name},\n\n` +
        `You've received a new order:\n\n${lines}\n\n` +
        `Your total: ₹${myTotal}\n\n` +
        `Log in to your seller dashboard to confirm and fulfill it.`,
    }).catch((err) => console.error('notifySellers failed:', err.message));
  }
}

// POST /api/orders  { address, paymentMethod }
// Builds the order from the user's current server-side cart, then clears the cart.
router.post('/', async (req, res) => {
  try {
    const { address, paymentMethod } = req.body;
    const user = await User.findById(req.userId);
    const cartObj = Object.fromEntries(user.cart || []);
    const keys = Object.keys(cartObj);

    if (keys.length === 0) return res.status(400).json({ message: 'Your cart is empty' });

    // Cart keys are "<productId>" or "<productId>:r:<resellerId>" — see routes/cart.js.
    const parsed = keys.map((k) => {
      const [productId, tag, resellerId] = k.split(':');
      return { productId: Number(productId), resellerId: tag === 'r' ? resellerId : null, qty: cartObj[k] };
    });

    const productIds = [...new Set(parsed.map((p) => p.productId))];
    const products = await Product.find({ id: { $in: productIds } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const resellerIds = [...new Set(parsed.filter((p) => p.resellerId).map((p) => p.resellerId))];
    const listings = resellerIds.length
      ? await ResellerListing.find({ reseller: { $in: resellerIds }, productId: { $in: productIds }, active: true })
      : [];
    const listingMap = new Map(listings.map((l) => [`${l.reseller}:${l.productId}`, l]));

    const items = [];
    for (const p of parsed) {
      const product = productMap.get(p.productId);
      if (!product) continue;
      let price = product.price;
      let reseller = null;
      if (p.resellerId) {
        const listing = listingMap.get(`${p.resellerId}:${p.productId}`);
        if (!listing) return res.status(400).json({ message: `A reseller listing in your cart is no longer available (${product.name})` });
        price = listing.resellPrice;
        reseller = p.resellerId;
      }
      items.push({
        productId: product.id,
        name: product.name,
        icon: product.icon,
        image: product.image,
        price,
        basePrice: product.price,
        qty: p.qty,
        seller: product.seller || null,
        reseller,
      });
    }

    if (items.length === 0) return res.status(400).json({ message: 'Your cart is empty' });

    const itemsTotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const deliveryFee = itemsTotal >= 499 ? 0 : 49;
    const total = itemsTotal + deliveryFee;

    // Step 6 — Payment: online methods are captured right away (money lands in
    // the business account immediately); COD is collected later at delivery.
    const method = paymentMethod || 'COD';
    let paymentStatus = 'pending';
    let transactionId = '';
    if (method === 'UPI' || method === 'CARD') {
      const charge = chargeOnline(method, total);
      if (!charge.success) {
        return res.status(402).json({ message: 'Payment failed. Please try again or choose Cash on Delivery.' });
      }
      paymentStatus = 'paid';
      transactionId = charge.transactionId;
    }

    const order = new Order({
      user: user._id,
      items,
      itemsTotal,
      deliveryFee,
      total,
      address,
      paymentMethod: method,
      paymentStatus,
      transactionId,
    });

    // Step 7 — Commission: online payments are captured immediately, so the
    // platform/supplier split happens right away too.
    if (paymentStatus === 'paid') {
      await applyCommission(order);
    }

    await order.save();

    user.cart = new Map();
    await user.save();

    // Fire-and-forget: don't make the customer wait on email delivery.
    notifySellers(order).catch((err) => console.error('notifySellers failed:', err.message));

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to place order', error: err.message });
  }
});

// GET /api/orders  -- current user's order history
router.get('/', async (req, res) => {
  const orders = await Order.find({ user: req.userId }).sort({ createdAt: -1 });
  res.json(orders);
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json(order);
});

module.exports = router;
