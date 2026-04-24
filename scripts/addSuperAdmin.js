#!/usr/bin/env node
/**
 * Idempotent: adds one SUPER_ADMIN user without dropping the database.
 *
 * Usage (from pharmaERPBackend):
 *   npm run add-super-admin
 *   node scripts/addSuperAdmin.js
 *
 * Env (optional):
 *   MONGODB_URI          — default mongodb://localhost:27017/pharma_erp
 *   SUPER_ADMIN_EMAIL    — default superadmin@platform.local
 *   SUPER_ADMIN_PASSWORD — default Super@123
 *   SUPER_ADMIN_NAME     — default Super Admin
 *
 * Creates a "Platform Administration" company if missing, and (if needed) a minimal
 * default tenant company so activeCompanyId is set for APIs (see companyScope middleware).
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

  const existing = await User.findOne({ companyId: platformCo._id, email: EMAIL });
  if (existing) {
    if (existing.role === ROLES.SUPER_ADMIN) {
      console.log(`User already exists: ${EMAIL} (SUPER_ADMIN). No changes.`);
      await mongoose.disconnect();
      process.exit(0);
    }
    console.error(
      `A user with email ${EMAIL} already exists on the platform company with role ${existing.role}. ` +
        'Use a different SUPER_ADMIN_EMAIL or remove that user first.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  let tenant = await Company.findOne({
    _id: { $ne: platformCo._id },
    isDeleted: { $ne: true }
  }).sort({ createdAt: 1 });

  if (!tenant) {
    tenant = await Company.create({
      name: 'Default tenant',
      address: '—',
      city: '—',
      state: '—',
      country: 'Pakistan',
      phone: '—',
      email: 'default.tenant@local',
      currency: 'PKR',
      isActive: true
    });
    console.log('Created default tenant company (no other company existed):', tenant._id.toString());
  } else {
    console.log('Using tenant for activeCompanyId:', tenant.name, `(${tenant._id})`);
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
