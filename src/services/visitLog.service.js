const VisitLog = require('../models/VisitLog');
const Doctor = require('../models/Doctor');
const ApiError = require('../utils/ApiError');
const { DateTime } = require('luxon');
const businessTime = require('../utils/businessTime');
const attendanceService = require('./attendance.service');
const auditService = require('./audit.service');

const createUnplanned = async (companyId, body, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { doctorId, notes, orderTaken, location, visitTime, checkInTime, checkOutTime } = body;
  if (!doctorId) throw new ApiError(400, 'Doctor is required for an unplanned visit');

  const doctor = await Doctor.findOne({ _id: doctorId, companyId, isActive: true, isDeleted: { $ne: true } });
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const vt = visitTime
    ? DateTime.fromISO(String(visitTime), { zone: 'utc' }).toJSDate()
    : businessTime.utcNow();
  if (visitTime && Number.isNaN(vt.getTime())) throw new ApiError(400, 'Invalid visitTime');

  await attendanceService.assertEmployeePresentForVisitDate(companyId, reqUser.userId, vt, tz);

  const parseOpt = (x) => {
    if (x == null || x === '') return undefined;
    const d = DateTime.fromISO(String(x), { zone: 'utc' });
    if (!d.isValid) throw new ApiError(400, 'Invalid date');
    return d.toJSDate();
  };

  const doc = await VisitLog.create({
    companyId,
    planItemId: null,
    employeeId: reqUser.userId,
    doctorId,
    visitTime: vt,
    checkInTime: parseOpt(checkInTime),
    checkOutTime: parseOpt(checkOutTime),
    location:
      location?.lat != null && location?.lng != null ? { lat: location.lat, lng: location.lng } : undefined,
    notes,
    orderTaken: Boolean(orderTaken),
    createdBy: reqUser.userId
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'visit.unplanned',
    entityType: 'VisitLog',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });

  return doc;
};

module.exports = { createUnplanned };
