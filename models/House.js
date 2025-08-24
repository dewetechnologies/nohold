const mongoose = require('mongoose');

const houseSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    address1: { type: String, trim: true, default: '' },
    houseNumber: { type: String, trim: true, default: '' },
    suburb: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    imagePath: { type: String, trim: true, default: '' }, // relative path under /public
  },
  { timestamps: true }
);

module.exports = mongoose.model('House', houseSchema);
