const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  {
    serviceProviderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceProvider', required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    agents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    permissions: [{ type: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
