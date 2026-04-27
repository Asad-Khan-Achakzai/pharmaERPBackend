const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, USER_TYPES } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const userSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** COMPANY: home tenant. PLATFORM: primary/home company id; not used as active tenant for APIs. */
    userType: { type: String, enum: Object.values(USER_TYPES), default: USER_TYPES.COMPANY, index: true },
    /** For SUPER_ADMIN / legacy: last operating tenant; JWT is source of truth for active context. */
    activeCompanyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true },
    /** Company-scoped RBAC; when set, effective permissions come from Role only (see auth middleware). */
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, index: true },
    phone: { type: String, trim: true },
    /** Legacy; ignored for authorization when roleId is set. */
    permissions: [{ type: String }],
    isActive: { type: Boolean, default: true },
    refreshToken: { type: String, select: false },
    lastLoginAt: { type: Date },
    lastLoginIP: { type: String }
  },
  { timestamps: true }
);

/** Globally unique email — one login identity across all tenants (fixes multi-tenant login ambiguity). */
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ companyId: 1, role: 1, isActive: 1 });

userSchema.pre('save', async function (next) {
  if (this.isModified('email') && this.email) {
    this.email = String(this.email).toLowerCase().trim();
  }
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  return obj;
};

userSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('User', userSchema);
module.exports.USER_TYPES = USER_TYPES;
