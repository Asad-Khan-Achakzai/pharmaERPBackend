/**
 * Idempotent: seeds DEFAULT_ADMIN / DEFAULT_MEDICAL_REP per company; assigns user.roleId from user.role.
 * Run: node scripts/migrateRbacDefaultRoles.js
 * Env: MONGODB_URI
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const User = require('../src/models/User');
const { seedDefaultRolesForCompany } = require('../src/services/role.service');
const { ROLES } = require('../src/constants/enums');

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const companies = await Company.find({ isDeleted: { $ne: true } }).lean();
  let n = 0;
  for (const c of companies) {
    const { adminRole, medicalRole } = await seedDefaultRolesForCompany(c._id, {});
    const users = await User.find({ companyId: c._id, isDeleted: { $ne: true } });
    for (const u of users) {
      if (u.roleId) continue;
      if (u.role === ROLES.SUPER_ADMIN) continue;
      if (u.role === ROLES.ADMIN) {
        u.roleId = adminRole._id;
        u.permissions = [];
      } else {
        u.roleId = medicalRole._id;
      }
      await u.save();
      n += 1;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`Updated ${n} user(s) across ${companies.length} company/companies.`);
  await mongoose.disconnect();
};

run().catch((e) => {
  process.stderr.write(e.stack || e.message);
  process.exit(1);
});
