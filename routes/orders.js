const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');
const { sendLater, templates, notifyOrderStatus } = require('../utils/mailer');
const { notifyLater } = require('../utils/notify');
const { generateInvoicePdf, invoiceNumber } = require('../utils/invoicePdf');
const { applyCommission } = require('../utils/commission');
const { effectivePrice } = require('../utils/pricing');
const { checkPincode } = require('../utils/pincode');
const Settings = require('../models/Settings');

const router = express.Router();

// The site has several separate sign-in paths (email+OTP, email+password,
// Google, Facebook, X, phone+OTP) that each look a customer up by a
// different field, so the same person can end up with more than one
// account if they signed in differently on different visits — and since
// every order is tied to a single account id, their order history would
// otherwise silently split between accounts. Instead of requiring an admin
// to manually merge duplicates, every order lookup below first resolves
// ALL accounts that share the current user's phone number (the one field
// that's genuinely tied to the person rather than to a particular login
// method) and includes orders from every one of them automatically — so a
// customer sees their full order history no matter which of their
// duplicate accounts they happen to be logged into.
async function getLinkedUserIds(userId) {
  const me = await User.findById(userId).select('phone');
  const ids = [userId];
  if (me?.phone) {
    const siblings = await User.find({ phone: me.phone, _id: { $ne: userId } }).select('_id');
    ids.push(...siblings.map((u) => u._id));
  }
  return ids;
}

// POST /api/orders/razorpay/callback — Razorpay posts here (not JSON, form-
// encoded, and with NO auth header we control) after a redirect-mode
// checkout finishes. This has to sit BEFORE router.use(auth(true)) below,
// since Razorpay's own redirect can't carry our Bearer token.
//
// Why redirect mode at all: the normal in-page "handler" callback depends on
// this tab's JS still being alive when the customer returns from their UPI
// app (GPay/PhonePe/etc). On many Android phones, backgrounding the tab to
// pay in another app gets the tab's renderer killed by the OS for memory —
// so when they come back, the JS callback never fires and they see a dead/
// crashed page instead of their order confirmation. Redirect mode has
// Razorpay itself navigate the browser back to a real URL once payment is
// done, which survives that kind of background-process kill far better than
// waiting on an in-memory JS Promise.
router.post('/razorpay/callback', express.urlencoded({ extended: true }), (req, res) => {
  const frontendUrl = process.env.CLIENT_ORIGIN?.split(',')[0] || 'http://localhost:5173';
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, error } = req.body;
  if (error) {
    return res.redirect(`${frontendUrl}/checkout?payment_error=${encodeURIComponent('Payment failed or was cancelled')}`);
  }
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.redirect(`${frontendUrl}/checkout?payment_error=${encodeURIComponent('Payment response was incomplete')}`);
  }
  // Signature verification itself happens in POST /api/orders below, right
  // before the order is created — this route's only job is getting these
  // three values back to the SPA as a real URL the browser can reload.
  const qs = new URLSearchParams({ razorpay_payment_id, razorpay_order_id, razorpay_signature }).toString();
  res.redirect(`${frontendUrl}/checkout?${qs}`);
});

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
    const myTotal = myItems.reduce((sum, i) => sum + i.basePrice * i.qty, 0);
    sendLater({ to: seller.email, ...templates.sellerNewOrder(order, seller, myItems, myTotal) });
    notifyLater(seller._id, { title: '🛒 New order received!', body: `Order #${String(order._id).slice(-6).toUpperCase()} • ₹${myTotal} — open your dashboard to confirm it.`, url: '/seller', tag: `seller-order-${order._id}`, type: 'order' });
  }
}

