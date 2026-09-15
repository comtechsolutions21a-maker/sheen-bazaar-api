const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { chargeOnline } = require('../utils/payments');
const { applyCommission } = require('../utils/commission');
const Settings = require('../models/Settings');

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
    const { address, paymentMethod, couponCode, razorpayOrderId, razorpayPaymentId, razorpaySignature, cashfreeOrderId } = req.body;
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

    // Apply a coupon (if one was supplied and is still genuinely valid) —
    // re-checked here rather than trusting the earlier /validate-coupon call,
    // since that was only a preview and someone could otherwise place an
    // order with a stale or already-used-up code.
    let discount = 0;
    let appliedCouponCode = '';
    if (couponCode) {
      const settings = await Settings.get();
      const coupon = settings.coupons.find(c => c.code.toUpperCase() === String(couponCode).toUpperCase());
      if (coupon && coupon.active && coupon.uses < coupon.maxUses &&
          (!coupon.expiresAt || new Date(coupon.expiresAt) >= new Date()) &&
          (!coupon.minOrderValue || itemsTotal >= coupon.minOrderValue)) {
        discount = Math.floor((itemsTotal * coupon.discountPercent) / 100);
        appliedCouponCode = coupon.code;
        coupon.uses += 1;
        await settings.save();
      }
    }

    const total = itemsTotal + deliveryFee - discount;

    // Step 6 — Payment:
    // - COD is collected later at delivery.
    // - UPI/CARD here refers to the site's own simulated instant-charge path
    //   (utils/payments.chargeOnline), kept for any flow still using it.
    // - RAZORPAY/CASHFREE come from the real gateway popup on Checkout — the
    //   frontend already collected the payment signature, so we verify it
    //   here before ever marking the order paid. If verification fails or
    //   the signature is missing, the order is created as 'pending' instead
    //   of silently trusting the client.
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
    } else if (method === 'RAZORPAY' && razorpayOrderId && razorpayPaymentId && razorpaySignature) {
      const SiteContent = require('../models/SiteContent');
      const crypto = require('crypto');
      const content = await SiteContent.get();
      const expectedSign = crypto.createHmac('sha256', content.razorpayKeySecret)
        .update(razorpayOrderId + '|' + razorpayPaymentId)
        .digest('hex');
      if (expectedSign === razorpaySignature) {
        paymentStatus = 'paid';
        transactionId = razorpayPaymentId;
      } else {
        return res.status(400).json({ message: 'Payment verification failed. Please contact support before retrying.' });
      }
    } else if (method === 'CASHFREE' && cashfreeOrderId) {
      const SiteContent = require('../models/SiteContent');
      const content = await SiteContent.get();
      const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
      try {
        const cfRes = await fetch(`${base}/orders/${cashfreeOrderId}/payments`, {
          headers: {
            'x-api-version': '2023-08-01',
            'x-client-id': content.cashfreeAppId,
            'x-client-secret': content.cashfreeSecretKey,
          },
        });
        const payments = await cfRes.json();
        const successPayment = Array.isArray(payments) ? payments.find(p => p.payment_status === 'SUCCESS') : null;
        if (successPayment) {
          paymentStatus = 'paid';
          transactionId = successPayment.cf_payment_id;
        } else {
          return res.status(400).json({ message: 'Payment not confirmed by Cashfree yet. Please contact support before retrying.' });
        }
      } catch (cfErr) {
        return res.status(400).json({ message: 'Could not verify Cashfree payment. Please contact support before retrying.' });
      }
    }

    const order = new Order({
      user: user._id,
      items,
      itemsTotal,
      deliveryFee,
      discount,
      couponCode: appliedCouponCode,
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

    // Decrement stock now that the order is genuinely placed. Mirrors the
    // restock done on cancellation (POST /:id/cancel below) — without this,
    // stock counts never reflected real sales and products could be oversold.
    for (const item of items) {
      await Product.findOneAndUpdate({ id: item.productId }, { $inc: { stock: -item.qty } });
    }

    // Refer & Earn: mark this user's first paid order so admins can see who's
    // eligible for a referral reward and follow up (there's no in-app wallet
    // to auto-credit anymore — see /admin/users for referral stats).
    if (paymentStatus === 'paid' && user.referredBy && !user.referralRewardGiven) {
      user.referralRewardGiven = true;
    }

    user.cart = new Map();
    user.cartUpdatedAt = null;
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

// POST /api/orders/:id/return — customer requests a return
router.post('/:id/return', async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ message: 'Please tell us why you want to return this order' });
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.status !== 'delivered') return res.status(400).json({ message: 'Only delivered orders can be returned' });
  if (order.returnStatus !== 'none') return res.status(400).json({ message: 'A return has already been requested for this order' });

  order.returnRequested = true;
  order.returnReason = reason;
  order.returnStatus = 'requested';
  order.returnRequestedAt = new Date();
  order.status = 'return_requested';
  order.statusHistory.push({ status: 'return_requested', note: `Customer requested return: ${reason}`, updatedBy: 'customer' });
  await order.save();
  res.json(order);
});

