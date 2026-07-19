const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    phone: { type: String, default: '' },
    // Cart is stored server-side as { productId: qty } so it persists across devices.
    cart: { type: Map, of: Number, default: {} },

    role: { type: String, enum: ['customer', 'seller', 'reseller', 'admin'], default: 'customer', index: true },

    // Seller-only fields
    businessName: { type: String, default: '' },
    // Sellers start unapproved so an admin can vet them before their listings go live.
    sellerApproved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    businessName: this.businessName,
    sellerApproved: this.sellerApproved,
  };
};

module.exports = mongoose.model('User', userSchema);
