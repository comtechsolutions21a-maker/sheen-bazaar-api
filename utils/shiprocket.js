// ─────────────────────────────────────────────────────────────────────────────
// Shiprocket courier connection
// One click from the seller: create the shipment → assign a courier (AWB) →
// schedule pickup → get the shipping label. Tracking updates arrive by webhook
// (and a backup check every 30 minutes) and move the order along by itself.
// Credentials are an API user made in Shiprocket → Settings → API.
// ─────────────────────────────────────────────────────────────────────────────
const SiteContent = require('../models/SiteContent');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
let tokenCache = { token: '', email: '', at: 0 };

async function settings() {
  const c = await SiteContent.get();
  return {
    enabled: !!c.shiprocketEnabled,
    email: c.shiprocketEmail || '',
    password: c.shiprocketPassword || '',
    pickupLocation: c.shiprocketPickupLocation || '',
    weight: Number(c.shiprocketDefaultWeight) || 0.5,
    length: Number(c.shiprocketDefaultLength) || 15,
    breadth: Number(c.shiprocketDefaultBreadth) || 12,
    height: Number(c.shiprocketDefaultHeight) || 10,
    webhookToken: c.shiprocketWebhookToken || '',
  };
}

async function isEnabled() {
  const s = await settings();
  return !!(s.enabled && s.email && s.password);
}

async function login(force = false) {
  const s = await settings();
  if (!s.email || !s.password) throw new Error('Shiprocket is not set up. Add the API user email and password in Admin → Settings → Shiprocket.');
  // Shiprocket tokens last about 10 days; refresh after 8
  if (!force && tokenCache.token && tokenCache.email === s.email && Date.now() - tokenCache.at < 8 * 24 * 3600e3) return tokenCache.token;
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.email, password: s.password }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error(d.message || 'Shiprocket login failed — check the API user email and password.');
  tokenCache = { token: d.token, email: s.email, at: Date.now() };
  return d.token;
}

async function api(method, path, body, retried = false) {
  const token = await login();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (r.status === 401 && !retried) { await login(true); return api(method, path, body, true); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const details = d.errors ? Object.values(d.errors).flat().join(' ') : '';
      throw new Error(`${d.message || `Shiprocket error ${r.status}`}${details ? ` — ${details}` : ''}`);
    }
    return d;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Shiprocket took too long to answer. Please try again.');
    throw err;
  } finally { clearTimeout(timer); }
}

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// Each seller ships from their own address: saved once as a Shiprocket "pickup location"
async function ensurePickup(seller) {
  const s = await settings();
  if (seller.shiprocketPickup) return seller.shiprocketPickup;
  const a = seller.pickupAddress || {};
  if (!a.addressLine || !a.city || !a.pincode || !digits10(a.phone || seller.phone)) {
    if (s.pickupLocation) return s.pickupLocation; // fall back to the store's main pickup address
    throw new Error('Please add your pickup address first (where the courier collects parcels).');
  }
  const nickname = `SB-${String(seller._id).slice(-8)}`;
  try {
    await api('POST', '/settings/company/addpickup', {
      pickup_location: nickname,
      name: (a.name || seller.businessName || seller.name || 'Seller').slice(0, 50),
      email: seller.email && !/@(phone|twitter|x|facebook)\.sheenbazaar\.com$/i.test(seller.email) ? seller.email : (s.email || 'support@sheenbazaar.online'),
      phone: digits10(a.phone || seller.phone),
      address: a.addressLine.length >= 10 ? a.addressLine : `${a.addressLine}, ${a.city}`,
      address_2: a.landmark || '',
      city: a.city, state: a.state || '', country: 'India', pin_code: String(a.pincode),
    });
  } catch (err) {
    // Already added earlier (e.g. a previous attempt) → fine, use it
    if (!/already|exist/i.test(err.message)) {
      if (s.pickupLocation) return s.pickupLocation;
      throw err;
    }
  }
  seller.shiprocketPickup = nickname;
  await seller.save();
  return nickname;
}

// Total parcel weight for this seller's items (kg)
async function parcelWeight(order, seller, opts = {}) {
  const s = await settings();
  let weight = Number(opts.weightKg);
  if (!(weight > 0)) {
    const Product = require('../models/Product');
    const mine = order.items.filter((i) => String(i.seller) === String(seller._id));
    const prods = await Product.find({ id: { $in: mine.map((i) => i.productId) } }).select('id weightKg sku');
    const w = new Map(prods.map((p) => [p.id, p.weightKg || 0]));
    weight = mine.reduce((t, i) => t + (w.get(i.productId) || s.weight) * i.qty, 0);
  }
  return Math.max(0.1, Math.round(weight * 100) / 100);
}

