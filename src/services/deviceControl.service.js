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
const { DEFAULT_MEDICAL_REP_CODE, ADMIN_ACCESS, DEFAULT_ADMIN_CODE } = require('../constants/rbac');
const { publishEventSafe } = require('./notificationPublisher.service');
const { resolveVisibleDeviceChangeRequest } = require('../utils/deviceControlStatus.util');
const logger = require('../utils/logger');

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
  logger.debug('deviceControl.enforceLoginBinding blocked', {
    userId: String(user._id),
    currentDeviceId: snap.deviceId,
    boundDeviceId: binding.deviceId
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
    void notifyDeviceChangeRequested(cid, existing).catch(() => null);
    return existing.toObject();
  }

  try {
    const created = await DeviceChangeRequest.create({
      companyId: cid,
      userId: uid,
      currentDeviceId: binding ? binding.deviceId : null,
      requestedDeviceId: snap.deviceId,
      requestedDevice: snap,
      status: DEVICE_CHANGE_REQUEST_STATUS.PENDING,
      reason: reason ? String(reason).slice(0, 500) : null
    });
    void notifyDeviceChangeRequested(cid, created).catch(() => null);
    return created.toObject();
  } catch (err) {
    // Concurrent create race: unique PENDING index — reload and update the winner.
    if (err && err.code === 11000) {
      const raced = await DeviceChangeRequest.findOne({
        companyId: cid,
        userId: uid,
        status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
      });
      if (raced) {
        raced.currentDeviceId = binding ? binding.deviceId : null;
        raced.requestedDeviceId = snap.deviceId;
        raced.requestedDevice = snap;
        if (reason !== undefined) raced.reason = reason ? String(reason).slice(0, 500) : null;
        await raced.save();
        void notifyDeviceChangeRequested(cid, raced).catch(() => null);
        return raced.toObject();
      }
    }
    throw err;
  }
}

