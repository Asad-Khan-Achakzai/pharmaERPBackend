/**
 * One-time repair for products created with catalogVersion=1 after the company
 * catalog had already advanced (mobile incremental sync skipped them).
 *
 * Usage: node scripts/repairProductCatalogVersions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Product = require('../src/models/Product');

async function maxCatalogVersion(companyId) {
  const [activeTop, deletedTop] = await Promise.all([
    Product.findOne({ companyId })
      .sort({ catalogVersion: -1 })
      .select('catalogVersion')
      .lean(),
    Product.findDeleted({ companyId })
      .sort({ catalogVersion: -1 })
      .select('catalogVersion')
      .limit(1)
      .lean()
  ]);
  return Math.max(activeTop?.catalogVersion || 0, deletedTop[0]?.catalogVersion || 0);
}

async function repairCompany(companyId) {
  const maxV = await maxCatalogVersion(companyId);
  if (maxV <= 1) return 0;

  const latestUpdatedNonV1 = await Product.findOne({
    companyId,
    catalogVersion: { $gt: 1 },
    isDeleted: { $ne: true }
  })
    .sort({ updatedAt: -1 })
    .select('updatedAt')
    .lean();

  if (!latestUpdatedNonV1) return 0;

  const stuck = await Product.find({
    companyId,
    catalogVersion: 1,
    createdAt: { $gt: latestUpdatedNonV1.updatedAt },
    isDeleted: { $ne: true }
  }).sort({ createdAt: 1 });

  if (!stuck.length) return 0;

  let version = maxV;
  for (const product of stuck) {
    version += 1;
    product.catalogVersion = version;
    await product.save();
  }
  return stuck.length;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI || process.env.MONGODB_URI);

  const companyIds = await Product.distinct('companyId', { isDeleted: { $ne: true } });
  let total = 0;
  for (const companyId of companyIds) {
    const repaired = await repairCompany(companyId);
    if (repaired) {
      console.log(`Company ${companyId}: bumped catalogVersion for ${repaired} product(s)`);
      total += repaired;
    }
  }

  console.log(`Repair complete. Updated ${total} product(s) across ${companyIds.length} companies.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
