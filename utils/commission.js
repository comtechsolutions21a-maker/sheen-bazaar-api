const Settings = require('../models/Settings');

// Step 7 — Commission: once money for an order has actually landed in the
// business account (online payment captured, or COD cash collected on
// delivery), split each line item up to three ways:
//   - the supplier's own price (basePrice) is split between platform
//     commission and the supplier's payout, using whatever rate the admin
//     has currently set
//   - if the item was bought through a reseller's listing, the reseller
//     keeps the FULL markup (price - basePrice) as their own commission —
//     the platform's cut is only ever taken from the supplier's basePrice,
//     never from the reseller's markup
// The rate is snapshotted onto the order at that moment, so later admin
// changes never retroactively change money that's already settled.
async function applyCommission(order) {
  const settings = await Settings.get();
  const percent = settings.commissionPercent || 0; // no rate set yet => platform keeps nothing

  order.commissionPercent = settings.commissionPercent; // keep the raw value (may be null) for display
  order.items.forEach((item) => {
    const base = item.basePrice ?? item.price;
    const baseTotal = base * item.qty;
    const commissionAmount = Math.round((baseTotal * percent) / 100 * 100) / 100;
    item.commissionAmount = commissionAmount;
    item.payoutAmount = Math.round((baseTotal - commissionAmount) * 100) / 100;

    item.resellerCommissionAmount = item.reseller
      ? Math.round((item.price - base) * item.qty * 100) / 100
      : 0;
  });

  return order;
}

module.exports = { applyCommission };
