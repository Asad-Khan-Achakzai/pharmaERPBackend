const mongoose = require('mongoose');
const businessTime = require('../../utils/businessTime');

function buildContextSummary(ctx) {
  const cc = ctx.clientContext || {};
  return {
    userId: String(ctx.userId),
    userName: ctx.user?.name,
    role: ctx.user?.role,
    roleCode: ctx.user?.roleCode || ctx.user?.resolvedRole?.code,
    companyId: String(ctx.companyId),
    companyName: ctx.company?.name,
    timeZone: ctx.timeZone,
    businessDate: businessTime.nowInBusinessTime(ctx.timeZone).toFormat('yyyy-MM-dd'),
    screen: cc.screen || null,
    selectedDoctorId: cc.selectedDoctorId || null,
    selectedPharmacyId: cc.selectedPharmacyId || null
  };
}

function validateClientContext(ctx) {
  const cc = { ...(ctx.clientContext || {}) };
  for (const key of ['selectedDoctorId', 'selectedPharmacyId']) {
    if (cc[key] && !mongoose.Types.ObjectId.isValid(cc[key])) {
      delete cc[key];
    }
  }
  if (cc.screen) cc.screen = String(cc.screen).slice(0, 120);
  return { ...ctx, clientContext: cc };
}

module.exports = { buildContextSummary, validateClientContext };
