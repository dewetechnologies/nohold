const mongoose = require('mongoose');

const querySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    topic: { type: String, trim: true },
    details: { type: String, trim: true },
    // Assignment
    serviceProviderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceProvider', index: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    // Status of the query: 'waiting' or 'completed'
    status: { type: String, enum: ['waiting', 'completed'], default: 'waiting', index: true },
    // Estimated time to resolution in minutes (optional)
    etaMinutes: { type: Number, min: 0 },
    // User rating 1-5 (optional)
    rating: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Query', querySchema);
