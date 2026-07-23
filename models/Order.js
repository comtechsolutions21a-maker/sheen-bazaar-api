const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: Number, required: true },
  name: { type: String, required: true },
  icon: { type: String, default: '🛍️' },
  image: { type: String, default: '' },
  price: { type: Number, required: true },
  qty: { type: Number, required: true },
  variant: { type: String, default: '' }, // e.g. "Size: M, Color: Red"
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  basePrice: { type: Number, default: null },
  commissionAmount: { type: Number, default: 0 },
  payoutAmount: { type: Number, default: 0 },
  resellerCommissionAmount: { type: Number, default: 0 },
  // Return/refund per item
  returnRequested: { type: Boolean, default: false },
  returnStatus: { type: String, enum: ['none','requested','approved','rejected','completed'], default: 'none' },
  returnReason: { type: String, default: '' },
  returnRequestedAt: { type: Date, default: null },
}, { _id: false });

const statusEventSchema = new mongoose.Schema({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now },
  note: { type: String, default: '' },
  updatedBy: { type: String, default: '' }, // 'seller', 'admin', 'system'
}, { _id: false });

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: { type: [orderItemSchema], required: true },
  itemsTotal: { type: Number, required: true },
  deliveryFee: { type: Number, required: true, default: 0 },
  discount: { type: Number, default: 0 }, // coupon discount
  couponCode: { type: String, default: '' },
  total: { type: Number, required: true },
  address: {
    fullName: String,
    phone: String,
    addressLine: String,
    city: String,
    state: String,
    pincode: String,
  },
  paymentMethod: { type: String, enum: ['UPI', 'CARD', 'COD', 'RAZORPAY'], default: 'COD' },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  transactionId: { type: String, default: '' },
  razorpayOrderId: { type: String, default: '' },
  commissionPercent: { type: Number, default: null },
  status: {
    type: String,
    enum: ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'return_requested', 'returned'],
    default: 'placed',
  },
  statusHistory: { type: [statusEventSchema], default: () => [{ status: 'placed', updatedBy: 'system' }] },
  shipping: {
    method: { type: String, enum: [null, 'courier_pickup', 'self_ship'], default: null },
    courierPartner: { type: String, default: '' },
    trackingNumber: { type: String, default: '' },
    trackingUrl: { type: String, default: '' },
    estimatedDelivery: { type: Date, default: null },
    packedAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  // Return request
  returnRequested: { type: Boolean, default: false },
  returnReason: { type: String, default: '' },
  returnStatus: { type: String, enum: ['none','requested','approved','rejected','completed'], default: 'none' },
  returnRequestedAt: { type: Date, default: null },
  sellerNotes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
