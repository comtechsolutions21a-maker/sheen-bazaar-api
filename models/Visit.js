const mongoose = require('mongoose');

const visitSchema = new mongoose.Schema({
  path: { type: String, required: true },
  // A random id generated client-side and stored in localStorage — lets us
  // count "unique visitors" without any personal info or login required.
  visitorId: { type: String, required: true, index: true },
}, { timestamps: true });

visitSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Visit', visitSchema);
