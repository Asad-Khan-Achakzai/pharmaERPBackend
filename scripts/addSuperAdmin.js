#!/usr/bin/env node
/**
 * Idempotent: adds one SUPER_ADMIN user for testing without dropping the database.
 *
 * Usage (from pharma/backend):
 *   node scripts/addSuperAdmin.js
 *
 * Env (optional):
 *   MONGODB_URI          — default mongodb://localhost:27017/pharma_erp
 *   SUPER_ADMIN_EMAIL    — default superadmin@platform.local
 *   SUPER_ADMIN_PASSWORD — default Super@123
 *   SUPER_ADMIN_NAME     — default Super Admin
 *
 * Creates a small "Platform Administration" company if missing, sets home companyId there,
 * and sets activeCompanyId to your first existing tenant company so the app works immediately.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const User = require('../src/models/User');
const { ROLES } = require('../src/constants/enums');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pharma_erp';
const EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@platform.local').toLowerCase().trim();
const PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Super@123';
const NAME = process.env.SUPER_ADMIN_NAME || 'Super Admin';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected:', MONGODB_URI);

  const existingSa = await User.findOne({ email: EMAIL });
  if (existingSa) {
    if (existingSa.role === ROLES.SUPER_ADMIN) {
      console.log(`User already exists: ${EMAIL} (SUPER_ADMIN). No changes.`);
      await mongoose.disconnect();
      process.exit(0);
    }
    console.error(
      `A user with email ${EMAIL} already exists with role ${existingSa.role}. ` +
        'Use a different SUPER_ADMIN_EMAIL or remove/rename that user first.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  let platformCo = await Company.findOne({ email: 'platform.internal@local' });
  if (!platformCo) {
    platformCo = await Company.create({
      name: 'Platform Administration',
      address: 'Internal',
      city: '—',
      state: '—',
      country: 'Pakistan',
      phone: '—',
      email: 'platform.internal@local',
      currency: 'PKR',
      isActive: true
    });
    console.log('Created platform company:', platformCo._id.toString());
  } else {
    console.log('Using existing platform company:', platformCo._id.toString());
  }

  const tenant = await Company.findOne({
    _id: { $ne: platformCo._id },
    isDeleted: { $ne: true }
  }).sort({ createdAt: 1 });

  if (!tenant) {
    console.error(
      'No tenant company found (besides platform). Create a company first (e.g. register via /auth/register), then run this script again.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  await User.create({
    companyId: platformCo._id,
    activeCompanyId: tenant._id,
    name: NAME,
    email: EMAIL,
    password: PASSWORD,
    role: ROLES.SUPER_ADMIN,
    phone: '+92-300-0000000',
    permissions: [],
    isActive: true
  });

  console.log('');
  console.log('SUPER_ADMIN created successfully.');
  console.log('  Email:   ', EMAIL);
  console.log('  Password:', PASSWORD);
  console.log('  Operating company (activeCompanyId):', tenant.name, `(${tenant._id})`);
  console.log('');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
