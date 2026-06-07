/**
 * One-off index migration:
 * - supplier_ledgers.voucherNumber global unique -> tenant-scoped unique
 * - auditlogs entity index becomes partial for nullable entityId
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

const dropIfExists = async (collection, name) => {
  const indexes = await collection.indexes();
  const has = indexes.some((idx) => idx.name === name);
  if (has) {
    await collection.dropIndex(name);
    console.log(`Dropped index: ${collection.collectionName}.${name}`);
  } else {
    console.log(`Skip drop (missing): ${collection.collectionName}.${name}`);
  }
};

const ensureIndex = async (collection, key, options) => {
  const name = await collection.createIndex(key, options);
  console.log(`Ensured index: ${collection.collectionName}.${name}`);
};

const run = async () => {
  if (!mongoUri) {
    throw new Error('MONGODB_URI (or MONGO_URI) is required in pharmaERPBackend/.env');
  }
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const supplierLedgers = db.collection('supplierledgers');
  const auditLogs = db.collection('auditlogs');

  await dropIfExists(supplierLedgers, 'voucherNumber_1');
  await ensureIndex(
    supplierLedgers,
    { companyId: 1, voucherNumber: 1 },
    {
      name: 'companyId_1_voucherNumber_1',
      unique: true,
      // MongoDB partial indexes do not support $ne — only index rows with a real voucher number
      partialFilterExpression: { voucherNumber: { $type: 'string' } }
    }
  );

  await dropIfExists(auditLogs, 'companyId_1_entityType_1_entityId_1');
  await ensureIndex(
    auditLogs,
    { companyId: 1, entityType: 1, entityId: 1 },
    {
      name: 'companyId_1_entityType_1_entityId_1',
      partialFilterExpression: { entityId: { $type: 'objectId' } }
    }
  );

  await mongoose.disconnect();
  console.log('Tenant safety index migration completed');
};

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
