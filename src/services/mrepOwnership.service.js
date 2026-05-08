/**
 * Single place for MRep doctor ownership rules (read-side).
 * Priority: assignedRepId (active rep in company) overrides; else territory match via rep brick union.
 */
const mongoose = require('mongoose');
const Territory = require('../models/Territory');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const { TERRITORY_KIND } = require('../constants/enums');
const { escapeRegex } = require('../utils/listQuery');

async function brickIdsUnderTerritoryPrefix(companyId, materializedPathPrefix) {
  if (!materializedPathPrefix || materializedPathPrefix === '/') return [];
  const rx = new RegExp(`^${escapeRegex(materializedPathPrefix)}`);
  const bricks = await Territory.find({
    companyId,
    kind: TERRITORY_KIND.BRICK,
    materializedPath: rx,
    isDeleted: { $ne: true }
  })
    .select('_id')
    .lean();
  return bricks.map((b) => b._id);
}

/** Accept ObjectId, hex string, or populated doc `{ _id }` (read paths use populated refs). */
function territoryRefToIdString(territoryRef) {
  if (territoryRef == null || territoryRef === '') return null;
  if (typeof territoryRef === 'object' && territoryRef._id != null) {
    return String(territoryRef._id);
  }
  const s = String(territoryRef);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return s;
}

async function brickIdsForTerritoryNode(companyId, territoryRef) {
  const idStr = territoryRefToIdString(territoryRef);
  if (!idStr) return [];
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const tid = new mongoose.Types.ObjectId(idStr);
  const t = await Territory.findOne({ _id: tid, companyId: cid, isDeleted: { $ne: true } })
    .select('kind materializedPath')
    .lean();
  if (!t || !t.materializedPath) return [];
  if (t.kind === TERRITORY_KIND.BRICK) return [t._id];
  return brickIdsUnderTerritoryPrefix(cid, t.materializedPath);
}

async function unionBrickIdsForRep(companyId, repLean) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const set = new Set();
  const add = async (territoryRef) => {
    if (!territoryRef) return;
    const ids = await brickIdsForTerritoryNode(cid, territoryRef);
    for (const id of ids) set.add(String(id));
  };

  await add(repLean.territoryId);
  if (Array.isArray(repLean.coverageTerritoryIds) && repLean.coverageTerritoryIds.length) {
    for (const extra of repLean.coverageTerritoryIds) {
      await add(extra);
    }
  }

  return [...set].map((s) => new mongoose.Types.ObjectId(s));
}

/**
 * Filter for doctors “owned” by rep for coverage lists (same semantics as legacy coverage.service).
 * @returns {object|null} Mongo filter, or null if rep not found
 */
const ownedDoctorsFilter = async (companyId, repId) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(repId));

  const rep = await User.findOne({ _id: rid, companyId: cid, isDeleted: { $ne: true } })
    .select('territoryId coverageTerritoryIds')
    .lean();
  if (!rep) return null;

  const brickIds = await unionBrickIdsForRep(cid, rep);

  const orClauses = [{ assignedRepId: rid }];
  const unassigned = {
    $or: [{ assignedRepId: null }, { assignedRepId: { $exists: false } }]
  };

  if (brickIds.length) {
    orClauses.push({ ...unassigned, territoryId: { $in: brickIds } });
  }

  return {
    companyId: cid,
    isDeleted: { $ne: true },
    isActive: true,
    $or: orClauses
  };
};

const idKey = (v) => {
  if (!v) return null;
  if (typeof v === 'object' && v._id) return String(v._id);
  return String(v);
};

/** UI / API: how this doctor row is attributed for the given rep’s coverage list. */
const ownershipForRepCoverageRow = (doctorLean, repId) => {
  const assigned = idKey(doctorLean.assignedRepId);
  if (assigned && String(assigned) === String(repId)) {
    return { kind: 'assigned', label: 'Assigned rep' };
  }
  return { kind: 'territory', label: 'Territory' };
};

/** UI / API: global doctor record ownership summary (no rep context). */
const summarizeDoctorDocument = (doctorLean) => {
  if (idKey(doctorLean.assignedRepId)) {
    return { kind: 'assigned', label: 'Assigned rep (primary owner)' };
  }
  if (idKey(doctorLean.territoryId)) {
    return { kind: 'territory', label: 'Territory-inferred (no rep pinned)' };
  }
  return { kind: 'unassigned', label: 'Unassigned' };
};

/** Territory rollup row: assigned vs inferred */
const ownershipForTerritoryRollupRow = (doctorLean) => {
  if (idKey(doctorLean.assignedRepId)) {
    return { kind: 'assigned', label: 'Pinned rep' };
  }
  if (idKey(doctorLean.territoryId)) {
    return { kind: 'territory', label: 'Territory only' };
  }
  return { kind: 'unassigned', label: 'Unassigned' };
};

const coverageBandLabel = (target, count) => {
  if (target == null || target <= 0) return 'no_target';
  if (count === 0) return 'no_visits';
  if (count >= target) return 'covered';
  return 'below_target';
};

/**
 * Deduped brick count + sample labels for user details (read-side).
 */
async function effectiveBrickCoverageSummary(companyId, repLean) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const brickIds = await unionBrickIdsForRep(cid, repLean);
  const count = brickIds.length;
  if (!count) {
    return { brickCount: 0, previewBricks: [] };
  }
  const head = brickIds.slice(0, 24);
  const rows = await Territory.find({
    _id: { $in: head },
    companyId: cid,
    kind: TERRITORY_KIND.BRICK,
    isDeleted: { $ne: true }
  })
    .select('name code')
    .lean();
  return {
    brickCount: count,
    previewBricks: rows.map((r) => ({ _id: r._id, name: r.name, code: r.code || null }))
  };
}

module.exports = {
  brickIdsUnderTerritoryPrefix,
  brickIdsForTerritoryNode,
  unionBrickIdsForRep,
  effectiveBrickCoverageSummary,
  ownedDoctorsFilter,
  ownershipForRepCoverageRow,
  summarizeDoctorDocument,
  ownershipForTerritoryRollupRow,
  coverageBandLabel,
  listOwnedDoctors: async (companyId, repId) => {
    const filter = await ownedDoctorsFilter(companyId, repId);
    if (!filter) return [];
    return Doctor.find(filter).select('_id name monthlyVisitTarget territoryId assignedRepId').lean();
  }
};
