const mongoose = require('mongoose');
const { ONBOARDING_STATUS, ONBOARDING_STEP } = require('../constants/onboarding');

const stepProgressSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED'],
      default: 'PENDING'
    },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    completedAt: { type: Date, default: null }
  },
  { _id: false }
);

const onboardingSessionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    status: {
      type: String,
      enum: Object.values(ONBOARDING_STATUS),
      default: ONBOARDING_STATUS.DRAFT,
      index: true
    },
    currentStep: {
      type: String,
      enum: Object.values(ONBOARDING_STEP),
      default: ONBOARDING_STEP.COMPANY_SETUP
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
    progress: {
      companySetup: { type: stepProgressSchema, default: () => ({}) },
      masterData: { type: stepProgressSchema, default: () => ({}) },
      openingStock: { type: stepProgressSchema, default: () => ({}) },
      openingBalances: { type: stepProgressSchema, default: () => ({}) },
      optionalHistory: { type: stepProgressSchema, default: () => ({ status: 'SKIPPED' }) },
      verification: { type: stepProgressSchema, default: () => ({}) },
      goLive: { type: stepProgressSchema, default: () => ({}) }
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

onboardingSessionSchema.index({ companyId: 1 }, { unique: true });

module.exports = mongoose.model('OnboardingSession', onboardingSessionSchema);