// POST /api/orders  { address, paymentMethod }
// Builds the order from the user's current server-side cart, then clears the cart.
// Works out the cart total on the SERVER (never trusting a number sent by the
// phone). Used both when opening the Razorpay/Cashfree payment window and when
// placing the order, so the two always agree.
async function computeCheckout(user, couponCode, userId) {
  const cartObj = Object.fromEntries(user.cart || []);
  const keys = Object.keys(cartObj);
  if (keys.length === 0) return { error: 'Your cart is empty' };

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
  const qtyByProduct = new Map();
  for (const p of parsed) {
    const product = productMap.get(p.productId);
    if (!product || product.active === false) continue;
    qtyByProduct.set(product.id, (qtyByProduct.get(product.id) || 0) + p.qty);
    const salePrice = effectivePrice(product);
    let price = salePrice;
    let reseller = null;
    if (p.resellerId) {
      const listing = listingMap.get(`${p.resellerId}:${p.productId}`);
      if (!listing) return { error: `A reseller listing in your cart is no longer available (${product.name})` };
      price = listing.resellPrice;
      reseller = p.resellerId;
    }
    items.push({
      productId: product.id, name: product.name, icon: product.icon, image: product.image,
      price, basePrice: salePrice, qty: p.qty, seller: product.seller || null, reseller,
    });
  }
  if (items.length === 0) return { error: 'Your cart is empty' };

  // Don't sell more than is in stock
  for (const [pid, qty] of qtyByProduct) {
    const product = productMap.get(pid);
    if (product.stock != null && qty > product.stock) {
      return { error: product.stock <= 0 ? `"${product.name}" just went out of stock. Please remove it from your cart.` : `Only ${product.stock} left of "${product.name}". Please reduce the quantity in your cart.` };
    }
  }

  const itemsTotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const deliveryFee = itemsTotal >= 499 ? 0 : 49;

  // Coupon — re-checked here, never trusting the earlier /validate-coupon preview
  let discount = 0;
  let coupon = null;
  if (couponCode) {
    const settings = await Settings.get();
    const c = settings.coupons.find((x) => x.code.toUpperCase() === String(couponCode).toUpperCase());
    if (c && c.active !== false && (c.uses || 0) < c.maxUses &&
        (!c.userId || String(c.userId) === String(userId)) && // personal (Spin & Win) codes: owner only
        (!c.expiresAt || new Date(c.expiresAt) >= new Date()) &&
        (!c.minOrderValue || itemsTotal >= c.minOrderValue)) {
      discount = Math.floor((itemsTotal * c.discountPercent) / 100);
      coupon = c;
    }
  }

  return { items, itemsTotal, deliveryFee, discount, coupon, total: itemsTotal + deliveryFee - discount };
}

// Count one use of a coupon — only called once the order is really saved.
async function useCoupon(code) {
  if (!code) return;
  const settings = await Settings.get();
  const c = settings.coupons.find((x) => x.code === code);
  if (!c) return;
  c.uses = (c.uses || 0) + 1;
  settings.markModified('coupons'); // coupons is a plain array — Mongoose must be told it changed
  await settings.save();
}

const gatewayFail = (paymentId) => `We received your payment but couldn't match it to your cart. Please contact support with payment ID ${paymentId} — you'll get a full refund or your order will be placed.`;

