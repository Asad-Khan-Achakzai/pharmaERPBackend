const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const announcementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

announcementSchema.index({ companyId: 1, isActive: 1, publishedAt: -1 });

announcementSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Announcement', announcementSchema);
