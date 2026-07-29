#!/usr/bin/env node
/**
 * AR document-allocation migration (enterprise Option B).
 *
 * Rebuilds ReturnRecord.allocations + Collection.allocations via chronological replay.
 * Does NOT rewrite ledger amounts, clearing amounts, or settlements.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/migrateArDocumentAllocations.js
 *   DRY_RUN=0 node scripts/migrateArDocumentAllocations.js
 *   COMPANY_ID=... PHARMACY_ID=... DRY_RUN=1 node scripts/migrateArDocumentAllocations.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { roundPKR } = require('../src/utils/currency');
const arDocumentOpen = require('../src/services/arDocumentOpen.service');
const ReturnRecord = require('../src/models/ReturnRecord');
const Collection = require('../src/models/Collection');
const Pharmacy = require('../src/models/Pharmacy');
const ArAllocationMigrationLog = require('../src/models/ArAllocationMigrationLog');
const { INVARIANT_EPS } = require('../src/constants/arArchitecture');

/** Allow up to ₨1 for historical delivery↔ledger paisa drift during migration gates. */
const MIGRATION_EPS = Math.max(INVARIANT_EPS, 1);

const DRY = process.env.DRY_RUN !== '0' && process.env.DRY_RUN !== 'false';
const COMPANY_ID = process.env.COMPANY_ID || null;
const PHARMACY_ID = process.env.PHARMACY_ID || null;

async function applyPlans(replay) {
  for (const plan of replay.returnPlans) {
    await ReturnRecord.updateOne(
      { _id: plan.returnId },
      {
        $set: {
          allocations: plan.after.map((a) => ({
            deliveryId: new mongoose.Types.ObjectId(a.deliveryId),
            amount: roundPKR(a.amount)
          }))
        }
      }
    );
  }
  for (const plan of replay.collectionPlans) {
    await Collection.updateOne(
      { _id: plan.collectionId },
      {
        $set: {
          allocations: plan.after.map((a) => ({
            deliveryId: new mongoose.Types.ObjectId(a.deliveryId),
            orderId: a.orderId ? new mongoose.Types.ObjectId(a.orderId) : undefined,
            distributorId: a.distributorId
              ? new mongoose.Types.ObjectId(a.distributorId)
              : undefined,
            amount: roundPKR(a.amount)
          }))
        }
      }
    );
  }
}

async function migratePharmacy(companyId, pharmacyId, migrationRunId) {
  const replay = await arDocumentOpen.replayPharmacyAllocations(companyId, pharmacyId, null);

  const invariantsOk =
    replay.exceptions.length === 0 &&
    Math.abs(replay.pharmacyOpen - replay.ledgerNet) <= MIGRATION_EPS;

  let applied = false;
  if (!DRY && invariantsOk) {
    await applyPlans(replay);
    applied = true;
  }

  await ArAllocationMigrationLog.create({
    companyId,
    pharmacyId,
    migrationRunId,
    dryRun: DRY,
    applied,
    invariantsOk,
    pharmacyOpen: replay.pharmacyOpen,
    ledgerNet: replay.ledgerNet,
    exceptions: replay.exceptions,
    returnPlans: replay.returnPlans.map((p) => ({
      returnId: String(p.returnId),
      before: p.before,
      after: p.after,
      leftover: p.leftover
    })),
    collectionPlans: replay.collectionPlans.map((p) => ({
      collectionId: String(p.collectionId),
      before: p.before,
      after: p.after,
      leftover: p.leftover
    })),
    error: invariantsOk ? null : 'INVARIANT_FAILED_OR_EXCEPTIONS'
  });

  return {
    pharmacyId: String(pharmacyId),
    applied,
    invariantsOk,
    pharmacyOpen: replay.pharmacyOpen,
    ledgerNet: replay.ledgerNet,
    exceptions: replay.exceptions,
    changedReturns: replay.returnPlans.filter(
      (p) => JSON.stringify(p.before) !== JSON.stringify(p.after)
    ).length,
    changedCollections: replay.collectionPlans.filter(
      (p) => JSON.stringify(p.before) !== JSON.stringify(p.after)
    ).length
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  await mongoose.connect(uri);

  const migrationRunId = `ar-alloc-${new Date().toISOString()}`;
  console.log(JSON.stringify({ migrationRunId, dryRun: DRY, COMPANY_ID, PHARMACY_ID }, null, 2));

  const pharmacyFilter = { isDeleted: { $ne: true } };
  if (COMPANY_ID) pharmacyFilter.companyId = new mongoose.Types.ObjectId(COMPANY_ID);
  if (PHARMACY_ID) pharmacyFilter._id = new mongoose.Types.ObjectId(PHARMACY_ID);

  const pharmacies = await Pharmacy.find(pharmacyFilter).select('_id companyId name').lean();
  const results = [];
  const failed = [];

  for (const p of pharmacies) {
    try {
      const r = await migratePharmacy(p.companyId, p._id, migrationRunId);
      results.push({ name: p.name, ...r });
      if (!r.invariantsOk) {
        failed.push({ name: p.name, pharmacyId: r.pharmacyId, exceptions: r.exceptions });
      }
      console.log(
        `${r.invariantsOk ? 'OK' : 'FAIL'} ${p.name} open=${r.pharmacyOpen} ledger=${r.ledgerNet} applied=${r.applied} Δret=${r.changedReturns} Δcol=${r.changedCollections}`
      );
    } catch (err) {
      failed.push({ name: p.name, pharmacyId: String(p._id), error: err.message });
      await ArAllocationMigrationLog.create({
        companyId: p.companyId,
        pharmacyId: p._id,
        migrationRunId,
        dryRun: DRY,
        applied: false,
        invariantsOk: false,
        error: err.message
      });
      console.error(`ERROR ${p.name}: ${err.message}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        summary: {
          pharmacies: pharmacies.length,
          ok: results.filter((r) => r.invariantsOk).length,
          failed: failed.length,
          applied: results.filter((r) => r.applied).length,
          dryRun: DRY
        },
        failed
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
