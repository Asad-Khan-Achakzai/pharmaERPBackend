/**
 * Co-visit participant management — lifecycle, validation, response enrichment.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { CO_VISIT_PARTICIPANT_STATUS } = require('../constants/enums');

const ACTIVE_PARTICIPANT_STATUSES = [
  CO_VISIT_PARTICIPANT_STATUS.INVITED,
  CO_VISIT_PARTICIPANT_STATUS.ACCEPTED,
  CO_VISIT_PARTICIPANT_STATUS.CHECKED_IN,
  CO_VISIT_PARTICIPANT_STATUS.COMPLETED
];

const EXECUTABLE_PARTICIPANT_STATUSES = [
  CO_VISIT_PARTICIPANT_STATUS.ACCEPTED,
  CO_VISIT_PARTICIPANT_STATUS.CHECKED_IN
];

const idStr = (v) => (v == null ? '' : String(typeof v === 'object' && v._id != null ? v._id : v));

const normalizeParticipantUserIds = (raw) => {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const s = idStr(x).trim();
    if (!s || !mongoose.Types.ObjectId.isValid(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

const assertParticipantsAssignable = async (companyId, ownerId, participantUserIds, reqUser) => {
  const ids = normalizeParticipantUserIds(participantUserIds);
  if (!ids.length) return [];

  if (ids.some((id) => id === idStr(ownerId))) {
    throw new ApiError(400, 'Plan owner cannot be added as a co-visit participant');
  }

  const users = await User.find({
    _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    companyId,
    isActive: true
  })
    .select('_id name')
    .lean();

  const found = new Set(users.map((u) => String(u._id)));
  for (const id of ids) {
    if (!found.has(id)) throw new ApiError(400, 'One or more co-visit participants are invalid or inactive');
  }
  return ids;
};

/** Phase 1: auto-accept invitations immediately after invite. */
const buildParticipantRecords = (participantUserIds, invitedByUserId) => {
  const now = new Date();
  return normalizeParticipantUserIds(participantUserIds).map((employeeId) => ({
    employeeId: new mongoose.Types.ObjectId(employeeId),
    lifecycleStatus: CO_VISIT_PARTICIPANT_STATUS.ACCEPTED,
    invitedAt: now,
    invitedBy: invitedByUserId ? new mongoose.Types.ObjectId(String(invitedByUserId)) : null,
    respondedAt: now
  }));
};

const findParticipantEntry = (item, userId) => {
  const uid = idStr(userId);
  return (item.participants || []).find((p) => idStr(p.employeeId) === uid) || null;
};

const isOwner = (item, userId) => idStr(item.employeeId) === idStr(userId);

const isActiveParticipant = (item, userId) => {
  const entry = findParticipantEntry(item, userId);
  if (!entry) return false;
  return ACTIVE_PARTICIPANT_STATUSES.includes(entry.lifecycleStatus);
};

const canExecuteAsParticipant = (item, userId) => {
  const entry = findParticipantEntry(item, userId);
  if (!entry) return false;
  if (entry.lifecycleStatus === CO_VISIT_PARTICIPANT_STATUS.COMPLETED) return false;
  return EXECUTABLE_PARTICIPANT_STATUSES.includes(entry.lifecycleStatus);
};

const assertOwnerCanManageParticipants = (item, reqUser) => {
  if (!isOwner(item, reqUser.userId)) {
    throw new ApiError(403, 'Only the visit owner can manage co-visit participants');
  }
};

const participantVisibilityQuery = (userId) => ({
  participants: {
    $elemMatch: {
      employeeId: new mongoose.Types.ObjectId(String(userId)),
      lifecycleStatus: { $in: ACTIVE_PARTICIPANT_STATUSES }
    }
  }
});

const enrichPlanItemCoVisit = (item, viewerUserId = null, userMap = null) => {
  const ownerId = idStr(item.employeeId);
  const ownerRef = userMap ? userMap[ownerId] : typeof item.employeeId === 'object' ? item.employeeId : null;
  const participants = (item.participants || []).map((p) => {
    const pid = idStr(p.employeeId);
    const userRef = userMap ? userMap[pid] : typeof p.employeeId === 'object' ? p.employeeId : null;
    return {
      ...p,
      employeeId: userRef || p.employeeId,
      name: userRef?.name || null
    };
  });

  const hasCoVisit = participants.length > 0;
  let coVisitRole = null;
  let myLifecycleStatus = null;
  if (viewerUserId) {
    const vid = idStr(viewerUserId);
    if (ownerId === vid) {
      coVisitRole = 'OWNER';
    } else if (findParticipantEntry(item, vid)) {
      coVisitRole = 'PARTICIPANT';
      myLifecycleStatus = findParticipantEntry(item, vid)?.lifecycleStatus || null;
    }
  }

  return {
    ...item,
    coVisit: hasCoVisit,
    coVisitRole,
    myLifecycleStatus,
    owner: ownerRef ? { _id: ownerRef._id, name: ownerRef.name } : { _id: item.employeeId, name: null },
    participants
  };
};

const populateParticipantUsers = async (items, viewerUserId = null) => {
  const ids = new Set();
  for (const item of items) {
    ids.add(idStr(item.employeeId));
    for (const p of item.participants || []) ids.add(idStr(p.employeeId));
  }
  ids.delete('');
  if (!ids.size) return items.map((i) => enrichPlanItemCoVisit(i, viewerUserId));
  const users = await User.find({ _id: { $in: [...ids] } })
    .select('name email')
    .lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));
  return items.map((item) => enrichPlanItemCoVisit(item, viewerUserId, byId));
};

const diffParticipantIds = (beforeItem, afterUserIds) => {
  const before = new Set((beforeItem?.participants || []).map((p) => idStr(p.employeeId)));
  const after = new Set(normalizeParticipantUserIds(afterUserIds));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  return { added, removed };
};

module.exports = {
  ACTIVE_PARTICIPANT_STATUSES,
  EXECUTABLE_PARTICIPANT_STATUSES,
  normalizeParticipantUserIds,
  assertParticipantsAssignable,
  buildParticipantRecords,
  findParticipantEntry,
  isOwner,
  isActiveParticipant,
  canExecuteAsParticipant,
  assertOwnerCanManageParticipants,
  participantVisibilityQuery,
  populateParticipantUsers,
  enrichPlanItemCoVisit,
  diffParticipantIds
};
