/**
 * MRep Phase 0/1 backfill — fully idempotent. Safe to run multiple times.
 *
 * Steps:
 *   1. Seed DEFAULT_ASM + DEFAULT_RM roles for every existing company.
 *   2. Create Territory tree from `Doctor.zone` (ZONE) and `Doctor.doctorBrick` (BRICK)
 *      with an inferred AREA = parent zone (named the same as the zone) for each brick.
 *      Doctors get `territoryId` set to the resolved BRICK; bricks-with-no-zone get a
 *      synthetic ZONE called "Unzoned".
 *   3. Parse `Doctor.frequency` into `monthlyVisitTarget` when it's a small integer string.
 *
 * Run:
 *   node scripts/migrateMrepHierarchyPhase1.js          # apply
 *   DRY_RUN=1 node scripts/migrateMrepHierarchyPhase1.js  # report only
 *
 * Env: MONGODB_URI required.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Company = require('../src/models/Company');
const Doctor = require('../src/models/Doctor');
const Territory = require('../src/models/Territory');
const { seedDefaultRolesForCompany } = require('../src/services/role.service');
const { TERRITORY_KIND } = require('../src/constants/enums');

const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (...args) => {
  // eslint-disable-next-line no-console
  console.log(DRY ? '[DRY]' : '[APPLY]', ...args);
};

const buildPath = (parent, selfId) => {
  const base = parent ? parent.materializedPath || '/' : '/';
  return `${base}${String(selfId)}/`;
};

const upsertTerritory = async ({ companyId, kind, name, parent }) => {
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const filter = { companyId, kind, name: trimmed, parentId: parent ? parent._id : null };
  let t = await Territory.findOne({ ...filter, isDeleted: { $ne: true } });
  if (t) return t;
  if (DRY) {
    return {
      _id: new mongoose.Types.ObjectId(),
      companyId,
      kind,
      name: trimmed,
      parentId: parent ? parent._id : null,
      materializedPath: '/',
      depth: kind === TERRITORY_KIND.ZONE ? 0 : kind === TERRITORY_KIND.AREA ? 1 : 2,
      isActive: true
    };
  }
  t = await Territory.create({
    companyId,
    kind,
    name: trimmed,
    parentId: parent ? parent._id : null,
    materializedPath: '/',
    depth: kind === TERRITORY_KIND.ZONE ? 0 : kind === TERRITORY_KIND.AREA ? 1 : 2,
    isActive: true
  });
  t.materializedPath = buildPath(parent, t._id);
  await t.save();
  return t;
};

const parseMonthlyTarget = (raw) => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Accept "4", "4x", "4/month", "4 visits"
  const m = s.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 31) return null;
  return n;
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const companies = await Company.find({ isDeleted: { $ne: true } }).lean();
  log(`Companies in scope: ${companies.length}`);

  let totalRolesSeeded = 0;
  let totalZones = 0;
  let totalAreas = 0;
  let totalBricks = 0;
  let totalDoctorsTerritoried = 0;
  let totalDoctorsTargeted = 0;

  for (const c of companies) {
    log(`-- Company ${c.name || c._id}`);

    if (!DRY) {
      const seeded = await seedDefaultRolesForCompany(c._id, {});
      if (seeded.asmRole) totalRolesSeeded += 1;
      if (seeded.rmRole) totalRolesSeeded += 1;
    } else {
      totalRolesSeeded += 2;
    }

    /* --------- 2. Territory backfill from Doctor strings --------- */
    const doctors = await Doctor.find({ companyId: c._id }).select('zone doctorBrick frequency territoryId monthlyVisitTarget').lean();
    log(`   doctors: ${doctors.length}`);

    /** key = `${zoneName}||${brickName}` -> brick territory doc */
    const brickCache = new Map();
    /** zone name -> zone territory doc */
    const zoneCache = new Map();
    /** zone name -> AREA territory doc (we mint one AREA-per-zone with the same name) */
    const areaCache = new Map();

    let zonesCreated = 0;
    let areasCreated = 0;
    let bricksCreated = 0;

    for (const d of doctors) {
      if (d.territoryId) continue; // already linked
      const zoneName = (d.zone || '').trim() || 'Unzoned';
      const brickName = (d.doctorBrick || '').trim();
      if (!brickName) continue; // need at least a brick to link

      let zone = zoneCache.get(zoneName);
      if (!zone) {
        zone = await upsertTerritory({
          companyId: c._id,
          kind: TERRITORY_KIND.ZONE,
          name: zoneName,
          parent: null
        });
        if (zone) {
          zoneCache.set(zoneName, zone);
          zonesCreated += 1;
        }
      }

      let area = areaCache.get(zoneName);
      if (!area && zone) {
        area = await upsertTerritory({
          companyId: c._id,
          kind: TERRITORY_KIND.AREA,
          name: zoneName, // single area per zone in the backfill
          parent: zone
        });
        if (area) {
          areaCache.set(zoneName, area);
          areasCreated += 1;
        }
      }

      const brickKey = `${zoneName}||${brickName}`;
      let brick = brickCache.get(brickKey);
      if (!brick && area) {
        brick = await upsertTerritory({
          companyId: c._id,
          kind: TERRITORY_KIND.BRICK,
          name: brickName,
          parent: area
        });
        if (brick) {
          brickCache.set(brickKey, brick);
          bricksCreated += 1;
        }
      }
    }
    log(`   territories created — zones:${zonesCreated} areas:${areasCreated} bricks:${bricksCreated}`);
    totalZones += zonesCreated;
    totalAreas += areasCreated;
    totalBricks += bricksCreated;

    /* Now actually link doctors */
    let linked = 0;
    let targeted = 0;
    for (const d of doctors) {
      const zoneName = (d.zone || '').trim() || 'Unzoned';
      const brickName = (d.doctorBrick || '').trim();
      const brick = brickCache.get(`${zoneName}||${brickName}`);
      const target = parseMonthlyTarget(d.frequency);

      const set = {};
      if (!d.territoryId && brick && brick._id) set.territoryId = brick._id;
      if (d.monthlyVisitTarget == null && target != null) set.monthlyVisitTarget = target;

      if (Object.keys(set).length === 0) continue;
      if (DRY) {
        if (set.territoryId) linked += 1;
        if (set.monthlyVisitTarget != null) targeted += 1;
        continue;
      }
      await Doctor.updateOne({ _id: d._id }, { $set: set });
      if (set.territoryId) linked += 1;
      if (set.monthlyVisitTarget != null) targeted += 1;
    }
    log(`   linked doctors → bricks: ${linked}, monthlyVisitTarget set: ${targeted}`);
    totalDoctorsTerritoried += linked;
    totalDoctorsTargeted += targeted;
  }

  log('=== Summary ===');
  log(`Roles seeded (idempotent): ${totalRolesSeeded}`);
  log(`Territories created — zones:${totalZones} areas:${totalAreas} bricks:${totalBricks}`);
  log(`Doctors → territory: ${totalDoctorsTerritoried}`);
  log(`Doctors → monthlyVisitTarget: ${totalDoctorsTargeted}`);
  if (DRY) log('DRY_RUN=1 — no writes performed.');

  await mongoose.disconnect();
};

run().catch((e) => {
  process.stderr.write(e.stack || String(e));
  process.exit(1);
});
