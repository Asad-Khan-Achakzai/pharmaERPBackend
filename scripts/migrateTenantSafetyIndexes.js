/**
 * One-off index migration:
 * - supplier_ledgers.voucherNumber global unique -> tenant-scoped unique
 * - auditlogs entity index becomes partial for nullable entityId
 */
require('dotenv').config();
const mongoose = require('mongoose');

const mongoUri = process.env.MONGO_URI;

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
    throw new Error('MONGO_URI is required');
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
      partialFilterExpression: { voucherNumber: { $type: 'string' }, isDeleted: { $ne: true } }
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
