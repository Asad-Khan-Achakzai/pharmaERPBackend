const mongoose = require('mongoose');
const User = require('../models/User');
const WorkShift = require('../models/WorkShift');
const AttendancePolicy = require('../models/AttendancePolicy');
const PolicyAssignment = require('../models/PolicyAssignment');
const ApprovalMatrix = require('../models/ApprovalMatrix');
const AttendanceRequest = require('../models/AttendanceRequest');
const { ATTENDANCE_REQUEST_STATUS, ATTENDANCE_REQUEST_TYPE } = require('../constants/enums');
const attendancePolicyService = require('./attendancePolicy.service');

const STALE_APPROVAL_MS = 48 * 60 * 60 * 1000;

/** Bound parallel policy resolution so very large companies do not stampede the DB. */
const SCHEDULE_CHECK_CONCURRENCY = 40;

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
};

/**
 * Operational readiness summary for attendance admins (business language).
 */
const getSummary = async (companyId) => {
  const cid = mongoose.Types.ObjectId.isValid(String(companyId))
    ? new mongoose.Types.ObjectId(String(companyId))
    : companyId;

  const flags = await attendancePolicyService.getCompanyFlags(cid);
  const activeUsers = await User.find({
    companyId: cid,
    isActive: true,
    isDeleted: { $ne: true }
  })
    .select('_id name email managerId')
    .sort({ name: 1 })
    .lean();

  const withoutManager = activeUsers.filter((u) => !u.managerId).map((u) => ({ _id: u._id, name: u.name, email: u.email }));

  const policies = await AttendancePolicy.find({ companyId: cid, isDeleted: { $ne: true } })
    .select('workShiftId name isDefault')
    .lean();
  const usedShiftIds = new Set(policies.map((p) => String(p.workShiftId)));

  const shifts = await WorkShift.find({ companyId: cid, isDeleted: { $ne: true } }).select('name isDefault').lean();
  const orphanedShifts = shifts
    .filter((s) => !usedShiftIds.has(String(s._id)))
    .map((s) => ({ _id: s._id, name: s.name, isDefault: Boolean(s.isDefault) }));

  let withoutSchedule = [];
  if (flags.attendancePoliciesEnabled) {
    const asOf = new Date();
    const scheduleChecks = await mapWithConcurrency(activeUsers, SCHEDULE_CHECK_CONCURRENCY, async (u) => {
      const ps = await attendancePolicyService.getEffectivePolicyAndShift(cid, u._id, asOf, { companyFlags: flags });
      return { u, ps };
    });
    withoutSchedule = scheduleChecks
      .filter(({ ps }) => !ps?.shift)
      .map(({ u }) => ({ _id: u._id, name: u.name, email: u.email }));
  }

  const matrices = await ApprovalMatrix.find({
    companyId: cid,
    isActive: true,
    isDeleted: { $ne: true }
  })
    .select('name requestCategory effectiveFrom effectiveTo')
    .lean();
  const byCat = {};
  for (const m of matrices) {
    const k = m.requestCategory || 'ALL';
    if (!byCat[k]) byCat[k] = [];
    byCat[k].push(m);
  }
  const duplicateApprovalFlows = Object.entries(byCat)
    .filter(([, arr]) => arr.length > 1)
    .map(([category, items]) => ({
      category,
      count: items.length,
      names: items.map((x) => x.name)
    }));

  const shiftTimingSig = (s) =>
    [
      s.startMinutes,
      s.endMinutes,
      Boolean(s.shiftEndsNextDay),
      s.graceMinutes ?? 0,
      s.postShiftCheckInCutoffMinutes ?? 0
    ].join('|');

  const shiftsFull = await WorkShift.find({ companyId: cid, isDeleted: { $ne: true } })
    .select('name startMinutes endMinutes shiftEndsNextDay graceMinutes postShiftCheckInCutoffMinutes')
    .lean();
  const sigToShifts = {};
  for (const s of shiftsFull) {
    const sig = shiftTimingSig(s);
    if (!sigToShifts[sig]) sigToShifts[sig] = [];
    sigToShifts[sig].push({ _id: s._id, name: s.name });
  }
  const duplicateShiftTimings = Object.values(sigToShifts)
    .filter((arr) => arr.length > 1)
    .map((group) => ({ shifts: group }));

  const byShiftPolicies = {};
  for (const p of policies) {
    const sid = String(p.workShiftId);
    if (!byShiftPolicies[sid]) byShiftPolicies[sid] = [];
    byShiftPolicies[sid].push({ _id: p._id, name: p.name });
  }
  const duplicatePoliciesSameShift = Object.entries(byShiftPolicies)
    .filter(([, arr]) => arr.length > 1)
    .map(([workShiftId, policyList]) => ({ workShiftId, policies: policyList }));

  const companyWideFallbackRows = await PolicyAssignment.find({
    companyId: cid,
    employeeId: null,
    isDeleted: { $ne: true }
  })
    .select('policyId')
    .lean();
  const companyWideFallbackCount = companyWideFallbackRows.length;

  const PENDING = ATTENDANCE_REQUEST_STATUS.PENDING;
  const ESCALATED = ATTENDANCE_REQUEST_STATUS.ESCALATED;
  const openReqs = await AttendanceRequest.find({
    companyId: cid,
    status: { $in: [PENDING, ESCALATED] },
    isDeleted: { $ne: true }
  })
    .select('status type slaDueAt adminPool currentApproverId createdAt decisions')
    .lean();

  const nowMs = Date.now();
  let openRequestsSlaBreached = 0;
  let openRequestsAdminQueue = 0;
  let openRequestsEscalatedStatus = 0;
  let openRequestsPendingLateArrival = 0;
  let openRequestsLastTouchAutomatic = 0;
  const approverCounts = {};
  for (const r of openReqs) {
    if (r.adminPool) openRequestsAdminQueue += 1;
    if (r.status === ESCALATED) openRequestsEscalatedStatus += 1;
    if (r.slaDueAt && new Date(r.slaDueAt).getTime() < nowMs) openRequestsSlaBreached += 1;
    if (r.type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL && r.status === PENDING) {
      openRequestsPendingLateArrival += 1;
    }
    const lastD = Array.isArray(r.decisions) && r.decisions.length ? r.decisions[r.decisions.length - 1] : null;
    if (lastD && (lastD.source === 'POLICY' || lastD.source === 'SYSTEM')) {
      openRequestsLastTouchAutomatic += 1;
    }
    if (r.currentApproverId && !r.adminPool) {
      const k = String(r.currentApproverId);
      approverCounts[k] = (approverCounts[k] || 0) + 1;
    }
  }

  const bottleneckEntries = Object.entries(approverCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  let managerApprovalLoads = [];
  if (bottleneckEntries.length) {
    const oids = bottleneckEntries
      .map(([id]) => id)
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    const approverUsers = await User.find({ _id: { $in: oids } }).select('name email isActive isDeleted').lean();
    const nm = Object.fromEntries(approverUsers.map((u) => [String(u._id), u]));
    managerApprovalLoads = bottleneckEntries.map(([userId, pendingCount]) => {
      const u = nm[userId];
      return {
        userId,
        name: u?.name || 'Unknown',
        email: u?.email || null,
        pendingCount,
        isActiveApprover: Boolean(u?.isActive && u?.isDeleted !== true)
      };
    });
  }

  const staleDelegations = await User.find({
    companyId: cid,
    isActive: true,
    isDeleted: { $ne: true },
    attendanceApproveDelegateUserId: { $ne: null },
    attendanceApproveDelegateUntil: { $ne: null, $lt: new Date() }
  })
    .select('name email attendanceApproveDelegateUntil')
    .limit(30)
    .lean();

  const usersWithMgr = activeUsers.filter((u) => u.managerId);
  const uniqMgrRaw = [...new Set(usersWithMgr.map((u) => String(u.managerId)))];
  let brokenManagerReferences = [];
  if (uniqMgrRaw.length) {
    const oidList = uniqMgrRaw.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    const mgrDocs = oidList.length ? await User.find({ _id: { $in: oidList } }).select('isActive isDeleted').lean() : [];
    const mgrValid = new Set(mgrDocs.filter((m) => m.isActive && m.isDeleted !== true).map((m) => String(m._id)));
    brokenManagerReferences = usersWithMgr
      .filter((u) => !mgrValid.has(String(u.managerId)))
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }));
  }

  const staleBefore = new Date(Date.now() - STALE_APPROVAL_MS);
  const overdueApprovals = await AttendanceRequest.countDocuments({
    companyId: cid,
    status: ATTENDANCE_REQUEST_STATUS.PENDING,
    isDeleted: { $ne: true },
    createdAt: { $lt: staleBefore }
  });

  return {
    attendanceSettingsOn: {
      trackingAudit: flags.attendanceGovernanceEnabled,
      schedules: flags.attendancePoliciesEnabled,
      requestsApprovals: flags.attendanceApprovalsEnabled
    },
    coverage: {
      totalActiveEmployees: activeUsers.length,
      employeesWithoutManager: withoutManager,
      employeesWithoutSchedule: withoutSchedule,
      orphanedSchedules: orphanedShifts,
      duplicateApprovalFlows,
      overduePendingApprovals: overdueApprovals,
      staleHoursThreshold: STALE_APPROVAL_MS / 3600000,
      operations: {
        openRequestsTotal: openReqs.length,
        openRequestsSlaBreached,
        openRequestsAdminQueue,
        openRequestsEscalatedStatus,
        openRequestsPendingLateArrival,
        openRequestsLastTouchAutomatic,
        managerApprovalLoads,
        duplicateShiftTimings,
        duplicatePoliciesSameShift,
        companyWideFallbackCount,
        staleDelegations,
        brokenManagerReferences
      }
    }
  };
};

module.exports = { getSummary };
