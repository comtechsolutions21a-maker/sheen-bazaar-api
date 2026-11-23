// Delivery fee (paid by the customer) and courier cost split (rest paid by the seller).
const Settings = require('../models/Settings');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function ruleFrom(s) {
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const fee = num(s?.deliveryFee);
  const freeAbove = num(s?.freeDeliveryAbove);
  return {
    fee: Number.isFinite(fee) && fee >= 0 ? fee : 49,
    freeAbove: Number.isFinite(freeAbove) && freeAbove >= 0 ? freeAbove : 499, // 0 = never free
    chargeSellers: s?.chargeSellerShipping !== false,
  };
}
async function deliveryRule() { return ruleFrom(await Settings.get()); }

// What the customer pays for delivery on this cart
function deliveryFeeFor(itemsTotal, rule) {
  if (!itemsTotal) return 0;
  if (rule.freeAbove > 0 && itemsTotal >= rule.freeAbove) return 0;
  return rule.fee;
}

// The part of the customer's delivery fee that belongs to this seller's parcel
// (split by item value when one order has items from several sellers)
function customerShareFor(order, sellerId) {
  const fee = Number(order.deliveryFee) || 0;
  if (!fee) return 0;
  const sum = (list) => list.reduce((t, i) => t + i.price * i.qty, 0);
  const all = sum(order.items);
  const mine = sum(order.items.filter((i) => String(i.seller) === String(sellerId)));
  return all > 0 ? round((fee * mine) / all) : 0;
}

// Courier cost → { cost, customerPaid, sellerCharge }
function splitCourierCost(order, sellerId, cost, rule) {
  const c = round(cost);
  const customerPaid = Math.min(customerShareFor(order, sellerId), c);
  const sellerCharge = rule.chargeSellers ? round(Math.max(0, c - customerPaid)) : 0;
  return { cost: c, customerPaid, sellerCharge };
}

// Shipping to take out of this seller's payout for one order
function sellerShippingCharge(order, sellerId) {
  return round((order.shipments || [])
    .filter((s) => String(s.seller) === String(sellerId) && s.awb && s.status !== 'cancelled')
    .reduce((t, s) => t + (Number(s.sellerCharge) || 0), 0));
}

module.exports = { deliveryRule, ruleFrom, deliveryFeeFor, customerShareFor, splitCourierCost, sellerShippingCharge, round };
