// Couriers a supplier may choose from when self-shipping an order.
// Kept as a simple constant for now; could move to an admin-editable
// collection later if the platform wants to approve/revoke couriers dynamically.
const APPROVED_COURIERS = [
  'Delhivery',
  'Blue Dart',
  'DTDC',
  'Ekart Logistics',
  'Xpressbees',
  'India Post',
  'FedEx',
];

// Name shown to customers when the platform's own courier partner handles pickup.
const PLATFORM_COURIER_NAME = 'Sheen Bazaar Pickup Partner';

module.exports = { APPROVED_COURIERS, PLATFORM_COURIER_NAME };
