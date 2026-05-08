const mongoose = require('mongoose');
const { Info } = require('luxon');
const { softDeletePlugin } = require('../plugins/softDelete');

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, default: 'Pakistan' },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    logo: { type: String },
    currency: { type: String, default: 'PKR' },
    /** Starting bank/cash position for implied cash balance (collections + settlements − outflows) */
    cashOpeningBalance: { type: Number, default: 0 },
    /**
     * Per-tenant feature flag (Phase 2B). When true, weekly plans require manager approval
     * before they go ACTIVE. New plans inherit this flag at creation; flipping it later
     * affects only future plans.
     */
    weeklyPlanApprovalRequired: { type: Boolean, default: false },
    /**
     * When true, reps cannot mark a visit out of planned sequence (same effect as env STRICT_VISIT_SEQUENCE=1).
     */
    strictVisitSequence: { type: Boolean, default: false },
    /**
     * When true, users may set `coverageTerritoryIds` (additional Zone/Area/Brick nodes).
     * `territoryId` remains the primary node; ownership queries union primary + extras.
     */
    mrepMultiTerritory: { type: Boolean, default: false },
    /** When true, doctor assignment changes append `DoctorOwnershipEvent` rows (additive audit). */
    mrepOwnershipAudit: { type: Boolean, default: false },
    /** Single canonical IANA timezone for business calendar (reports, plans, attendance anchors). Required at creation — no implicit UTC. */
    timeZone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return Info.isValidIANAZone(String(v || '').trim());
        },
        message: 'Company timeZone must be a valid IANA timezone identifier'
      }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

companySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Company', companySchema);