async function getMyDeviceChangeRequest({ userId, companyId, deviceId }) {
  const cid = toOid(companyId);
  const uid = toOid(userId);
  const currentDeviceId = deviceId ? String(deviceId) : null;

  const [pending, binding, latestForThisDevice] = await Promise.all([
    DeviceChangeRequest.findOne({
      companyId: cid,
      userId: uid,
      status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
    }).lean(),
    MobileDeviceBinding.findOne({ companyId: cid, userId: uid }).select('deviceId').lean(),
    currentDeviceId
      ? DeviceChangeRequest.findOne({
          companyId: cid,
          userId: uid,
          requestedDeviceId: currentDeviceId
        })
          .sort({ createdAt: -1 })
          .lean()
      : Promise.resolve(null)
  ]);

  const visible = resolveVisibleDeviceChangeRequest({
    pending,
    latestForThisDevice,
    boundDeviceId: binding ? binding.deviceId : null,
    currentDeviceId
  });

  logger.debug('deviceControl.getMyDeviceChangeRequest', {
    userId: String(uid),
    currentDeviceId,
    boundDeviceId: binding ? binding.deviceId : null,
    pendingId: pending ? String(pending._id) : null,
    latestForThisDeviceStatus: latestForThisDevice ? latestForThisDevice.status : null,
    visibleStatus: visible ? visible.status : null
  });

  return visible;
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
  const session = await mongoose.startSession();
  let approved = null;

  try {
    await session.withTransaction(async () => {
      // Atomic claim: only one concurrent approve/reject can win this PENDING row.
      const request = await DeviceChangeRequest.findOneAndUpdate(
        {
          _id: requestId,
          companyId: cid,
          status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
        },
        {
          $set: {
            status: DEVICE_CHANGE_REQUEST_STATUS.APPROVED,
            decidedBy: toOid(adminUserId),
            decidedAt: new Date()
          }
        },
        { new: true, session }
      );

      if (!request) {
        const existing = await DeviceChangeRequest.findOne({ _id: requestId, companyId: cid }).session(
          session
        );
        if (!existing) throw new ApiError(404, 'Device change request not found');
        throw new ApiError(400, `Request already ${existing.status.toLowerCase()}`);
      }

      // Binding is the single source of truth for the active device.
      await MobileDeviceBinding.findOneAndUpdate(
        { companyId: cid, userId: request.userId },
        {
          $set: {
            deviceId: request.requestedDevice.deviceId,
            platform: request.requestedDevice.platform,
            brand: request.requestedDevice.brand,
            model: request.requestedDevice.model,
            osVersion: request.requestedDevice.osVersion,
            appVersion: request.requestedDevice.appVersion,
            boundAt: new Date(),
            boundBy: DEVICE_BINDING_SOURCE.ADMIN_APPROVAL,
            boundByUserId: toOid(adminUserId),
            lastSeenAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      // Kill every live session so the previous device cannot refresh.
      await DeviceSession.updateMany(
        { companyId: cid, userId: request.userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'DEVICE_REBOUND' } },
        { session }
      );

      // Prior APPROVED rows become SUPERSEDED (audit only).
      await DeviceChangeRequest.updateMany(
        {
          companyId: cid,
          userId: request.userId,
          status: DEVICE_CHANGE_REQUEST_STATUS.APPROVED,
          _id: { $ne: request._id }
        },
        {
          $set: {
            status: DEVICE_CHANGE_REQUEST_STATUS.SUPERSEDED,
            decidedAt: new Date(),
            decisionNote: 'Superseded by a later device change approval'
          }
        },
        { session }
      );

      approved = request;
    });
  } finally {
    session.endSession();
  }

  logger.info('deviceControl.approveRequest', {
    requestId: String(approved._id),
    userId: String(approved.userId),
    approvedDeviceId: approved.requestedDeviceId,
    adminUserId: String(adminUserId)
  });

  void notifyDeviceChangeOutcome(cid, approved, 'approved').catch(() => null);
  return approved.toObject ? approved.toObject() : approved;
}

async function rejectRequest({ companyId, requestId, adminUserId, note }) {
  const cid = toOid(companyId);
  const decisionNote = note ? String(note).slice(0, 500) : null;

  const request = await DeviceChangeRequest.findOneAndUpdate(
    {
      _id: requestId,
      companyId: cid,
      status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
    },
    {
      $set: {
        status: DEVICE_CHANGE_REQUEST_STATUS.REJECTED,
        decidedBy: toOid(adminUserId),
        decidedAt: new Date(),
        decisionNote
      }
    },
    { new: true }
  );

  if (!request) {
    const existing = await DeviceChangeRequest.findOne({ _id: requestId, companyId: cid });
    if (!existing) throw new ApiError(404, 'Device change request not found');
    throw new ApiError(400, `Request already ${existing.status.toLowerCase()}`);
  }

  void notifyDeviceChangeOutcome(cid, request, 'rejected', request.decisionNote).catch(() => null);
  return request.toObject();
}

async function findDeviceControlAdminUserIds(companyId) {
  const adminRoles = await Role.find({
    companyId,
    isDeleted: { $ne: true },
    $or: [
      { code: DEFAULT_ADMIN_CODE },
      { permissions: ADMIN_ACCESS },
      { permissions: 'deviceControl.manage' }
    ]
  })
    .select('_id')
    .lean();
  const roleIds = adminRoles.map((r) => r._id);
  const or = [{ role: ROLES.ADMIN }];
  if (roleIds.length) or.push({ roleId: { $in: roleIds } });

  const users = await User.find({
    companyId,
    isActive: true,
    isDeleted: { $ne: true },
    $or: or
  })
    .select('_id')
    .lean();
  return [...new Set(users.map((u) => String(u._id)))];
}

async function notifyDeviceChangeRequested(companyId, request) {
  const requester = await User.findById(request.userId).select('name').lean();
  const name = requester?.name || 'A team member';
  const requestId = String(request._id);
  const targets = await findDeviceControlAdminUserIds(companyId);
  await Promise.all(
    targets.map((userId) =>
      publishEventSafe({
        eventName: 'deviceChange.requested',
        companyId,
        userId,
        title: 'Device change pending',
        body: `${name} requested a new device`,
        link: '/notifications',
        meta: { deviceChangeRequestId: requestId },
        dedupeKey: `deviceChange:${requestId}:requested:${userId}`
      })
    )
  );
}

async function notifyDeviceChangeOutcome(companyId, request, outcome, note) {
  if (!request?.userId) return;
  const requestId = String(request._id);
  const approved = outcome === 'approved';
  await publishEventSafe({
    eventName: approved ? 'deviceChange.approved' : 'deviceChange.rejected',
    companyId,
    userId: request.userId,
    title: approved ? 'Device change approved' : 'Device change rejected',
    body: approved
      ? 'You can sign in on the new device'
      : note || 'Your device change request was rejected',
    link: '/notifications',
    meta: { deviceChangeRequestId: requestId, outcome },
    dedupeKey: `deviceChange:${requestId}:${outcome}`
  });
}

/**
 * Force-revoke a user's device: clears the binding, kills sessions, and cancels
 * any open PENDING / supersedes APPROVED requests so a stale approval cannot
 * rebind the user after the next first-login grace bind.
 */
async function forceRevoke({ companyId, userId, adminUserId }) {
  const cid = toOid(companyId);
  const uid = toOid(userId);
  const session = await mongoose.startSession();
  let hadBinding = false;

  try {
    await session.withTransaction(async () => {
      const binding = await MobileDeviceBinding.findOne({ companyId: cid, userId: uid }).session(
        session
      );
      hadBinding = Boolean(binding);
      await MobileDeviceBinding.deleteOne({ companyId: cid, userId: uid }, { session });

      await DeviceSession.updateMany(
        { companyId: cid, userId: uid, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'ADMIN_FORCE_REVOKE' } },
        { session }
      );

      await DeviceChangeRequest.updateMany(
        {
          companyId: cid,
          userId: uid,
          status: DEVICE_CHANGE_REQUEST_STATUS.PENDING
        },
        {
          $set: {
            status: DEVICE_CHANGE_REQUEST_STATUS.CANCELLED,
            decidedBy: toOid(adminUserId),
            decidedAt: new Date(),
            decisionNote: 'Cancelled by admin force revoke'
          }
        },
        { session }
      );

      await DeviceChangeRequest.updateMany(
        {
          companyId: cid,
          userId: uid,
          status: DEVICE_CHANGE_REQUEST_STATUS.APPROVED
        },
        {
          $set: {
            status: DEVICE_CHANGE_REQUEST_STATUS.SUPERSEDED,
            decidedAt: new Date(),
            decisionNote: 'Superseded by admin force revoke'
          }
        },
        { session }
      );
    });
  } finally {
    session.endSession();
  }

  return { revoked: true, hadBinding, by: String(adminUserId) };
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
