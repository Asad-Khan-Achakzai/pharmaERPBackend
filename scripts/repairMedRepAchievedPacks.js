/**
 * Recompute MedRepTarget.achievedPacks from deliveries − returns − amendments
 * for every active target (same formula as syncAchievedPacksForRepMonth).
 *
 * Dry-run (default):
 *   node scripts/repairMedRepAchievedPacks.js
 *
 * Apply:
 *   node scripts/repairMedRepAchievedPacks.js --apply
 *
 * Env: MONGODB_URI (via dotenv / src/config/env)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const User = require('../src/models/User');
const MedRepTarget = require('../src/models/MedRepTarget');
const {
  computeAchievedPacksForRepMonth,
  syncAchievedPacksForRepMonth
} = require('../src/services/medRepTargetAchieved.service');
const { requireCompanyIanaZone } = require('../src/utils/businessTime');

const nd = { $ne: true };
const apply = process.argv.includes('--apply');

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const targets = await MedRepTarget.find({ isDeleted: nd })
    .select('_id companyId medicalRepId month achievedPacks packsTarget')
    .lean();

  const companies = await Company.find({
    _id: { $in: [...new Set(targets.map((t) => String(t.companyId)))] }
  })
    .select('name timeZone')
    .lean();
  const companyById = new Map(companies.map((c) => [String(c._id), c]));

  const reps = await User.find({
    _id: { $in: [...new Set(targets.map((t) => String(t.medicalRepId)))] }
  })
    .select('name')
    .lean();
  const repName = new Map(reps.map((r) => [String(r._id), r.name]));

  const changes = [];
  const errors = [];

  for (const t of targets) {
    const company = companyById.get(String(t.companyId));
    if (!company?.timeZone) {
      errors.push({ targetId: String(t._id), reason: 'Company timezone missing' });
      continue;
    }

    let tz;
    try {
      tz = requireCompanyIanaZone(company.timeZone);
    } catch (e) {
      errors.push({ targetId: String(t._id), reason: e.message });
      continue;
    }

    const live = await computeAchievedPacksForRepMonth(
      t.companyId,
      t.medicalRepId,
      t.month,
      tz
    );
    const stored = Number(t.achievedPacks) || 0;
    if (live === stored) continue;

    const row = {
      targetId: String(t._id),
      company: company.name,
      rep: repName.get(String(t.medicalRepId)) || String(t.medicalRepId),
      month: t.month,
      stored,
      live,
      diff: live - stored
    };
    changes.push(row);

    if (apply) {
      await syncAchievedPacksForRepMonth(t.companyId, t.medicalRepId, t.month, tz);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        scanned: targets.length,
        wouldChange: changes.length,
        changed: apply ? changes.length : 0,
        errors,
        changes
      },
      null,
      2
    )}\n`
  );

  await mongoose.disconnect();
};

run().catch(async (err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
