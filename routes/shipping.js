// Courier (Shiprocket) routes
const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Order = require('../models/Order');
const SiteContent = require('../models/SiteContent');
const sr = require('../utils/shiprocket');
const { advanceOrder } = require('../utils/orderFlow');

const router = express.Router();

const sellerOnly = async (req, res, next) => {
  const u = await User.findById(req.userId);
  if (!u || !['seller', 'admin'].includes(u.role)) return res.status(403).json({ message: 'Sellers only' });
  req.user = u; next();
};
const adminOnly = async (req, res, next) => {
  const u = await User.findById(req.userId).select('role');
  if (u?.role !== 'admin') return res.status(403).json({ message: 'Admins only' });
  next();
};

// Applies tracking info to an order's shipment; moves the order along
async function applyTracking(order, shipment, { status, events, etd }) {
  if (events?.length) {
    const key = (e) => `${e.at}|${e.activity}`;
    const known = new Set((shipment.events || []).map(key));
    for (const e of events) if (!known.has(key(e))) shipment.events.push(e);
    shipment.events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (shipment.events.length > 60) shipment.events = shipment.events.slice(0, 60);
  }
  if (status) shipment.status = status;
  if (etd) { const d = new Date(String(etd).replace(' ', 'T')); if (!Number.isNaN(d.getTime())) { shipment.etd = d; order.shipping.estimatedDelivery = d; } }
  shipment.updatedAt = new Date();
  order.markModified('shipments');
  const next = sr.mapStatus(status);
  const moved = next ? await advanceOrder(order, next, `${shipment.courierName || 'Courier'}: ${status}`, 'courier') : false;
  if (!moved) await order.save();
}

// ── Public flag: is Shiprocket switched on? (seller UI shows the button) ──
router.get('/enabled', async (req, res) => res.json({ shiprocket: await sr.isEnabled() }));

// ── Seller: pickup address ──
router.get('/pickup-address', auth(true), sellerOnly, (req, res) => res.json(req.user.pickupAddress || {}));
router.put('/pickup-address', auth(true), sellerOnly, async (req, res) => {
  const b = req.body || {};
  const a = {
    name: String(b.name || '').trim().slice(0, 60), phone: String(b.phone || '').replace(/\D/g, '').slice(-10),
    addressLine: String(b.addressLine || '').trim().slice(0, 200), landmark: String(b.landmark || '').trim().slice(0, 100),
    city: String(b.city || '').trim().slice(0, 60), state: String(b.state || '').trim().slice(0, 60), pincode: String(b.pincode || '').replace(/\D/g, '').slice(0, 6),
  };
  if (!a.addressLine || !a.city || !/^[1-9]\d{5}$/.test(a.pincode) || a.phone.length !== 10) {
    return res.status(400).json({ message: 'Please fill address, city, a 6-digit pincode and a 10-digit phone number.' });
  }
  const changed = JSON.stringify(a) !== JSON.stringify(req.user.pickupAddress || {});
  req.user.pickupAddress = a;
  if (changed) req.user.shiprocketPickup = ''; // new address → saved again in Shiprocket on next booking
  await req.user.save();
  res.json(a);
});

// ── Seller: book courier for an order (one click) ──
// POST /api/shipping/orders/:id/book { weightKg?, length?, breadth?, height? }
router.post('/orders/:id/book', auth(true), sellerOnly, async (req, res) => {
  if (!(await sr.isEnabled())) return res.status(400).json({ message: 'Automatic courier is not switched on. Ask the admin to set up Shiprocket.' });
  const order = await Order.findOne({ _id: req.params.id, 'items.seller': req.user._id });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (['cancelled', 'returned', 'delivered', 'return_requested'].includes(order.status)) return res.status(400).json({ message: `This order is ${order.status.replace('_', ' ')} — it can't be shipped.` });
  const existing = (order.shipments || []).find((s) => String(s.seller) === String(req.user._id) && s.awb);
  if (existing) return res.status(400).json({ message: `Courier already booked: ${existing.courierName} (AWB ${existing.awb}).` });

  let shipment;
  try { shipment = await sr.createShipment(order, req.user, req.body || {}); }
  catch (err) { return res.status(400).json({ message: err.message }); }

  order.shipments = (order.shipments || []).filter((s) => String(s.seller) !== String(req.user._id));
  order.shipments.push(shipment);
  if (shipment.awb) {
    order.shipping = { ...(order.shipping?.toObject?.() || order.shipping || {}), method: 'courier_pickup', courierPartner: shipment.courierName || 'Courier', trackingNumber: shipment.awb, trackingUrl: shipment.trackUrl, packedAt: new Date() };
    order.markModified('shipping');
    // Packed + pickup booked; it becomes "Shipped" when the courier scans it
    const moved = await advanceOrder(order, 'packed', `Courier booked: ${shipment.courierName} · AWB ${shipment.awb}`, 'seller');
    if (!moved) await order.save();
  } else {
    await order.save();
  }
  res.json({ shipment, order });
});