// Where the parcel is picked up from (pincode), for price quotes
async function pickupPincode(seller) {
  // Seller's own saved address is what ensurePickup() books from
  if (seller.pickupAddress?.addressLine && seller.pickupAddress?.pincode) return String(seller.pickupAddress.pincode);
  const s = await settings();
  const d = await api('GET', '/settings/company/pickup');
  const list = d?.data?.shipping_address || [];
  const hit = list.find((x) => x.pickup_location === (seller.shiprocketPickup || s.pickupLocation)) || list[0];
  if (!hit?.pin_code) throw new Error('Please add your pickup address first (where the courier collects parcels).');
  return String(hit.pin_code);
}

// Couriers that can take this parcel, with price and delivery time
async function courierRates(order, seller, opts = {}) {
  const mine = order.items.filter((i) => String(i.seller) === String(seller._id));
  if (!mine.length) throw new Error('This order has no items from your shop');
  const sellersInOrder = new Set(order.items.map((i) => String(i.seller || '')));
  const value = sellersInOrder.size === 1 ? order.total : mine.reduce((t, i) => t + i.price * i.qty, 0);
  const cod = order.paymentStatus === 'paid' ? 0 : 1;
  const [from, weight] = await Promise.all([pickupPincode(seller), parcelWeight(order, seller, opts)]);
  const q = new URLSearchParams({ pickup_postcode: from, delivery_postcode: String(order.address?.pincode || ''), weight: String(weight), cod: String(cod), declared_value: String(Math.round(value)) });
  const d = await api('GET', `/courier/serviceability/?${q}`);
  const list = (d?.data?.available_courier_companies || []).map((c) => ({
    id: Number(c.courier_company_id),
    name: c.courier_name,
    price: Math.round(Number(c.rate ?? (Number(c.freight_charge || 0) + Number(c.cod_charges || 0))) * 100) / 100,
    days: Number(c.estimated_delivery_days) || null,
    etd: c.etd || '',
    rating: Number(c.rating) || null,
    mode: Number(c.is_surface) === 1 || c.is_surface === true ? 'Surface' : 'Air',
    cod: Number(c.cod) === 1,
  })).filter((c) => c.id && (!cod || c.cod));
  if (!list.length) throw new Error(`No courier delivers from ${from} to ${order.address?.pincode}${cod ? ' with Cash on Delivery' : ''} right now.`);
  list.sort((a, b) => a.price - b.price);
  const cheapest = list[0].id;
  const fastest = [...list].sort((a, b) => (a.days || 99) - (b.days || 99) || a.price - b.price)[0].id;
  const recommended = Number(d?.data?.recommended_courier_company_id) || null;
  return { from, to: String(order.address?.pincode || ''), weight, cod: !!cod, couriers: list.slice(0, 15), cheapest, fastest, recommended: list.some((c) => c.id === recommended) ? recommended : null };
}

