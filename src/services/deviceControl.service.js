const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const Role = require('../models/Role');
const User = require('../models/User');
const Company = require('../models/Company');
const DeviceSession = require('../models/DeviceSession');
const MobileDeviceBinding = require('../models/MobileDeviceBinding');
const DeviceChangeRequest = require('../models/DeviceChangeRequest');
const { generateDeviceChangeToken } = require('./auth.tokens');
const { effectiveUserType } = require('../utils/jwtAccess');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const {
  ROLES,
  USER_TYPES,
  DEVICE_CHANGE_REQUEST_STATUS,
  DEVICE_BINDING_SOURCE
} = require('../constants/enums');
const { DEFAULT_MEDICAL_REP_CODE } = require('../constants/rbac');

const toOid = (id) => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return new mongoose.Types.ObjectId(String(id));
};

function deviceSnapshot(device = {}) {
  return {
    deviceId: String(device.deviceId || '').trim(),
    platform: device.platform || null,
    brand: device.brand ? String(device.brand).slice(0, 64) : null,
    model: device.model ? String(device.model).slice(0, 64) : null,
    osVersion: device.osVersion ? String(device.osVersion).slice(0, 32) : null,
    appVersion: device.appVersion ? String(device.appVersion).slice(0, 32) : null
  };
}

/**
 * Whether device binding applies to this user. Only field-force reps
 * (Role.code === DEFAULT_MEDICAL_REP) on the mobile surface are bound.
 * Platform / super admin / admin / ASM / RM are never device-bound.
 */
async function appliesToUser(user) {
  if (!user) return false;
  if (effectiveUserType(user) === USER_TYPES.PLATFORM) return false;
  if (user.roleId) {
    const role = await Role.findById(user.roleId).select('code').lean();
    if (role && role.code != null) {
      return String(role.code) === DEFAULT_MEDICAL_REP_CODE;
    }
  }
  // Legacy users without a roleId: fall back to the coarse role enum.
  return user.role === ROLES.MEDICAL_REP;
}

