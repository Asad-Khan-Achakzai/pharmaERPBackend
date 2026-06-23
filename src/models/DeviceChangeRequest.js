const mongoose = require('mongoose');
const { DEVICE_CHANGE_REQUEST_STATUS } = require('../constants/enums');

/**
 * A field-force rep's request to move their device binding to a new device.
 * Created from the mobile "device not registered" screen (authenticated with a
 * short-lived device-change token). An admin approves (→ rebinds + revokes old
 * sessions) or rejects. Only one PENDING request per user at a time.
 */
const requestedDeviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, trim: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], default: null },
    brand: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: null },
    osVersion: { type: String, trim: true, default: null },
    appVersion: { type: String, trim: true, default: null }
  },
  { _id: false }
);

const deviceChangeRequestSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    /** Device the user is currently bound to (null if they had none). */
    currentDeviceId: { type: String, trim: true, default: null },
    /** Device requesting access. */
    requestedDeviceId: { type: String, required: true, trim: true },
    requestedDevice: { type: requestedDeviceSchema, required: true },
    status: {
      type: String,
      enum: Object.values(DEVICE_CHANGE_REQUEST_STATUS),
      default: DEVICE_CHANGE_REQUEST_STATUS.PENDING,
      index: true
    },
    /** Optional user-provided note explaining the change. */
    reason: { type: String, trim: true, maxlength: 500, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    /** Optional admin note (e.g. rejection reason). */
    decisionNote: { type: String, trim: true, maxlength: 500, default: null }
  },
  { timestamps: true }
);

// At most one PENDING request per user per company.
deviceChangeRequestSchema.index(
  { companyId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: DEVICE_CHANGE_REQUEST_STATUS.PENDING }
  }
);
deviceChangeRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('DeviceChangeRequest', deviceChangeRequestSchema);
