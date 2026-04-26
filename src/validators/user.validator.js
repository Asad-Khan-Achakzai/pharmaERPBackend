const Joi = require('joi');
const { ROLES } = require('../constants/enums');
const { ALL_PERMISSIONS } = require('../constants/permissions');

/** Roles creatable/updatable by tenant admins (not platform SUPER_ADMIN). */
const TENANT_ROLES = [ROLES.ADMIN, ROLES.MEDICAL_REP];

const createUserSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  email: Joi.string().email().required().trim(),
  password: Joi.string().required().min(6).max(128),
  /** When set, server derives `role` from this Role and ignores `permissions`. */
  roleId: Joi.string().hex().length(24).allow(null, ''),
  role: Joi.string().valid(...TENANT_ROLES),
  phone: Joi.string().trim().allow(''),
  /** Ignored when roleId is set (server uses role.permissions only). */
  permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).default([]),
  isActive: Joi.boolean().default(true)
}).custom((obj, helpers) => {
  const hasRoleId = obj.roleId && String(obj.roleId).length === 24;
  if (!hasRoleId && !obj.role) {
    return helpers.error('any.custom', { message: 'Either roleId or role is required' });
  }
  return obj;
});

const updateUserSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  email: Joi.string().email().trim(),
  phone: Joi.string().trim().allow(''),
  password: Joi.string().min(6).max(128).allow('', null),
  roleId: Joi.string().hex().length(24).allow(null, ''),
  role: Joi.string().valid(...TENANT_ROLES),
  permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)),
  isActive: Joi.boolean()
}).min(1);

module.exports = { createUserSchema, updateUserSchema };
