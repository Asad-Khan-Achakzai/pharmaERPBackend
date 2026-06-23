const mongoose = require('mongoose');
const { DEVICE_BINDING_SOURCE } = require('../constants/enums');

/**
 * The single source of truth for "which mobile device is this field-force rep
 * allowed to use" when Company.deviceControlEnabled is true. Exactly one active
 * binding per (companyId, userId). The bound device survives logout — only an
 * admin-approved device change or force-revoke can move the binding.
 *
 * This is intentionally separate from `DeviceSession` (which tracks live refresh
 * tokens and can have many rows). Binding = policy; DeviceSession = sessions.
 */
const mobileDeviceBindingSchema = new mongoose.Schema(
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
    /** The currently bound device UUID (matches DeviceSession.deviceId / X-Device-Id). */
    deviceId: { type: String, required: true, trim: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], default: null },
    brand: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: null },
    osVersion: { type: String, trim: true, default: null },
    appVersion: { type: String, trim: true, default: null },
    boundAt: { type: Date, default: Date.now },
    boundBy: {
      type: String,
      enum: Object.values(DEVICE_BINDING_SOURCE),
      default: DEVICE_BINDING_SOURCE.FIRST_LOGIN
    },
    /** Admin user id when boundBy is ADMIN_APPROVAL / ADMIN_FORCE. */
    boundByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastSeenAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// One active binding per user per company.
mobileDeviceBindingSchema.index({ companyId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('MobileDeviceBinding', mobileDeviceBindingSchema);
