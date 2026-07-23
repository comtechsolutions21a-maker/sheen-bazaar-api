const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, default: 'Customer' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const productSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true, index: true },
  name: { type: String, required: true },
  icon: { type: String, default: '🛍️' },
  // images array — first image is the main/cover image
  images: [{ type: String }],
  image: { type: String, default: '' }, // legacy single image field
  price: { type: Number, required: true },
  old: { type: Number, required: true },
  rating: { type: Number, default: 4.0 },
  reviewCount: { type: Number, default: 0 },
  reviews: [reviewSchema],
  badge: { type: String, default: '' },
  cat: { type: String, required: true, index: true },
  desc: { type: String, default: '' },
  // Product details
  brand: { type: String, default: '' },
  sku: { type: String, default: '' },
  highlights: [{ type: String }], // bullet point features
  specifications: [{ key: String, value: String }], // tech specs table
  variants: [{ name: String, options: [String] }], // e.g. Size: [S,M,L,XL]
  tags: [{ type: String }],
  // Delivery
  deliveryDays: { type: Number, default: 5 },
  returnDays: { type: Number, default: 7 },
  warrantyMonths: { type: Number, default: 0 },
  // Seller
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  stock: { type: Number, default: 100 },
  active: { type: Boolean, default: true },
  approved: { type: Boolean, default: true }, // admin can unapprove
  featured: { type: Boolean, default: false },
  // Returns
  returnPolicy: { type: String, default: '7 days easy return' },
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
