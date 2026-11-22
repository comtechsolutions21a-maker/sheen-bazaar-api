// Flash-sale pricing helper. A product is "on flash sale" when it has a
// flashPrice lower than its normal price AND the sale end time is still in
// the future. Every place that charges money (cart, orders) uses this, so
// the sale price stops automatically the second the timer runs out.
function isFlashActive(p, now = Date.now()) {
  return !!(p && p.flashPrice > 0 && p.flashEndsAt && new Date(p.flashEndsAt).getTime() > now && p.flashPrice < p.price);
}

function effectivePrice(p) {
  return isFlashActive(p) ? p.flashPrice : p.price;
}

module.exports = { isFlashActive, effectivePrice };
