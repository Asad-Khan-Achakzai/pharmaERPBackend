const mongoose = require('mongoose');

/**
 * Per-company, per-UTC-day, per-prefix sequence for atomic order / invoice numbers.
 * Format in app: {key}-YYYYMMDD-#### (e.g. ORD, INV, O{companyCode} for seeds).
 */
const orderCounterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    date: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },
    sequence: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

orderCounterSchema.index({ companyId: 1, date: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('OrderCounter', orderCounterSchema, 'order_counters');