// POST /api/orders/:id/cancel — customer cancels an order before it ships
router.post('/:id/cancel', async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.userId });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const cancellableStatuses = ['placed', 'confirmed', 'packed'];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ message: 'This order can no longer be cancelled — it has already shipped. You can request a return once delivered instead.' });
    }

    order.status = 'cancelled';
    order.statusHistory.push({ status: 'cancelled', note: req.body.reason || 'Cancelled by customer', updatedBy: 'customer' });

    // Restock items
    for (const item of order.items) {
      await Product.findOneAndUpdate({ id: item.productId }, { $inc: { stock: item.qty } });
    }

    // Refund if already paid — straight back to the original payment method
    // (card/UPI/bank), via the gateway that captured it.
    if (order.paymentStatus === 'paid') {
      const { refundOrderPayment } = require('../utils/refunds');
      const result = await refundOrderPayment(order);
      if (result.success) {
        order.paymentStatus = 'refunded';
        order.refund = { method: 'original_payment', amount: order.total, processedAt: new Date() };
      } else {
        // Cancellation still goes through; refund needs a manual follow-up.
        order.refund = { method: 'manual', amount: order.total, note: result.message, processedAt: null };
      }
    }

    await order.save();
    res.json(order);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── SAVED ADDRESSES ───
// GET /api/orders/addresses/mine — list saved addresses
router.get('/addresses/mine', async (req, res) => {
  const user = await User.findById(req.userId).select('addresses');
  res.json(user.addresses || []);
});

// POST /api/orders/addresses/mine — add a new saved address
router.post('/addresses/mine', async (req, res) => {
  const { label, fullName, phone, addressLine, city, state, pincode, isDefault } = req.body;
  if (!fullName || !phone || !addressLine || !city || !pincode) {
    return res.status(400).json({ message: 'Full name, phone, address, city and pincode are required' });
  }
  const user = await User.findById(req.userId);
  if (isDefault) user.addresses.forEach(a => { a.isDefault = false; });
  user.addresses.push({ label: label || 'Home', fullName, phone, addressLine, city, state: state || '', pincode, isDefault: !!isDefault || user.addresses.length === 0 });
  await user.save();
  res.status(201).json(user.addresses);
});

// PATCH /api/orders/addresses/mine/:addrId — edit a saved address
router.patch('/addresses/mine/:addrId', async (req, res) => {
  const user = await User.findById(req.userId);
  const addr = user.addresses.id(req.params.addrId);
  if (!addr) return res.status(404).json({ message: 'Address not found' });
  const allowed = ['label', 'fullName', 'phone', 'addressLine', 'city', 'state', 'pincode'];
  allowed.forEach(k => { if (req.body[k] !== undefined) addr[k] = req.body[k]; });
  if (req.body.isDefault) { user.addresses.forEach(a => { a.isDefault = false; }); addr.isDefault = true; }
  await user.save();
  res.json(user.addresses);
});