async function upsertBinding({ companyId, userId, device, boundBy, boundByUserId = null }) {
  const snap = deviceSnapshot(device);
  return MobileDeviceBinding.findOneAndUpdate(
    { companyId: toOid(companyId), userId: toOid(userId) },
    {
      $set: {
        deviceId: snap.deviceId,
        platform: snap.platform,
        brand: snap.brand,
        model: snap.model,
        osVersion: snap.osVersion,
        appVersion: snap.appVersion,
        boundAt: new Date(),
        boundBy,
        boundByUserId: boundByUserId ? toOid(boundByUserId) : null,
        lastSeenAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** Revoke every live mobile session for a user in a company (kills old refresh tokens). */
async function revokeUserSessions({ companyId, userId, reason }) {
  await DeviceSession.updateMany(
    { companyId: toOid(companyId), userId: toOid(userId), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
}

/**
 * Mobile login gate. Throws a 403 DEVICE_NOT_REGISTERED (with a short-lived
 * device-change token) when the rep logs in from a device other than the one
 * they are bound to. Auto-binds on first login (grace period).
 *
 * @returns {Promise<{result: 'FIRST_BIND'|'MATCHED'}>}
 */
async function enforceLoginBinding({ user, company, device }) {
  const companyId = company._id;
  const snap = deviceSnapshot(device);

  let binding = await MobileDeviceBinding.findOne({ companyId: toOid(companyId), userId: toOid(user._id) });

  if (!binding) {
    try {
      await upsertBinding({
        companyId,
        userId: user._id,
        device: snap,
        boundBy: DEVICE_BINDING_SOURCE.FIRST_LOGIN
      });
      return { result: 'FIRST_BIND' };
    } catch (err) {
      // Race: another device bound first. Re-read and fall through to the match check.
      if (err && err.code === 11000) {
        binding = await MobileDeviceBinding.findOne({
          companyId: toOid(companyId),
          userId: toOid(user._id)
        });
      } else {
        throw err;
      }
    }
  }

  if (binding && String(binding.deviceId) === snap.deviceId) {
    binding.lastSeenAt = new Date();
    binding.platform = snap.platform;
    binding.brand = snap.brand;
    binding.model = snap.model;
    binding.osVersion = snap.osVersion;
    binding.appVersion = snap.appVersion;
    await binding.save();
    return { result: 'MATCHED' };
  }

  // Different device → block, but hand back a short-lived token to request a change.
  const deviceChangeToken = generateDeviceChangeToken({
    userId: user._id,
    companyId,
    deviceId: snap.deviceId
  });
  const pending = await DeviceChangeRequest.findOne({
    companyId: toOid(companyId),
    userId: toOid(user._id),
    status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
  }).lean();

  const error = new ApiError(
    403,
    'This device is not registered. Request a device change and wait for admin approval.'
  );
  error.code = 'DEVICE_NOT_REGISTERED';
  error.data = {
    deviceChangeToken,
    currentDevice: binding
      ? { platform: binding.platform, brand: binding.brand, model: binding.model }
      : null,
    pendingRequest: pending
      ? {
          id: pending._id,
          status: pending.status,
          requestedDeviceId: pending.requestedDeviceId,
          createdAt: pending.createdAt
        }
      : null
  };
  throw error;
}

/**
 * Per-request hard enforcement (called from companyScope for mobile MRep
 * requests). Returns true when the request's device is the bound device, OR
 * when there is no binding yet (grace period). Returns false when the request
 * comes from a device that is no longer bound (old device after a switch).
 */
async function isRequestDeviceBound({ companyId, userId, deviceId }) {
  if (!deviceId) return true;
  const binding = await MobileDeviceBinding.findOne({
    companyId: toOid(companyId),
    userId: toOid(userId)
  })
    .select('deviceId')
    .lean();
  if (!binding) return true;
  return String(binding.deviceId) === String(deviceId);
}

// ---------------------------------------------------------------------------
// Field-force (mobile) device-change request flow — authed by device-change token
// ---------------------------------------------------------------------------

async function createDeviceChangeRequest({ userId, companyId, tokenDeviceId, device, reason }) {
  const snap = deviceSnapshot(device);
  if (!snap.deviceId) throw new ApiError(400, 'device.deviceId is required');
  if (tokenDeviceId && snap.deviceId !== String(tokenDeviceId)) {
    throw new ApiError(400, 'Device mismatch. Please log in again to request a device change.');
  }

  const cid = toOid(companyId);
  const uid = toOid(userId);

  const binding = await MobileDeviceBinding.findOne({ companyId: cid, userId: uid }).lean();
  if (binding && String(binding.deviceId) === snap.deviceId) {
    throw new ApiError(400, 'This device is already registered for your account.');
  }

  const existing = await DeviceChangeRequest.findOne({
    companyId: cid,
    userId: uid,
    status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
  });

  if (existing) {
    existing.currentDeviceId = binding ? binding.deviceId : null;
    existing.requestedDeviceId = snap.deviceId;
    existing.requestedDevice = snap;
    if (reason !== undefined) existing.reason = reason ? String(reason).slice(0, 500) : null;
    await existing.save();
    return existing.toObject();
  }

  const created = await DeviceChangeRequest.create({
    companyId: cid,
    userId: uid,
    currentDeviceId: binding ? binding.deviceId : null,
    requestedDeviceId: snap.deviceId,
    requestedDevice: snap,
    status: DEVICE_CHANGE_REQUEST_STATUS.PENDING,
    reason: reason ? String(reason).slice(0, 500) : null
  });
  return created.toObject();
}

async function getMyDeviceChangeRequest({ userId, companyId, deviceId }) {
  const cid = toOid(companyId);
  const uid = toOid(userId);

  // Prefer an open PENDING request (at most one per user) so the waiting UI stays correct.
  const pending = await DeviceChangeRequest.findOne({
    companyId: cid,
    userId: uid,
    status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
  }).lean();
  if (pending) return pending;

  // Otherwise only return history for THIS device — avoids showing a stale APPROVED
  // request that was for a different deviceId (login-loop on the old phone).
  if (deviceId) {
    const forThisDevice = await DeviceChangeRequest.findOne({
      companyId: cid,
      userId: uid,
      requestedDeviceId: String(deviceId)
    })
      .sort({ createdAt: -1 })
      .lean();
    return forThisDevice || null;
  }

  const latest = await DeviceChangeRequest.findOne({ companyId: cid, userId: uid })
    .sort({ createdAt: -1 })
    .lean();
  return latest || null;
}

async function cancelDeviceChangeRequest({ userId, companyId }) {
  const pending = await DeviceChangeRequest.findOne({
    companyId: toOid(companyId),
    userId: toOid(userId),
    status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
  });
  if (!pending) throw new ApiError(404, 'No pending device change request to cancel');
  pending.status = DEVICE_CHANGE_REQUEST_STATUS.CANCELLED;
  pending.decidedAt = new Date();
  await pending.save();
  return pending.toObject();
}

// ---------------------------------------------------------------------------
// Admin (web) management — authed by companyScope + deviceControl.manage
// ---------------------------------------------------------------------------

async function listBindings({ companyId, query }) {
  const cid = toOid(companyId);
  const { page, limit, skip } = parsePagination(query);
  const search = qScalar(query.search);

  const filter = { companyId: cid };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const matchingUsers = await User.find({
      companyId: cid,
      isDeleted: { $ne: true },
      $or: [{ name: rx }, { email: rx }, { employeeCode: rx }]
    })
      .select('_id')
      .lean();
    filter.userId = { $in: matchingUsers.map((u) => u._id) };
  }

  const [docs, total] = await Promise.all([
    MobileDeviceBinding.find(filter)
      .sort({ lastSeenAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name email employeeCode role isActive')
      .lean(),
    MobileDeviceBinding.countDocuments(filter)
  ]);

  // Flag users with an open device-change request so the UI can highlight them.
  const userIds = docs.map((d) => d.userId?._id).filter(Boolean);
  const pendingRows = userIds.length
    ? await DeviceChangeRequest.find({
        companyId: cid,
        userId: { $in: userIds },
        status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
      })
        .select('userId')
        .lean()
    : [];
  const pendingSet = new Set(pendingRows.map((r) => String(r.userId)));

  const mapped = docs.map((d) => ({
    _id: d._id,
    user: d.userId
      ? {
          _id: d.userId._id,
          name: d.userId.name,
          email: d.userId.email,
          employeeCode: d.userId.employeeCode || null,
          isActive: d.userId.isActive
        }
      : null,
    deviceId: d.deviceId,
    platform: d.platform,
    brand: d.brand,
    model: d.model,
    osVersion: d.osVersion,
    appVersion: d.appVersion,
    boundAt: d.boundAt,
    boundBy: d.boundBy,
    lastSeenAt: d.lastSeenAt,
    hasPendingRequest: d.userId ? pendingSet.has(String(d.userId._id)) : false
  }));

  return { docs: mapped, total, page, limit };
}

async function listRequests({ companyId, query }) {
  const cid = toOid(companyId);
  const { page, limit, skip } = parsePagination(query);
  const status = qScalar(query.status);

  const filter = { companyId: cid };
  if (status && Object.values(DEVICE_CHANGE_REQUEST_STATUS).includes(status)) {
    filter.status = status;
  } else if (!status) {
    filter.status = DEVICE_CHANGE_REQUEST_STATUS.PENDING;
  }

  const [docs, total] = await Promise.all([
    DeviceChangeRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name email employeeCode')
      .populate('decidedBy', 'name email')
      .lean(),
    DeviceChangeRequest.countDocuments(filter)
  ]);

  return { docs, total, page, limit };
}

async function approveRequest({ companyId, requestId, adminUserId }) {
  const cid = toOid(companyId);
  const request = await DeviceChangeRequest.findOne({ _id: requestId, companyId: cid });
  if (!request) throw new ApiError(404, 'Device change request not found');
  if (request.status !== DEVICE_CHANGE_REQUEST_STATUS.PENDING) {
    throw new ApiError(400, `Request already ${request.status.toLowerCase()}`);
  }

  // Move the binding to the requested device.
  await upsertBinding({
    companyId: cid,
    userId: request.userId,
    device: request.requestedDevice,
    boundBy: DEVICE_BINDING_SOURCE.ADMIN_APPROVAL,
    boundByUserId: adminUserId
  });

  // Old device immediately loses access: kill all live sessions.
  await revokeUserSessions({ companyId: cid, userId: request.userId, reason: 'DEVICE_REBOUND' });

  request.status = DEVICE_CHANGE_REQUEST_STATUS.APPROVED;
  request.decidedBy = toOid(adminUserId);
  request.decidedAt = new Date();
  await request.save();
  return request.toObject();
}

async function rejectRequest({ companyId, requestId, adminUserId, note }) {
  const cid = toOid(companyId);
  const request = await DeviceChangeRequest.findOne({ _id: requestId, companyId: cid });
  if (!request) throw new ApiError(404, 'Device change request not found');
  if (request.status !== DEVICE_CHANGE_REQUEST_STATUS.PENDING) {
    throw new ApiError(400, `Request already ${request.status.toLowerCase()}`);
  }
  request.status = DEVICE_CHANGE_REQUEST_STATUS.REJECTED;
  request.decidedBy = toOid(adminUserId);
  request.decidedAt = new Date();
  request.decisionNote = note ? String(note).slice(0, 500) : null;
  await request.save();
  return request.toObject();
}

/**
 * Force-revoke a user's device: clears the binding and kills sessions. The next
 * successful mobile login auto-binds the device they log in from (grace period).
 */
async function forceRevoke({ companyId, userId, adminUserId }) {
  const cid = toOid(companyId);
  const uid = toOid(userId);
  const binding = await MobileDeviceBinding.findOne({ companyId: cid, userId: uid });
  await MobileDeviceBinding.deleteOne({ companyId: cid, userId: uid });
  await revokeUserSessions({ companyId: cid, userId: uid, reason: 'ADMIN_FORCE_REVOKE' });
  return { revoked: true, hadBinding: Boolean(binding), by: String(adminUserId) };
}

module.exports = {
  appliesToUser,
  enforceLoginBinding,
  isRequestDeviceBound,
  createDeviceChangeRequest,
  getMyDeviceChangeRequest,
  cancelDeviceChangeRequest,
  listBindings,
  listRequests,
  approveRequest,
  rejectRequest,
  forceRevoke
};
