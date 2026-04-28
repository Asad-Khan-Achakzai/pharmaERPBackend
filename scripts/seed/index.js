#!/usr/bin/env node
/**
 * Primary database seed orchestrator — multi-tenant RBAC demos (Super Admin vs Platform Admin vs tenants).
 *
 * Usage (from pharmaERPBackend):
 *   node scripts/seed/index.js [--drop]
 *
 * Default: drops all MongoDB collections when --drop passed (recommended for repeatable runs).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Models = require('../../src/models');
const { seedTenantGraph } = require('./phases/tenantBootstrap');
const { seedCompanyOperationalBundle, createRng } = require('./lib/companyOperationalBundle');
const { seedFieldAndAncillary } = require('./phases/fieldAndAncillary');

const USAGE = `
PharmaERP seed orchestrator

  node scripts/seed/index.js --drop       # truncate all collections then seed fully
`;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pharma_erp';

async function dropAllCollections() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const col of collections) {
    await mongoose.connection.db.dropCollection(col.name);
  }
}

async function countModel(Model) {
  return Model.countDocuments();
}

async function summarize() {
  const keys = Object.keys(Models).filter((k) => k !== '_id');
  const counts = {};
  await Promise.all(
    keys.map(async (k) => {
      counts[k] = await countModel(Models[k]);
    })
  );

  console.log('\n================ COLLECTION DOCUMENT COUNTS ================');
  for (const k of keys.sort()) {
    const n = counts[k];
    console.log(`${k.padEnd(22)}: ${typeof n === 'number' ? n : '?'}`);
  }
}

async function run() {
  const shouldDrop = process.argv.includes('--drop');
  if (!shouldDrop && process.argv[2]) {
    console.log(USAGE);
    console.warn('[seed] Passing flags without effect. Use --drop to reset all collections.');
  }

  console.log('[seed] Connecting', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);

  const existingUsers = await Models.User.countDocuments();
  if (existingUsers > 0 && !shouldDrop) {
    console.error(
      `[seed] Refusing: ${existingUsers} user(s) exist. Re-run with --drop for a clean seed, ` +
        'or use an empty MongoDB database.'
    );
    await mongoose.disconnect();
    process.exit(2);
  }

  if (shouldDrop) {
    await dropAllCollections();
    console.log('[seed] All collections dropped');
  }

  const { platformCompany, superAdmin, platformAdmin, tenantDocs } = await seedTenantGraph();

  /** @type {object[]} */
  const reportOps = [];

  for (const b of tenantDocs) {
    const { tenantMeta, company, admin, medicalReps } = b;
    if (!medicalReps?.length) {
      throw new Error(`[seed] No medical reps for ${company.name} — operational bundle blocked`);
    }
    const rng = createRng(88010 + tenantMeta.index * 1337);
    console.log(`[seed] Operational load ${company.name} (${tenantMeta.userTarget} users)...`);
    const ops = await seedCompanyOperationalBundle({
      rng,
      code: tenantMeta.code,
      index: tenantMeta.index,
      company,
      admin,
      reps: medicalReps,
      dimensions: tenantMeta.ops
    });
    const fieldCounts = await seedFieldAndAncillary({
      company,
      admin,
      ops,
      medicalReps,
      cfg: tenantMeta.ops
    });
    reportOps.push({
      tenant: tenantMeta.key,
      company: company.name,
      counts: { ...ops.counts, ...fieldCounts }
    });
  }

  console.log('\n================ SEED LOGIN (rotate in production) ===========');
  console.log('Platform company id', String(platformCompany._id));
  console.log('');
  console.log(`Super Admin        ${superAdmin.email} / ... (env SEED_SUPER_ADMIN_PASSWORD or Super@123)`);
  console.log(`Platform Admin     ${platformAdmin.email} / ... (env SEED_PLATFORM_ADMIN_PASSWORD or Platform@123)`);
  console.log('');
  for (const b of tenantDocs) {
    const a = b.admin.email;
    console.log(`Tenant ${b.tenantMeta.key}: administrator ${a} / Admin@123`);
    console.log(`  users: ${b.users.length} (including primary admin)`);
  }

  console.log('\n================ OPERATIONAL BUNDLE SUMMARY ================');
  for (const r of reportOps) {
    console.log('');
    console.log(r.tenant, r.company);
    Object.entries(r.counts || {}).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  }

  await summarize();

  console.log('\nDone. Disconnect.');
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[seed failed]', e);
    process.exit(1);
  });
}

module.exports = { run };
