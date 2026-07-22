const mongoose = require('mongoose');

/** Daily rollup for notification health / analytics. */
const notificationDailyStatSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD UTC
    kind: { type: String, required: true },
    created: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    read: { type: Number, default: 0 }
  },
  { timestamps: true }
);

notificationDailyStatSchema.index({ companyId: 1, day: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('NotificationDailyStat', notificationDailyStatSchema);
