/**
 * Boot-time MRep role seeding (Phase 2).
 *
 * Iterates every existing (non-deleted) company and ensures default roles
 * (ADMIN, MEDICAL_REP, ASM, RM) are present. The role.service.seedDefaultRolesForCompany
 * call is idempotent — it does a `findOne` per code and only creates what's missing —
 * so this is safe to run on every startup.
 *
 * Cost: ~4 indexed `findOne`s per company. With 50 companies that's ~200 queries totalling
 * a few hundred ms at most, run once at boot. Heavy logs only on the first install.
 */
const Company = require('../models/Company');
const { seedDefaultRolesForCompany } = require('../services/role.service');
const logger = require('../utils/logger');

const seedMrepRolesForAllCompanies = async () => {
  const t0 = Date.now();
  try {
    const companies = await Company.find({ isDeleted: { $ne: true } }).select('_id').lean();
    /** Bound parallelism so a 100-company tenant doesn't open 400 simultaneous indexed lookups. */
    const CONCURRENCY = 5;
    let i = 0;
    while (i < companies.length) {
      const batch = companies.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((c) => seedDefaultRolesForCompany(c._id, {}).catch((e) => {
        logger.warn(`MRep role bootstrap (skip company ${c._id}):`, e?.message || e);
      })));
      i += CONCURRENCY;
    }
    logger.info(`MRep role bootstrap: ${companies.length} companies checked in ${Date.now() - t0}ms`);
  } catch (e) {
    logger.error('MRep role bootstrap failed (non-fatal):', e?.message || e);
  }
};

module.exports = { seedMrepRolesForAllCompanies };
