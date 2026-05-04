const mongoose = require('mongoose');
const Company = require('../../../src/models/Company');
const User = require('../../../src/models/User');
const Role = require('../../../src/models/Role');
const UserCompanyAccess = require('../../../src/models/UserCompanyAccess');
const { ROLES, USER_TYPES } = require('../../../src/constants/enums');
const { seedDefaultRolesForCompany } = require('../../../src/services/role.service');
const { LARGE_CUSTOM, MEDIUM_CUSTOM, SMALL_CUSTOM } = require('../lib/roleDefinitions');
const {
  DEFAULT_SUPER_ADMIN_EMAIL,
  DEFAULT_SUPER_ADMIN_PASSWORD,
  PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_PASSWORD,
  SCALE
} = require('../config');

const TENANTS = [
  { key: 'aurora', name: 'Aurora Pharma Distribution', city: 'Karachi', code: 'AUR', index: 0, ...SCALE.large },
  { key: 'breeze', name: 'Breeze Healthcare Supply', city: 'Lahore', code: 'BRE', index: 1, ...SCALE.medium },
  { key: 'citrus', name: 'Citrus Medica Ltd', city: 'Islamabad', code: 'CIT', index: 2, ...SCALE.small }
];

function em(local) {
  return String(local).toLowerCase().trim();
}

async function syncUserCompanyAccess(userId, companyObjectIds) {
  const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId));
  const cids = companyObjectIds.map((c) =>
    c instanceof mongoose.Types.ObjectId ? c : new mongoose.Types.ObjectId(String(c))
  );
  await UserCompanyAccess.updateMany({ userId: uid, companyId: { $nin: cids } }, { $set: { status: 'revoked' } });
  for (const cid of cids) {
    await UserCompanyAccess.findOneAndUpdate(
      { userId: uid, companyId: cid },
      { $set: { status: 'active' } },
      { upsert: true }
    );
  }
}

async function createCustomRoles(companyId, defs) {
  const out = [];
  for (const def of defs) {
    let r = await Role.findOne({ companyId, code: def.code });
    if (!r) {
      r = await Role.create({
        companyId,
        name: def.name,
        code: def.code,
        permissions: def.permissions,
        isSystem: false
      });
    }
    out.push(r);
  }
  return out;
}

function rid(r, code) {
  const x = r.find((role) => role.code === code);
  if (!x) throw new Error(`Missing Role ${code}`);
  return x._id;
}

/**
 * Rows for users *other* than the primary company Administrator (already created).
 * Uses `ADMIN` enum for office/manager personas; field roles use `MEDICAL_REP`.
 */
function extraUserRows(tenant, adminRoleId, medicalRoleId, R) {
  const slug = tenant.key;
  const userTarget = tenant.userTarget ?? 50;

  /** @type {{email:string, password?:string, role:string, roleId:any}[]} */
  const rows = [];

  const pushRep = (i) => {
    rows.push({
      email: em(`rep.${String(i).padStart(4, '0')}.${slug}@seed.pharmaerp.test`),
      password: 'Rep@1234',
      role: ROLES.MEDICAL_REP,
      roleId: medicalRoleId
    });
  };

  const pushDesk = (suffix, ridVal, pwd = 'Rep@1234') => {
    rows.push({
      email: em(`${suffix}.${slug}@seed.pharmaerp.test`),
      password: pwd,
      role: ROLES.ADMIN,
      roleId: ridVal
    });
  };

  const pushField = (suffix, ridVal) => {
    rows.push({
      email: em(`${suffix}.${slug}@seed.pharmaerp.test`),
      password: 'Rep@1234',
      role: ROLES.MEDICAL_REP,
      roleId: ridVal
    });
  };

  const extrasBudget = Math.max(0, userTarget - 1);

  if (tenant.key === 'aurora') {
    pushDesk('admin.secondary', adminRoleId, 'Admin@123');
    for (let m = 0; m < 4; m += 1) pushDesk(`mgr.regional.${m + 1}`, rid(R, 'REGION_MANAGER'));
    pushDesk('desk.inv', rid(R, 'INV_COORD'));
    pushDesk('desk.finance', rid(R, 'FIN_READONLY'));
    pushDesk('desk.hr', rid(R, 'HR_PAYROLL_COORD'));
    pushDesk('desk.dist', rid(R, 'DIST_OPS'));
    pushDesk('desk.qa', rid(R, 'QUALITY_FIELD'));
    pushField('field.sales.lead', rid(R, 'SALES_TEAM_LEAD'));
    pushField('field.rep.focused', rid(R, 'MED_REP_FOCUSED'));
    const used = rows.length;
    const repCount = Math.max(5, extrasBudget - used);
    for (let i = 1; i <= repCount; i += 1) pushRep(i);
    return rows.slice(0, extrasBudget);
  }

  if (tenant.key === 'breeze') {
    for (let m = 0; m < 3; m += 1) pushDesk(`mgr.area.${m + 1}`, rid(R, 'AREA_MANAGER'));
    pushDesk('desk.inv', rid(R, 'INV_LEAD_MEDIUM'));
    pushField('field.retail', rid(R, 'RETAIL_EXEC'));
    const used = rows.length;
    const repCount = Math.max(3, extrasBudget - used);
    for (let i = 1; i <= repCount; i += 1) pushRep(i);
    return rows.slice(0, extrasBudget);
  }

  /** small */
  pushDesk('team.manager', rid(R, 'TEAM_MANAGER'));
  const used = rows.length;
  const repCount = Math.max(1, extrasBudget - used);
  for (let i = 1; i <= repCount; i += 1) pushRep(i);
  return rows.slice(0, extrasBudget);
}

