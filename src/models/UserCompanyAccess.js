const mongoose = require('mongoose');

const UserCompanyAccessSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

UserCompanyAccessSchema.index({ userId: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('UserCompanyAccess', UserCompanyAccessSchema);
