const mongoose = require('mongoose');

// Singleton document (there is always exactly one) holding platform-wide
// settings that admins configure at runtime rather than hardcoding in code.
//
// Step 7 — Commission: the platform keeps a cut of every paid order and
// transfers the remainder to the supplier. That cut is NOT a hardcoded
// percentage — an admin enters it manually here, and it can be changed
// at any time. Until an admin sets it, commissionPercent is null and no
// commission is deducted (payout = full amount) so behaviour never
// silently defaults to some made-up number.
const settingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'singleton', unique: true },
    commissionPercent: { type: Number, default: null, min: 0, max: 100 },
  },
  { timestamps: true }
);

settingsSchema.statics.get = async function () {
  let doc = await this.findOne({ singleton: 'singleton' });
  if (!doc) doc = await this.create({ singleton: 'singleton' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
