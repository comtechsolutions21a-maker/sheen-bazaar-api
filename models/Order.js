const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: Number, required: true },
    name: { type: String, required: true },
    icon: { type: String, default: '🛍️' },
    image: { type: String, default: '' },
    price: { type: Number, required: true },
    qty: { type: Number, required: true },
    // Which seller fulfills this line item (null = platform-owned demo product).
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Set when this item was bought through a reseller's listing rather than
    // directly. `price` above is what the customer actually paid (the resale
    // price); `basePrice` is the seller's own price for the product at the
    // time of purchase — commission math (Step 7) is based on basePrice, and
    // the reseller's markup (price - basePrice) is their own commission.
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    basePrice: { type: Number, default: null },
    // Step 7 — Commission: set once the payment for this order is actually
    // collected (see applyCommission in utils/commission.js). commissionAmount
    // is what the platform keeps, payoutAmount is what's transferred to the
    // supplier. Both stay 0 until then.
    commissionAmount: { type: Number, default: 0 },
    payoutAmount: { type: Number, default: 0 },
    // Full markup paid out to the reseller (if any) once the order is settled.
    resellerCommissionAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const statusEventSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: { type: [orderItemSchema], required: true },
    itemsTotal: { type: Number, required: true },
    deliveryFee: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true },
    address: {
      fullName: String,
      phone: String,
      addressLine: String,
    },
    paymentMethod: { type: String, enum: ['UPI', 'CARD', 'COD'], default: 'COD' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    // Set for online payments (simulated gateway capture) and for COD once cash is
    // collected on delivery, so every 'paid' order has a reference to point to.
    transactionId: { type: String, default: '' },
    // Step 7 — Commission: the admin-set rate (%) that was actually applied
    // when this order's payment was collected. null = not settled yet, or
    // no commission rate had been configured at settlement time.
    commissionPercent: { type: Number, default: null },
    status: {
      type: String,
      enum: ['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
      default: 'placed',
    },
    statusHistory: { type: [statusEventSchema], default: () => [{ status: 'placed' }] },

    // Set once the seller marks the order 'shipped'. Two options per Step 5:
    // the platform's own courier partner picks it up, or the supplier
    // self-ships via one of the platform's approved couriers.
    shipping: {
      method: { type: String, enum: [null, 'courier_pickup', 'self_ship'], default: null },
      courierPartner: { type: String, default: '' },
      trackingNumber: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