router.post('/', async (req, res) => {
  try {
    const { address, paymentMethod, couponCode, razorpayOrderId, razorpayPaymentId, razorpaySignature, cashfreeOrderId } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ message: 'Please log in again' });

    if (!address?.fullName || !address?.phone || !address?.addressLine || !address?.city || !address?.pincode) {
      return res.status(400).json({ message: 'Please fill in your full delivery address' });
    }

    const calc = await computeCheckout(user, couponCode, req.userId);
    if (calc.error) return res.status(400).json({ message: calc.error });
    const { items, itemsTotal, deliveryFee, discount, total } = calc;
    const appliedCouponCode = calc.coupon ? calc.coupon.code : '';

    // Payment:
    // - COD is collected later at delivery.
    // - RAZORPAY/CASHFREE: the payment is checked directly with the gateway —
    //   signature, that it really succeeded, that it belongs to this customer,
    //   and that the AMOUNT PAID equals this cart's total.
    // - Anything else is refused.
    const method = paymentMethod || 'COD';
    let paymentStatus = 'pending';
    let transactionId = '';

    // Delivery area + Cash-on-Delivery rules set by the admin
    const pinRule = checkPincode(await Settings.get(), address.pincode, 5);
    if (pinRule.valid && !pinRule.deliverable) {
      return res.status(400).json({ message: `Sorry, we don't deliver to pincode ${address.pincode} yet.` });
    }
    if (method === 'COD' && pinRule.valid && !pinRule.cod) {
      return res.status(400).json({ message: `Cash on Delivery isn't available for pincode ${address.pincode}. Please pay online.` });
    }

    if (!['COD', 'RAZORPAY', 'CASHFREE'].includes(method)) {
      return res.status(400).json({ message: 'Please pay with UPI/Card through the payment window, or choose Cash on Delivery.' });
    }

    if (method === 'RAZORPAY') {
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({ message: 'Payment was not completed. Please try again.' });
      }
      const SiteContent = require('../models/SiteContent');
      const crypto = require('crypto');
      const content = await SiteContent.get();
      const expectedSign = crypto.createHmac('sha256', content.razorpayKeySecret || '')
        .update(razorpayOrderId + '|' + razorpayPaymentId)
        .digest('hex');
      const a = Buffer.from(expectedSign); const b = Buffer.from(String(razorpaySignature));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ message: 'Payment verification failed. Please contact support before retrying.' });
      }
      // Stop one real payment being reused to mark many orders as paid
      if (await Order.exists({ transactionId: razorpayPaymentId })) {
        return res.status(400).json({ message: 'This payment has already been used for another order.' });
      }
      // Ask Razorpay what was actually paid
      const authHeader = 'Basic ' + Buffer.from(`${content.razorpayKeyId}:${content.razorpayKeySecret}`).toString('base64');
      let payment, rzOrder;
      try {
        const [pr, or] = await Promise.all([
          fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, { headers: { Authorization: authHeader } }),
          fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpayOrderId)}`, { headers: { Authorization: authHeader } }),
        ]);
        payment = await pr.json(); rzOrder = await or.json();
        if (!pr.ok || !or.ok) throw new Error('lookup failed');
      } catch {
        return res.status(502).json({ message: `Couldn't confirm your payment with Razorpay right now. Please contact support with payment ID ${razorpayPaymentId}.` });
      }
      const expectedPaise = Math.round(total * 100);
      const ok = payment.order_id === razorpayOrderId &&
        ['captured', 'authorized'].includes(payment.status) &&
        Number(payment.amount) === expectedPaise &&
        (!rzOrder.notes?.userId || String(rzOrder.notes.userId) === String(req.userId));
      if (!ok) {
        console.error(`[PAYMENT MISMATCH] razorpay ${razorpayPaymentId}: paid ${payment.amount} status ${payment.status}, cart ${expectedPaise}, user ${req.userId}`);
        return res.status(400).json({ message: gatewayFail(razorpayPaymentId) });
      }
      paymentStatus = 'paid';
      transactionId = razorpayPaymentId;
    }

    if (method === 'CASHFREE') {
      if (!cashfreeOrderId) return res.status(400).json({ message: 'Payment was not completed. Please try again.' });
      const SiteContent = require('../models/SiteContent');
      const content = await SiteContent.get();
      const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
      const headers = { 'x-api-version': '2023-08-01', 'x-client-id': content.cashfreeAppId, 'x-client-secret': content.cashfreeSecretKey };
      let cfOrder, payments;
      try {
        const [o, p] = await Promise.all([
          fetch(`${base}/orders/${encodeURIComponent(cashfreeOrderId)}`, { headers }),
          fetch(`${base}/orders/${encodeURIComponent(cashfreeOrderId)}/payments`, { headers }),
        ]);
        cfOrder = await o.json(); payments = await p.json();
        if (!o.ok) throw new Error('lookup failed');
      } catch {
        return res.status(502).json({ message: `Couldn't confirm your payment with Cashfree right now. Please contact support with order ID ${cashfreeOrderId}.` });
      }
      const successPayment = Array.isArray(payments) ? payments.find((x) => x.payment_status === 'SUCCESS') : null;
      if (!successPayment || cfOrder.order_status !== 'PAID') {
        return res.status(400).json({ message: 'Payment not confirmed by Cashfree yet. Please contact support before retrying.' });
      }
      if (await Order.exists({ transactionId: String(successPayment.cf_payment_id) })) {
        return res.status(400).json({ message: 'This payment has already been used for another order.' });
      }
      const ok = Math.round(Number(cfOrder.order_amount) * 100) === Math.round(total * 100) &&
        String(cfOrder.customer_details?.customer_id) === String(req.userId);
      if (!ok) {
        console.error(`[PAYMENT MISMATCH] cashfree ${cashfreeOrderId}: paid ${cfOrder.order_amount}, cart ${total}, user ${req.userId}`);
        return res.status(400).json({ message: gatewayFail(successPayment.cf_payment_id) });
      }
      paymentStatus = 'paid';
      transactionId = String(successPayment.cf_payment_id);
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
      gatewayOrderId: method === 'RAZORPAY' ? razorpayOrderId : method === 'CASHFREE' ? cashfreeOrderId : '',
    });

    // Step 7 — Commission: online payments are captured immediately, so the
    // platform/supplier split happens right away too.
    if (paymentStatus === 'paid') {
      await applyCommission(order);
    }

    await order.save();

    await useCoupon(appliedCouponCode);

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
    // Customer's own order-confirmation email (from the no-reply address)
    // …with the PDF invoice attached
    Settings.get().then((st) => {
      let attachments = [];
      try { attachments = [{ filename: `Invoice-${invoiceNumber(order)}.pdf`, content: generateInvoicePdf(order, st) }]; }
      catch (e) { console.error('Invoice PDF failed:', e.message); }
      sendLater({ to: user.email, ...templates.orderPlaced(order, user), attachments });
    }).catch(() => sendLater({ to: user.email, ...templates.orderPlaced(order, user) }));

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to place order', error: err.message });
  }
});

