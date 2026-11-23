// Moving an order to a new status from outside the seller's own buttons
// (e.g. the courier's tracking updates). Same rules as the seller route:
// Cash on Delivery money counts as collected on delivery, commission is split,
// referral rewards are flagged, and the customer is notified.
const { recordCodCollection } = require('./payments');
const { applyCommission } = require('./commission');
const { notifyOrderStatus } = require('./mailer');

const ORDER = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

async function advanceOrder(order, status, note = '', updatedBy = 'courier') {
  if (!ORDER.includes(status)) return false;
  // Never move backwards, and leave cancelled/returned orders alone
  if (!ORDER.includes(order.status) || ORDER.indexOf(status) <= ORDER.indexOf(order.status)) return false;

  order.status = status;
  order.statusHistory.push({ status, note, updatedBy });
  if (!order.shipping) order.shipping = {};
  if (status === 'shipped' && !order.shipping.shippedAt) order.shipping.shippedAt = new Date();
  if (status === 'delivered') {
    order.shipping.deliveredAt = new Date();
    if (order.paymentMethod === 'COD' && order.paymentStatus !== 'paid') {
      const c = recordCodCollection(order._id);
      order.paymentStatus = 'paid';
      order.transactionId = c.transactionId;
      await applyCommission(order);
      try {
        const User = require('../models/User');
        const u = await User.findById(order.user);
        if (u?.referredBy && !u.referralRewardGiven) { u.referralRewardGiven = true; await u.save(); }
      } catch { /* referral flag is best-effort */ }
    }
  }
  await order.save();
  notifyOrderStatus(order, status);
  return true;
}

module.exports = { advanceOrder };
