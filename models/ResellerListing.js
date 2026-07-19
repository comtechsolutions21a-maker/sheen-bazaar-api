const mongoose = require('mongoose');

// A reseller doesn't own or stock the product — the original seller/manufacturer
// still fulfills the order. A listing just records the price the reseller wants
// to sell it at; the markup over the product's own price is the reseller's
// commission (see utils/commission.js), paid out once the order is delivered/paid.
const resellerListingSchema = new mongoose.Schema(
  {
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Number, required: true, index: true },
    resellPrice: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// One resale listing per reseller per product.
resellerListingSchema.index({ reseller: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('ResellerListing', resellerListingSchema);
