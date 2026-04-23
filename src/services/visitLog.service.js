const VisitLog = require('../models/VisitLog');
const Doctor = require('../models/Doctor');
const ApiError = require('../utils/ApiError');
const attendanceService = require('./attendance.service');
const auditService = require('./audit.service');

const createUnplanned = async (companyId, body, reqUser) => {
  const { doctorId, notes, orderTaken, location, visitTime, checkInTime, checkOutTime } = body;
  if (!doctorId) throw new ApiError(400, 'Doctor is required for an unplanned visit');

  const doctor = await Doctor.findOne({ _id: doctorId, companyId, isActive: true, isDeleted: { $ne: true } });
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const vt = visitTime ? new Date(visitTime) : new Date();
  await attendanceService.assertEmployeePresentForVisitDate(companyId, reqUser.userId, vt);

  const doc = await VisitLog.create({
    companyId,
    planItemId: null,
    employeeId: reqUser.userId,
    doctorId,
    visitTime: vt,
    checkInTime: checkInTime ? new Date(checkInTime) : undefined,
    checkOutTime: checkOutTime ? new Date(checkOutTime) : undefined,
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

  return VisitLog.findById(doc._id).populate('doctorId', 'name specialization').lean();
};

module.exports = { createUnplanned };