// DELETE /api/orders/addresses/mine/:addrId — remove a saved address
router.delete('/addresses/mine/:addrId', async (req, res) => {
  const user = await User.findById(req.userId);
  user.addresses.id(req.params.addrId).deleteOne();
  await user.save();
  res.json(user.addresses);
});


// POST /api/orders/validate-coupon — check a coupon code before checkout,
// without consuming a use yet (that happens when the order is actually
// placed with couponCode set). Mirrors the coupon shape admin.js writes to
// Settings.coupons: { code, discountPercent, maxUses, uses, expiresAt, minOrderValue, active }.
router.post('/validate-coupon', async (req, res) => {
  try {
    const { code, orderTotal } = req.body;
    if (!code) return res.status(400).json({ message: 'Coupon code is required' });

    const settings = await Settings.get();
    const coupon = settings.coupons.find(c => c.code.toUpperCase() === String(code).toUpperCase());

    if (!coupon) return res.status(404).json({ message: 'Invalid coupon code' });
    if (!coupon.active) return res.status(400).json({ message: 'This coupon is no longer active' });
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      return res.status(400).json({ message: 'This coupon has expired' });
    }
    if (coupon.uses >= coupon.maxUses) {
      return res.status(400).json({ message: 'This coupon has reached its usage limit' });
    }
    if (coupon.minOrderValue && Number(orderTotal) < coupon.minOrderValue) {
      return res.status(400).json({ message: `This coupon requires a minimum order of ₹${coupon.minOrderValue}` });
    }

    res.json({
      coupon: {
        code: coupon.code,
        discountPercent: coupon.discountPercent,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/orders/razorpay/create-order — any logged-in customer can create
// a Razorpay order to pay for their cart. (Previously this lived under
// /api/admin/razorpay/create-order, which meant only admin accounts could
// use it — every customer checkout with Razorpay was failing with a 403.)
router.post('/razorpay/create-order', async (req, res) => {
  try {
    const SiteContent = require('../models/SiteContent');
    const content = await SiteContent.get();
    if (!content.razorpayKeyId || !content.razorpayKeySecret) {
      return res.status(400).json({ message: 'Razorpay is not configured. Add keys in Admin → Settings → Payments.' });
    }
    const authHeader = 'Basic ' + Buffer.from(`${content.razorpayKeyId}:${content.razorpayKeySecret}`).toString('base64');
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(req.body.amount * 100), currency: 'INR', receipt: `receipt_${Date.now()}` }),
    });
    const order = await rzpRes.json();
    if (!rzpRes.ok) return res.status(400).json({ message: order?.error?.description || 'Razorpay order creation failed' });
    res.json({ orderId: order.id, keyId: content.razorpayKeyId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/orders/cashfree/create-order — same fix as above, for Cashfree.
router.post('/cashfree/create-order', async (req, res) => {
  try {
    const SiteContent = require('../models/SiteContent');
    const content = await SiteContent.get();
    if (!content.cashfreeAppId || !content.cashfreeSecretKey) {
      return res.status(400).json({ message: 'Cashfree is not configured. Add keys in Admin → Settings → Payments.' });
    }
    const buyer = await User.findById(req.userId);
    const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
    const orderId = `cf_${Date.now()}`;
    const response = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': content.cashfreeAppId,
        'x-client-secret': content.cashfreeSecretKey,
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: req.body.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: String(buyer._id),
          customer_name: buyer.name,
          customer_email: buyer.email,
          customer_phone: buyer.phone || '9999999999',
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Cashfree order creation failed');
    res.json({ orderId, paymentSessionId: data.payment_session_id, liveMode: content.cashfreeLiveMode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
