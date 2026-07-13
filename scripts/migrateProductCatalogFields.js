/**
 * Backfill Product.sku and Product.genericName for legacy rows.
 * Usage: node scripts/migrateProductCatalogFields.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Product = require('../src/models/Product');

function slugSku(name, id) {
  const base = String(name || 'product')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'SKU'}-${String(id).slice(-6).toUpperCase()}`;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI || process.env.MONGODB_URI);
  const missingSku = await Product.find({
    $or: [{ sku: null }, { sku: { $exists: false } }, { sku: '' }],
    isDeleted: { $ne: true }
  });
  let skuCount = 0;
  for (const p of missingSku) {
    p.sku = slugSku(p.name, p._id);
    if (!p.genericName && p.composition) p.genericName = p.composition;
    if (!p.catalogVersion) p.catalogVersion = 1;
    await p.save();
    skuCount += 1;
  }
  const missingGeneric = await Product.updateMany(
    {
      $or: [{ genericName: null }, { genericName: { $exists: false } }, { genericName: '' }],
      composition: { $type: 'string', $ne: '' },
      isDeleted: { $ne: true }
    },
    [{ $set: { genericName: '$composition' } }]
  );
  console.log(`Backfilled sku for ${skuCount} products; genericName matched ${missingGeneric.modifiedCount}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
