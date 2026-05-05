const mongoose = require('mongoose');
const { TERRITORY_KIND } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * MRep territory tree. One collection holds Zone, Area, and Brick — `kind` plus a
 * self-referencing `parentId` form a 3-level tree (BRICK → AREA → ZONE → null).
 *
 * `materializedPath` is denormalised on save for fast subtree queries:
 *   `/<zoneId>/`               (zone)
 *   `/<zoneId>/<areaId>/`      (area)
 *   `/<zoneId>/<areaId>/<brickId>/` (brick)
 *
 * Doctors / Pharmacies / Users that adopt territory should reference the BRICK level.
 * Manager UIs can pivot at any level using the path prefix.
 */
const territorySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    /** Free-form short code (e.g. "QTA", "QTA-N", "QTA-N-CIVIL") — unique per company per kind. */
    code: { type: String, trim: true, maxlength: 64, default: null },
    kind: {
      type: String,
      enum: Object.values(TERRITORY_KIND),
      required: true
    },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Territory', default: null, index: true },
    /** Cached on save; never trusted from clients. */
    materializedPath: { type: String, default: '/', index: true },
    /** Cached on save: depth from the root (ZONE=0, AREA=1, BRICK=2). */
    depth: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

territorySchema.index({ companyId: 1, kind: 1, isActive: 1 });
territorySchema.index({ companyId: 1, parentId: 1, isActive: 1 });
territorySchema.index(
  { companyId: 1, kind: 1, code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' }, isDeleted: { $ne: true } } }
);
territorySchema.index({ companyId: 1, materializedPath: 1 });

territorySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Territory', territorySchema);
