// Pincode rules set by the admin (Admin → Settings → Delivery & Pincodes).
// Each list is comma/space separated full pincodes ("192201") or prefixes
// ("192" = every pincode starting with 192). An empty list means "everywhere".
function parseList(str) {
  return String(str || '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^\d{1,6}$/.test(x));
}

function matches(list, pin) {
  return list.some(p => pin.startsWith(p));
}

function isValidPincode(pin) {
  return /^[1-9]\d{5}$/.test(String(pin || ''));
}

// Returns { valid, deliverable, cod, days, etaFrom, etaTo, message }
function checkPincode(settings, pin, productDeliveryDays = 5) {
  pin = String(pin || '').trim();
  if (!isValidPincode(pin)) return { valid: false, deliverable: false, cod: false, message: 'Please enter a valid 6-digit pincode.' };

  const serviceable = parseList(settings.serviceablePincodes);
  const blocked = parseList(settings.blockedPincodes);
  const codList = parseList(settings.codPincodes);
  const fast = parseList(settings.fastPincodes);

  const deliverable = !matches(blocked, pin) && (serviceable.length === 0 || matches(serviceable, pin));
  if (!deliverable) return { valid: true, pincode: pin, deliverable: false, cod: false, message: 'Sorry, we don\'t deliver to this pincode yet.' };

  const cod = codList.length === 0 || matches(codList, pin);
  const baseDays = Math.max(1, Number(productDeliveryDays) || 5);
  const days = matches(fast, pin) ? Math.max(1, Math.min(baseDays, Number(settings.fastDeliveryDays) || 2)) : baseDays;

  const etaFrom = new Date(); etaFrom.setDate(etaFrom.getDate() + days);
  const etaTo = new Date(etaFrom); etaTo.setDate(etaTo.getDate() + (days > 2 ? 2 : 1));

  return {
    valid: true, pincode: pin, deliverable: true, cod, days,
    etaFrom: etaFrom.toISOString(), etaTo: etaTo.toISOString(),
    message: cod ? 'Delivery available • Cash on Delivery available' : 'Delivery available • Online payment only (no COD here)',
  };
}

module.exports = { checkPincode, isValidPincode, parseList };