const pad = (n) => String(n).padStart(2, '0');
const srDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Books the courier for this seller's items in the order.
// opts: { weightKg, length, breadth, height }
async function createShipment(order, seller, opts = {}) {
  const s = await settings();
  const mine = order.items.filter((i) => String(i.seller) === String(seller._id));
  if (!mine.length) throw new Error('This order has no items from your shop');
  const sellersInOrder = new Set(order.items.map((i) => String(i.seller || '')));
  const subTotal = sellersInOrder.size === 1 ? order.total : mine.reduce((t, i) => t + i.price * i.qty, 0);

  const weight = await parcelWeight(order, seller, opts);

  const pickup = await ensurePickup(seller);
  const a = order.address || {};
  const nameParts = String(a.fullName || 'Customer').trim().split(/\s+/);
  const ref = `SB${String(order._id).slice(-8).toUpperCase()}-${String(seller._id).slice(-4).toUpperCase()}`;

  const created = await api('POST', '/orders/create/adhoc', {
    order_id: ref,
    order_date: srDate(new Date(order.createdAt || Date.now())),
    pickup_location: pickup,
    billing_customer_name: nameParts[0],
    billing_last_name: nameParts.slice(1).join(' ') || '.',
    billing_address: a.addressLine,
    billing_city: a.city,
    billing_pincode: String(a.pincode),
    billing_state: a.state || '',
    billing_country: 'India',
    billing_email: a.email || 'orders@sheenbazaar.online',
    billing_phone: digits10(a.phone),
    shipping_is_billing: true,
    order_items: mine.map((i) => ({ name: String(i.name).slice(0, 100), sku: `SB-${i.productId}`, units: i.qty, selling_price: i.price })),
    payment_method: order.paymentStatus === 'paid' ? 'Prepaid' : 'COD',
    sub_total: subTotal,
    length: Number(opts.length) || s.length,
    breadth: Number(opts.breadth) || s.breadth,
    height: Number(opts.height) || s.height,
    weight,
  });
  if (!created.shipment_id) throw new Error(created.message || 'Shiprocket did not create the shipment');

  const shipment = {
    seller: seller._id, provider: 'shiprocket', ref,
    srOrderId: String(created.order_id || ''), shipmentId: String(created.shipment_id),
    awb: '', courierName: '', labelUrl: '', trackUrl: '', status: 'created', events: [],
  };

  // Courier + AWB: the courier the seller picked, or Shiprocket's choice by your priority settings
  const awbBody = { shipment_id: created.shipment_id };
  if (Number(opts.courierId) > 0) awbBody.courier_id = Number(opts.courierId);
  const awbRes = await api('POST', '/courier/assign/awb', awbBody);
  const awbData = awbRes?.response?.data || {};
  if (!awbData.awb_code) {
    shipment.status = 'awb_failed';
    shipment.error = awbRes?.message || awbData?.awb_assign_error || 'No courier could be assigned (check your Shiprocket wallet balance and pincode serviceability).';
    return shipment;
  }
  shipment.awb = String(awbData.awb_code);
  shipment.courierName = awbData.courier_name || '';
  shipment.trackUrl = `https://shiprocket.co/tracking/${shipment.awb}`;
  shipment.status = 'awb_assigned';

  // Pickup + label (a failure here doesn't undo the booking — the seller can retry)
  try {
    await api('POST', '/courier/generate/pickup', { shipment_id: [created.shipment_id] });
    shipment.status = 'pickup_scheduled';
  } catch (err) { shipment.error = `Pickup not scheduled yet: ${err.message}`; }
  try {
    const lab = await api('POST', '/courier/generate/label', { shipment_id: [created.shipment_id] });
    shipment.labelUrl = lab.label_url || '';
  } catch { /* label can be fetched again later */ }
  return shipment;
}

async function getLabel(shipmentId) {
  const lab = await api('POST', '/courier/generate/label', { shipment_id: [Number(shipmentId) || shipmentId] });
  return lab.label_url || '';
}

async function cancelShiprocketOrder(srOrderId) {
  if (!srOrderId) return;
  await api('POST', '/orders/cancel', { ids: [Number(srOrderId) || srOrderId] });
}

async function track(awb) {
  const d = await api('GET', `/courier/track/awb/${encodeURIComponent(awb)}`);
  const t = d.tracking_data || {};
  const acts = Array.isArray(t.shipment_track_activities) ? t.shipment_track_activities : [];
  return {
    status: t.shipment_track?.[0]?.current_status || '',
    etd: t.etd || t.shipment_track?.[0]?.edd || null,
    events: acts.map((x) => ({ at: x.date, status: x['sr-status-label'] || x.status || '', activity: x.activity || '', location: x.location || '' })),
  };
}

// Courier wording → our order status (null = no change)
function mapStatus(text) {
  const s = String(text || '').toUpperCase();
  if (!s) return null;
  if (/UNDELIVERED|NOT DELIVERED|RTO|RETURN|CANCEL|LOST|DAMAGED|DESTROYED/.test(s)) return null;
  if (/OUT FOR DELIVERY/.test(s)) return 'out_for_delivery';
  if (/DELIVERED/.test(s)) return 'delivered';
  if (/PICKED UP|IN TRANSIT|SHIPPED|REACHED|DISPATCHED|MISROUTED|DELAYED|AT DESTINATION|IN-TRANSIT/.test(s)) return 'shipped';
  return null;
}

module.exports = { settings, isEnabled, login, api, ensurePickup, createShipment, courierRates, parcelWeight, getLabel, cancelShiprocketOrder, track, mapStatus };