// ── Seller: shipping label (PDF link) ──
router.get('/orders/:id/label', auth(true), sellerOnly, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, 'items.seller': req.user._id });
  const sh = order?.shipments?.find((s) => String(s.seller) === String(req.user._id));
  if (!sh?.shipmentId) return res.status(404).json({ message: 'No courier booking for this order yet' });
  try {
    const url = await sr.getLabel(sh.shipmentId);
    if (url) { sh.labelUrl = url; order.markModified('shipments'); await order.save(); }
    res.json({ labelUrl: url || sh.labelUrl });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── Customer (or seller/admin): live tracking ──
router.get('/track/:orderId', auth(true), async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ message: 'Order not found' });
  const me = await User.findById(req.userId).select('role');
  const allowed = String(order.user) === String(req.userId) || me?.role === 'admin' || order.items.some((i) => String(i.seller) === String(req.userId));
  if (!allowed) return res.status(403).json({ message: 'Not allowed' });
  const list = (order.shipments || []).filter((s) => s.awb);
  // Refresh from the courier if the last update is older than 30 minutes
  for (const sh of list) {
    if (Date.now() - new Date(sh.updatedAt || 0).getTime() > 30 * 60e3 && !['DELIVERED', 'CANCELED'].includes(String(sh.status).toUpperCase())) {
      try { await applyTracking(order, sh, await sr.track(sh.awb)); } catch { /* show what we have */ }
    }
  }
  res.json({
    status: order.status,
    shipments: list.map((s) => ({ courierName: s.courierName, awb: s.awb, trackUrl: s.trackUrl, status: s.status, etd: s.etd, events: s.events })),
  });
});

// ── Courier tracking webhook (set in Shiprocket → Settings → API → Webhooks) ──
// Shiprocket sends the token we show in the admin panel in the "x-api-key" header.
router.post('/courier-updates', async (req, res) => {
  const content = await SiteContent.get();
  const token = String(req.headers['x-api-key'] || '');
  const expected = content.shiprocketWebhookToken || '';
  const a = Buffer.from(token); const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ message: 'Bad token' });
  res.json({ ok: true }); // answer fast; process after

  try {
    const p = req.body || {};
    const awb = String(p.awb || '');
    if (!awb) return;
    const order = await Order.findOne({ 'shipments.awb': awb });
    if (!order) return;
    const sh = order.shipments.find((s) => s.awb === awb);
    const events = (Array.isArray(p.scans) ? p.scans : []).map((x) => ({ at: x.date, status: x['sr-status-label'] || x.status || '', activity: x.activity || '', location: x.location || '' }));
    await applyTracking(order, sh, { status: p.current_status || p.shipment_status || '', events, etd: p.etd });
  } catch (err) { console.error('Courier webhook failed:', err.message); }
});

// ── Admin: test the connection ──
router.post('/admin/test', auth(true), adminOnly, async (req, res) => {
  try {
    await sr.login(true);
    const d = await sr.api('GET', '/settings/company/pickup');
    const locations = (d?.data?.shipping_address || []).map((x) => ({ name: x.pickup_location, city: x.city, pincode: x.pin_code, verified: x.phone_verified === 1 || x.status === 2 }));
    res.json({ ok: true, locations });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// Backup: check tracking every 30 minutes for shipments still on the way
function startTrackingJob() {
  const run = async () => {
    try {
      if (!(await sr.isEnabled())) return;
      const cutoff = new Date(Date.now() - 60 * 60e3);
      const orders = await Order.find({ status: { $in: ['packed', 'shipped', 'out_for_delivery'] }, 'shipments.awb': { $exists: true, $ne: '' } }).limit(40);
      for (const o of orders) {
        for (const sh of o.shipments) {
          if (!sh.awb || new Date(sh.updatedAt || 0) > cutoff) continue;
          try { await applyTracking(o, sh, await sr.track(sh.awb)); } catch { /* try next round */ }
        }
      }
    } catch (err) { console.error('Tracking job:', err.message); }
  };
  setInterval(run, 30 * 60e3);
  setTimeout(run, 60e3);
}

module.exports = router;
module.exports.startTrackingJob = startTrackingJob;
