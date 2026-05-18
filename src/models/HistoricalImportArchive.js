const mongoose = require('mongoose');

const historicalImportArchiveSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', required: true, index: true },
    entityType: {
      type: String,
      required: true,
      enum: ['salesHistory', 'returnsHistory', 'collectionsHistory', 'visitsHistory', 'targetsHistory'],
      index: true
    },
    period: {
      fromDate: { type: String, required: true },
      toDate: { type: String, required: true },
      days: { type: Number, required: true }
    },
    archiveMode: { type: String, enum: ['ARCHIVE_ONLY', 'ARCHIVE_PLUS_SUMMARY'], default: 'ARCHIVE_ONLY' },
    rowCount: { type: Number, default: 0 },
    columns: { type: [String], default: [] },
    sampleRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    file: {
      originalName: { type: String, trim: true, default: '' },
      mimeType: { type: String, trim: true, default: '' },
      sizeBytes: { type: Number, min: 0, default: 0 }
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

historicalImportArchiveSchema.index({ companyId: 1, entityType: 1, createdAt: -1 });

module.exports = mongoose.model('HistoricalImportArchive', historicalImportArchiveSchema);
