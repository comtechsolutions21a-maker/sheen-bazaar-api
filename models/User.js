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
    membershipTier: { type: String, enum: ['Free', 'Basic', 'Pro', 'VIP'], default: 'Free' },
    banned: { type: Boolean, default: false },

    // Seller KYC documents (base64 images/PDFs), submitted at signup for admin review
    sellerDocs: {
      panCard: { type: String, default: '' },
      aadhaarFront: { type: String, default: '' },
      aadhaarBack: { type: String, default: '' },
      gstCertificate: { type: String, default: '' }, // optional
      bankProof: { type: String, default: '' }, // cancelled cheque / passbook
      shopPhoto: { type: String, default: '' }, // optional
      submittedAt: { type: Date, default: null },
    },
    sellerDocsStatus: { type: String, enum: ['not_submitted', 'pending', 'approved', 'rejected'], default: 'not_submitted' },
    sellerDocsRejectReason: { type: String, default: '' },

    // Saved delivery addresses — so customers don't retype every order
    addresses: [{
      label: { type: String, default: 'Home' }, // Home, Work, Other
      fullName: String,
      phone: String,
      addressLine: String,
      city: String,
      state: String,
      pincode: String,
      isDefault: { type: Boolean, default: false },
    }],

    // Refer & Earn program
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    referralRewardGiven: { type: Boolean, default: false }, // becomes true after referee's first paid order
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
    membershipTier: this.membershipTier,
    banned: this.banned,
    sellerDocsStatus: this.sellerDocsStatus,
    sellerDocsRejectReason: this.sellerDocsRejectReason,
    addresses: this.addresses,
    referralCode: this.referralCode,
  };
};

module.exports = mongoose.model('User', userSchema);
