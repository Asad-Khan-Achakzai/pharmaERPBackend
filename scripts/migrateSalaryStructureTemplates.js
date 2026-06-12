/**
 * Migrate employee-bound salary structures to reusable templates + User.salaryStructureId.
 * Idempotent: skips employees already assigned to a template; skips legacy rows already marked isTemplate:false.
 *
 * Run:
 *   node scripts/migrateSalaryStructureTemplates.js
 *   DRY_RUN=1 node scripts/migrateSalaryStructureTemplates.js
 *
 * Env: MONGODB_URI required.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Company = require('../src/models/Company');
const User = require('../src/models/User');
const SalaryStructure = require('../src/models/SalaryStructure');

const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (...args) => {
  // eslint-disable-next-line no-console
  console.log(DRY ? '[DRY]' : '[APPLY]', ...args);
};

const legacyFilter = {
  employeeId: { $exists: true, $ne: null },
  isActive: true,
  $or: [{ isTemplate: false }, { isTemplate: { $exists: false } }]
};

const copyStructureFields = (legacy) => ({
  basicSalary: legacy.basicSalary,
  dailyAllowance: legacy.dailyAllowance ?? 0,
  allowances: legacy.allowances ?? [],
  deductions: legacy.deductions ?? [],
  commission: legacy.commission ?? { type: 'percentage', value: 0 },
  productPackIncentives: legacy.productPackIncentives ?? []
});

const migrateCompany = async (companyId) => {
  const legacies = await SalaryStructure.find({ companyId, ...legacyFilter }).lean();
  if (!legacies.length) {
    log(`Company ${companyId}: no legacy active structures`);
    return { created: 0, assigned: 0, archived: 0 };
  }

  let created = 0;
  let assigned = 0;
  let archived = 0;

  for (const legacy of legacies) {
    const employee = await User.findOne({ _id: legacy.employeeId, companyId }).select('name salaryStructureId').lean();
    if (!employee) {
      log(`  skip legacy ${legacy._id}: employee missing`);
      continue;
    }

    if (employee.salaryStructureId) {
      log(`  skip ${employee.name}: already has salaryStructureId`);
      if (!DRY) {
        await SalaryStructure.updateOne(
          { _id: legacy._id },
          { $set: { isActive: false, isTemplate: false } }
        );
        archived += 1;
      }
      continue;
    }

    const baseName = `${employee.name || 'Employee'} – Salary`;
    let name = baseName;
    let suffix = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await SalaryStructure.findOne({ companyId, name, isTemplate: true, isDeleted: { $ne: true } }).lean()) {
      suffix += 1;
      name = `${baseName} (${suffix})`;
    }

    log(`  ${employee.name}: template "${name}" from legacy ${legacy._id}`);

    if (DRY) {
      created += 1;
      assigned += 1;
      archived += 1;
      continue;
    }

    const template = await SalaryStructure.create({
      companyId,
      name,
      description: 'Migrated from employee-bound structure',
      isTemplate: true,
      isActive: true,
      ...copyStructureFields(legacy)
    });

    await User.updateOne(
      { _id: employee._id, companyId },
      { $set: { salaryStructureId: template._id, salaryStructureAssignedAt: new Date() } }
    );

    await SalaryStructure.updateOne(
      { _id: legacy._id },
      { $set: { isActive: false, isTemplate: false } }
    );

    created += 1;
    assigned += 1;
    archived += 1;
  }

  return { created, assigned, archived };
};

const main = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri);
  log('Connected');

  const companies = await Company.find({ isDeleted: { $ne: true } }).select('_id name').lean();
  let totals = { created: 0, assigned: 0, archived: 0 };

  for (const company of companies) {
    log(`\nCompany: ${company.name || company._id}`);
    // eslint-disable-next-line no-await-in-loop
    const stats = await migrateCompany(company._id);
    totals = {
      created: totals.created + stats.created,
      assigned: totals.assigned + stats.assigned,
      archived: totals.archived + stats.archived
    };
    log(`  created=${stats.created} assigned=${stats.assigned} archived=${stats.archived}`);
  }

  log('\nDone.', totals);
  await mongoose.disconnect();
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
