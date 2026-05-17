const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const MedRepTarget = require('../models/MedRepTarget');
const { requireCompanyIanaZone, coalesceBusinessDateRangeFromYmd } = require('../utils/businessTime');
const { computeDashboardNetGrossSalesTp } = require('./tpSalesRollup.service');

const toOid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * UTC range for a calendar month in company TZ (aligned with MRep month keys / dashboard).
 */
const monthCalendarUtcRange = (yyyyMm, tz) => {
  const zone = requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  const fromYmd = startLocal.toFormat('yyyy-MM-dd');
  const toYmd = endLocal.toFormat('yyyy-MM-dd');
  return coalesceBusinessDateRangeFromYmd(fromYmd, toYmd, zone);
};

const computeAchievedTpForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const range = monthCalendarUtcRange(yyyyMm, tz);
  return computeDashboardNetGrossSalesTp(toOid(companyId), range, toOid(repId));
};

const syncAchievedSalesTpForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const achieved = await computeAchievedTpForRepMonth(companyId, repId, yyyyMm, tz);
  await MedRepTarget.updateOne(
    {
      companyId: toOid(companyId),
      medicalRepId: toOid(repId),
      month: yyyyMm,
      isDeleted: { $ne: true }
    },
    { $set: { achievedSales: achieved } }
  );
  return achieved;
};

module.exports = {
  monthCalendarUtcRange,
  computeAchievedTpForRepMonth,
  syncAchievedSalesTpForRepMonth
};