// GET /api/orders  -- current user's order history (includes any other
// account of theirs that shares the same phone number, so old orders don't
// appear to "vanish" just because they're logged into a different account)
router.get('/', async (req, res) => {
  const userIds = await getLinkedUserIds(req.userId);
  const orders = await Order.find({ user: { $in: userIds } }).sort({ createdAt: -1 });
  res.json(orders);
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  const userIds = await getLinkedUserIds(req.userId);
  const order = await Order.findOne({ _id: req.params.id, user: { $in: userIds } });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json(order);
});

// POST /api/orders/:id/return — customer requests a return
router.post('/:id/return', async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ message: 'Please tell us why you want to return this order' });
  const userIds = await getLinkedUserIds(req.userId);
  const order = await Order.findOne({ _id: req.params.id, user: { $in: userIds } });
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
  notifyOrderStatus(order, 'return_requested');
  res.json(order);
});

// POST /api/orders/:id/cancel — customer cancels an order before it ships
router.post('/:id/cancel', async (req, res) => {
  try {
    const userIds = await getLinkedUserIds(req.userId);
    const order = await Order.findOne({ _id: req.params.id, user: { $in: userIds } });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Only a still-pending order (not yet confirmed by the seller) can be
    // cancelled by the customer. Once the seller has confirmed or packed it,
    // they've already started fulfilling it, so cancellation is closed —
    // the customer can still request a return once it's delivered.
    const cancellableStatuses = ['placed'];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ message: 'This order has already been confirmed and can no longer be cancelled. You can request a return once delivered instead.' });
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
    notifyOrderStatus(order, 'cancelled');
    // Cancel any courier booking so no pickup happens
    for (const sh of order.shipments || []) {
      if (sh.srOrderId) require('../utils/shiprocket').cancelShiprocketOrder(sh.srOrderId).catch((e) => console.error('Courier cancel failed:', e.message));
    }
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
    if (coupon.userId && String(coupon.userId) !== String(req.userId)) return res.status(404).json({ message: 'Invalid coupon code' });
    if (coupon.active === false) return res.status(400).json({ message: 'This coupon is no longer active' });
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
    // Amount is worked out here from the customer's cart — never taken from the phone
    const buyer = await User.findById(req.userId);
    const calc = await computeCheckout(buyer, req.body.couponCode, req.userId);
    if (calc.error) return res.status(400).json({ message: calc.error });
    const authHeader = 'Basic ' + Buffer.from(`${content.razorpayKeyId}:${content.razorpayKeySecret}`).toString('base64');
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(calc.total * 100), currency: 'INR', receipt: `sb_${String(req.userId).slice(-6)}_${Date.now()}`,
        notes: { userId: String(req.userId), coupon: calc.coupon?.code || '' },
      }),
    });
    const order = await rzpRes.json();
    if (!rzpRes.ok) return res.status(400).json({ message: order?.error?.description || 'Razorpay order creation failed' });
    res.json({ orderId: order.id, keyId: content.razorpayKeyId, amount: calc.total });
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
    const calc = await computeCheckout(buyer, req.body.couponCode, req.userId);
    if (calc.error) return res.status(400).json({ message: calc.error });
    const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
    const orderId = `cf_${String(req.userId).slice(-6)}_${Date.now()}`;
    const frontendUrl = process.env.CLIENT_ORIGIN?.split(',')[0] || 'http://localhost:5173';
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
        order_amount: calc.total,
        order_currency: 'INR',
        customer_details: {
          customer_id: String(buyer._id),
          customer_name: buyer.name,
          customer_email: buyer.email,
          customer_phone: (String(buyer.phone || '').replace(/\D/g, '').slice(-10)) || '9999999999',
        },
        // Same reasoning as the Razorpay redirect fix: UPI intent payments
        // background this tab to open GPay/PhonePe/etc, and Android often
        // kills a backgrounded tab's JS — losing an in-page callback and
        // leaving a crashed/blank page. return_url makes Cashfree itself
        // navigate the browser to a real URL once payment finishes, which
        // survives that kind of background kill far better.
        order_meta: { return_url: `${frontendUrl}/checkout?cashfree_order_id={order_id}` },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Cashfree order creation failed');
    res.json({ orderId, paymentSessionId: data.payment_session_id, liveMode: content.cashfreeLiveMode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/orders/:id/invoice.pdf — download the PDF invoice (the customer,
// the order's sellers, or an admin)
router.get('/:id/invoice.pdf', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const me = await User.findById(req.userId).select('role');
    const isOwner = String(order.user) === String(req.userId);
    const isSeller = order.items.some((i) => i.seller && String(i.seller) === String(req.userId));
    if (!isOwner && !isSeller && me?.role !== 'admin') return res.status(403).json({ message: 'Not allowed' });
    const pdf = generateInvoicePdf(order, await Settings.get());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoiceNumber(order)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
