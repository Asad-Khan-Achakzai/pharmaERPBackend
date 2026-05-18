const AuditLog = require('../models/AuditLog');

const normalizeEntityId = (value) => (value == null || value === '' ? null : value);

const log = async ({ companyId, userId, action, entityType, entityId, changes, ipAddress }) => {
  try {
    await AuditLog.create({
      companyId,
      userId,
      action,
      entityType,
      entityId: normalizeEntityId(entityId),
      changes,
      ipAddress
    });
  } catch (err) {
    // Audit logging should never break the main flow
    console.error('Audit log error:', err.message);
  }
};

const logInSession = async (session, { companyId, userId, action, entityType, entityId, changes, ipAddress }) => {
  await AuditLog.create(
    [
      {
        companyId,
        userId,
        action,
        entityType,
        entityId: normalizeEntityId(entityId),
        changes,
        ipAddress
      }
    ],
    { session, ordered: true }
  );
};

module.exports = { log, logInSession };
