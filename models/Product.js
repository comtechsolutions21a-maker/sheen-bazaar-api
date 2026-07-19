const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    // Numeric id kept for parity with the original static frontend (js/data.js),
    // separate from Mongo's own _id.
    id: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true },
    icon: { type: String, default: '🛍️' }, // emoji fallback, shown until a real photo is uploaded
    image: { type: String, default: '' }, // real product photo, uploaded by the supplier (data URL or hosted URL)
    price: { type: Number, required: true },
    old: { type: Number, required: true },
    rating: { type: Number, default: 4.0 },
    badge: { type: String, default: '' },
    cat: { type: String, required: true, index: true },
    desc: { type: String, default: '' },

    // null/absent seller = a platform-owned demo listing (e.g. from the seed script).
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    stock: { type: Number, default: 100 },
    // Sellers can pull a listing without deleting it; admins can deactivate it too.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);
