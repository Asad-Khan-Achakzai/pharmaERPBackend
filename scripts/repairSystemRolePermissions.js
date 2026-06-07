/**
 * Backfill missing permissions on DEFAULT_MEDICAL_REP / DEFAULT_ASM / DEFAULT_RM system roles.
 * Safe to run multiple times — only adds permissions from canonical defaults, never removes.
 *
 * Run: node scripts/repairSystemRolePermissions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const { seedDefaultRolesForCompany } = require('../src/services/role.service');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  const companies = await Company.find({ isDeleted: { $ne: true } }).select('_id name').lean();
  for (const c of companies) {
    await seedDefaultRolesForCompany(c._id);
    console.log(`Repaired system roles for ${c.name}`);
  }
  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
