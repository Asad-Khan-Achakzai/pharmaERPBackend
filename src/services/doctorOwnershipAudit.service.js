const mongoose = require('mongoose');
const DoctorOwnershipEvent = require('../models/DoctorOwnershipEvent');
const Company = require('../models/Company');

const toOid = (v) => {
  if (v == null || v === '') return null;
  return new mongoose.Types.ObjectId(String(v));
};

/**
 * Append ownership events when assignment fields change and tenant flag is on.
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId} params.companyId
 * @param {import('mongoose').Types.ObjectId} params.doctorId
 * @param {import('mongoose').Types.ObjectId} params.changedByUserId
 * @param {object} params.before - `{ assignedRepId?, territoryId? }` raw ids or null
 * @param {object} params.after - same shape
 */
const recordAssignmentChanges = async ({ companyId, doctorId, changedByUserId, before, after }) => {
  const co = await Company.findById(companyId).select('mrepOwnershipAudit').lean();
  if (!co || co.mrepOwnershipAudit !== true) return;

  const cid = new mongoose.Types.ObjectId(String(companyId));
  const did = new mongoose.Types.ObjectId(String(doctorId));
  const uid = changedByUserId ? new mongoose.Types.ObjectId(String(changedByUserId)) : null;

  const rows = [];
  const pushIfChanged = (field, fromRaw, toRaw) => {
    const fromId = toOid(fromRaw);
    const toId = toOid(toRaw);
    const fs = fromId ? String(fromId) : '';
    const ts = toId ? String(toId) : '';
    if (fs === ts) return;
    rows.push({
      companyId: cid,
      doctorId: did,
      field,
      fromId,
      toId,
      changedByUserId: uid,
      effectiveAt: new Date()
    });
  };

  pushIfChanged('assignedRepId', before.assignedRepId, after.assignedRepId);
  pushIfChanged('territoryId', before.territoryId, after.territoryId);

  if (!rows.length) return;
  await DoctorOwnershipEvent.insertMany(rows);
};

const listForDoctor = async (companyId, doctorId, { limit = 50 } = {}) => {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return DoctorOwnershipEvent.find({
    companyId,
    doctorId,
    isDeleted: { $ne: true }
  })
    .sort({ effectiveAt: -1 })
    .limit(lim)
    .populate('changedByUserId', 'name email')
    .lean();
};

module.exports = { recordAssignmentChanges, listForDoctor };