/**
 * @returns {Promise<{ platformCompany: any, superAdmin: any, platformAdmin: any, tenantDocs: any[] }>}
 */
async function seedTenantGraph() {
  const platformCompany = await Company.create({
    name: 'Platform Administration',
    address: 'Internal',
    city: 'Lahore',
    state: 'Punjab',
    country: 'Pakistan',
    phone: '+92-300-0000000',
    email: 'platform.internal@local',
    currency: 'PKR',
    timeZone: 'Asia/Karachi',
    isActive: true
  });

  const tenantDocs = [];
  for (const t of TENANTS) {
    const c = await Company.create({
      name: t.name,
      address: `${20 + t.index} Main Commercial Road`,
      city: t.city,
      state: 'Punjab',
      country: 'Pakistan',
      phone: `+92-3${t.index}0-100200${t.index}`,
      email: `ops.${t.key}@seed.pharmaerp.test`,
      currency: 'PKR',
      timeZone: 'Asia/Karachi',
      cashOpeningBalance: t.index === 0 ? 520000 : 260000,
      isActive: true
    });
    const { adminRole, medicalRole } = await seedDefaultRolesForCompany(c._id, {});

    let customDefs = SMALL_CUSTOM;
    if (t.key === 'aurora') customDefs = LARGE_CUSTOM;
    else if (t.key === 'breeze') customDefs = MEDIUM_CUSTOM;

    const customRoles = await createCustomRoles(c._id, customDefs);

    const admin = await User.create({
      companyId: c._id,
      name: `${t.code} Primary Administrator`,
      email: em(`admin.primary.${t.key}@seed.pharmaerp.test`),
      password: 'Admin@123',
      role: ROLES.ADMIN,
      roleId: adminRole._id,
      userType: USER_TYPES.COMPANY,
      phone: `+92-300-101${t.index}${t.index}${t.index}`,
      permissions: []
    });

    const plan = extraUserRows(t, adminRole._id, medicalRole._id, customRoles);

    const users = [admin];
    let seq = 0;
    for (const row of plan) {
      seq += 1;
      users.push(
        await User.create({
          companyId: c._id,
          name: `${t.code} ${String(seq).padStart(3, '0')}`,
          email: row.email,
          password: row.password || 'Rep@1234',
          role: row.role,
          roleId: row.roleId,
          userType: USER_TYPES.COMPANY,
          phone: `+92-321-${seq}${seq}${seq}${seq}${seq}${seq}${seq}`,
          permissions: [],
          createdBy: admin._id
        })
      );
    }

    const medicalReps = users.filter((u) => u.role === ROLES.MEDICAL_REP);

    tenantDocs.push({
      tenantMeta: t,
      company: c,
      admin,
      adminRole,
      medicalRole,
      customRoles,
      users,
      medicalReps
    });
  }

  const [firstTenant] = tenantDocs;

  const superAdmin = await User.create({
    companyId: platformCompany._id,
    activeCompanyId: firstTenant.company._id,
    name: 'Super Admin',
    email: em(DEFAULT_SUPER_ADMIN_EMAIL),
    password: DEFAULT_SUPER_ADMIN_PASSWORD,
    role: ROLES.SUPER_ADMIN,
    userType: USER_TYPES.COMPANY,
    phone: '+92-300-9999001',
    permissions: [],
    isActive: true
  });

  const homeCompanyId = tenantDocs[0].company._id;
  const { adminRole: homeAdminRole } = await seedDefaultRolesForCompany(homeCompanyId, {});

  const tenantIds = tenantDocs.map((d) => d.company._id);

  const platformAdmin = await User.create({
    companyId: homeCompanyId,
    userType: USER_TYPES.PLATFORM,
    name: 'Platform Administrator',
    email: em(PLATFORM_ADMIN_EMAIL),
    password: PLATFORM_ADMIN_PASSWORD,
    role: ROLES.ADMIN,
    roleId: homeAdminRole._id,
    activeCompanyId: tenantIds[0],
    phone: '+92-300-8888001',
    permissions: [],
    isActive: true
  });

  await syncUserCompanyAccess(platformAdmin._id, tenantIds);

  return { platformCompany, superAdmin, platformAdmin, tenantDocs };
}

module.exports = { seedTenantGraph, TENANTS };
