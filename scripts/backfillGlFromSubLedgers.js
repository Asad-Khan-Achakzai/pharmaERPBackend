#!/usr/bin/env node
/**
 * Backfill GL vouchers from historical sub-ledger rows for companies that already have data.
 * Usage: node scripts/backfillGlFromSubLedgers.js [--companyId=<id>] [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Company = require('../src/models/Company');
const Ledger = require('../src/models/Ledger');
const SupplierLedger = require('../src/models/SupplierLedger');
const Collection = require('../src/models/Collection');
const Expense = require('../src/models/Expense');
const Voucher = require('../src/models/Voucher');
const coaSeed = require('../src/services/coaSeed.service');
const glBridge = require('../src/services/glBridge.service');
const {
  LEDGER_REFERENCE_TYPE,
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  SUPPLIER_LEDGER_TYPE
} = require('../src/constants/enums');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const companyArg = args.find((a) => a.startsWith('--companyId='));
const filterCompanyId = companyArg ? companyArg.split('=')[1] : null;

const nd = { isDeleted: { $ne: true } };

async function backfillCompany(companyId) {
  await coaSeed.ensureCoaForCompany(companyId);
  const stats = { deliveries: 0, collections: 0, purchases: 0, payments: 0, expenses: 0, skipped: 0 };

  const deliveries = await Ledger.find({
    companyId,
    entityType: LEDGER_ENTITY_TYPE.PHARMACY,
    type: LEDGER_TYPE.DEBIT,
    referenceType: LEDGER_REFERENCE_TYPE.DELIVERY,
    ...nd
  }).lean();

  for (const row of deliveries) {
    const exists = await Voucher.findOne({
      companyId,
      sourceModule: 'ORDER',
      sourceRefId: row.referenceId,
      ...nd
    });
    if (exists) {
      stats.skipped++;
      continue;
    }
    if (!dryRun) {
      await glBridge.postDeliveryGl(null, companyId, {
        pharmacyId: row.entityId,
        deliveryId: row.referenceId,
        pharmacyNetPayable: row.amount,
        date: row.date,
        ledgerEntryId: row._id,
        invoiceNumber: row.description
      }, { userId: null });
    }
    stats.deliveries++;
  }

  const collections = await Collection.find({ companyId, ...nd }).lean();
  for (const col of collections) {
    const exists = await Voucher.findOne({
      companyId,
      sourceModule: 'COLLECTION',
      sourceRefId: col._id,
      ...nd
    });
    if (exists) {
      stats.skipped++;
      continue;
    }
    if (!dryRun) {
      await glBridge.postCollectionGl(null, companyId, {
        collectionId: col._id,
        pharmacyId: col.pharmacyId,
        amount: col.amount,
        paymentMethod: col.paymentMethod,
        date: col.date
      }, { userId: null });
    }
    stats.collections++;
  }

  const purchases = await SupplierLedger.find({
    companyId,
    type: SUPPLIER_LEDGER_TYPE.PURCHASE,
    ...nd
  }).lean();
  for (const row of purchases) {
    const exists = await Voucher.findOne({
      companyId,
      sourceModule: 'PROCUREMENT',
      sourceRefId: row.referenceId,
      ...nd
    });
    if (exists) {
      stats.skipped++;
      continue;
    }
    if (!dryRun) {
      await glBridge.postPurchaseGl(null, companyId, {
        supplierId: row.supplierId,
        amount: row.amount,
        referenceId: row.referenceId,
        date: row.date,
        supplierLedgerEntryId: row._id
      }, { userId: null });
    }
    stats.purchases++;
  }

  const payments = await SupplierLedger.find({
    companyId,
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    ...nd
  }).lean();
  for (const row of payments) {
    const exists = await Voucher.findOne({
      companyId,
      sourceModule: 'SUPPLIER',
      sourceRefId: row._id,
      ...nd
    });
    if (exists) {
      stats.skipped++;
      continue;
    }
    if (!dryRun) {
      await glBridge.postSupplierPaymentGl(null, companyId, {
        supplierId: row.supplierId,
        amount: row.amount,
        paymentMethod: row.paymentMethod,
        date: row.date,
        supplierLedgerEntryId: row._id,
        voucherNumber: row.voucherNumber
      }, { userId: null });
    }
    stats.payments++;
  }

  const expenses = await Expense.find({ companyId, ...nd }).lean();
  for (const exp of expenses) {
    const exists = await Voucher.findOne({
      companyId,
      sourceModule: 'EXPENSE',
      sourceRefId: exp._id,
      ...nd
    });
    if (exists) {
      stats.skipped++;
      continue;
    }
    if (!dryRun) {
      await glBridge.postExpenseGl(null, companyId, {
        expenseId: exp._id,
        amount: exp.amount,
        category: exp.category,
        date: exp.date
      }, { userId: null });
    }
    stats.expenses++;
  }

  return stats;
}

async function main() {
  const mongoUri = env.MONGODB_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is required — set it in pharmaERPBackend/.env');
  }
  await mongoose.connect(mongoUri);
  const filter = { ...nd };
  if (filterCompanyId) filter._id = filterCompanyId;

  const companies = await Company.find(filter).select('_id name').lean();
  console.log(`Backfill GL ${dryRun ? '(DRY RUN) ' : ''}for ${companies.length} companies`);

  for (const c of companies) {
    console.log(`\nCompany: ${c.name} (${c._id})`);
    const stats = await backfillCompany(c._id);
    console.log(JSON.stringify(stats, null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
