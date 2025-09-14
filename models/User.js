const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['super_admin','sp_admin','agent','customer'], default: 'customer', index: true },
    // For staff/agents, a single provider; for customers, use serviceProviderIds
    serviceProviderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceProvider', index: true },
    serviceProviderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceProvider', index: true }],
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    // Address information
    address1: { type: String, trim: true, default: '' },
    houseNumber: { type: String, trim: true, default: '' },
    suburb: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
