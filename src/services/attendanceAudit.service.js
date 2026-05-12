const AttendanceAuditEvent = require('../models/AttendanceAuditEvent');

/**
 * Non-blocking attendance-specific audit trail.
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId} params.companyId
 * @param {import('mongoose').Types.ObjectId|null} params.attendanceId
 * @param {import('mongoose').Types.ObjectId|null} params.actorUserId - null for system
 * @param {'USER'|'ADMIN'|'SYSTEM'} params.source
 * @param {string} params.action
 * @param {object} [params.before]
 * @param {object} [params.after]
 * @param {object} [params.meta]
 */
const log = async (params) => {
  try {
    await AttendanceAuditEvent.create(params);
  } catch (err) {
    console.error('AttendanceAuditEvent error:', err.message);
  }
};

module.exports = { log };
