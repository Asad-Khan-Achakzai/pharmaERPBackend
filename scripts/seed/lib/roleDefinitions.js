const { ALL_PERMISSIONS } = require('../../../src/constants/permissions');

/** @param {string[]} perms */
function V(perms) {
  return perms.filter((p) => ALL_PERMISSIONS.includes(p));
}

function R(code, name, perms) {
  const permissions = V(perms);
  if (!permissions.length) throw new Error(`Role ${code}: empty permissions`);
  return { code, name, permissions };
}

const LARGE_CUSTOM = [
  R('REGION_MANAGER', 'Regional Sales Manager', [
    'dashboard.view',
    'products.view',
    'distributors.view',
    'pharmacies.view',
    'doctors.view',
    'orders.view',
    'orders.create',
    'orders.edit',
    'orders.deliver',
    'payments.view',
    'ledger.view',
    'reports.view',
    'inventory.view',
    'weeklyPlans.view',
    'weeklyPlans.create',
    'weeklyPlans.edit',
    'weeklyPlans.markVisit',
    'targets.view',
    'targets.create',
    'targets.edit',
    'attendance.view',
    'users.view'
  ]),
  R('SALES_TEAM_LEAD', 'Sales Team Lead', [
    'dashboard.view',
    'products.view',
    'distributors.view',
    'pharmacies.view',
    'doctors.view',
    'orders.view',
    'orders.create',
    'orders.edit',
    'orders.deliver',
    'payments.view',
    'reports.view',
    'weeklyPlans.view',
    'weeklyPlans.create',
    'weeklyPlans.markVisit',
    'targets.edit',
    'attendance.view'
  ]),
  R('INV_COORD', 'Inventory Coordinator', [
    'dashboard.view',
    'products.view',
    'products.viewCostPrice',
    'distributors.view',
    'inventory.view',
    'inventory.transfer',
    'orders.view',
    'reports.view'
  ]),
  R('FIN_READONLY', 'Finance (Read)', [
    'dashboard.view',
    'ledger.view',
    'payments.view',
    'reports.view',
    'expenses.view'
  ]),
  R('HR_PAYROLL_COORD', 'HR & Payroll Coordinator', [
    'dashboard.view',
    'users.view',
    'attendance.view',
    'attendance.mark',
    'payroll.view',
    'payroll.create',
    'payroll.edit',
    'payroll.pay',
    'reports.view'
  ]),
  R('DIST_OPS', 'Distribution Operations', [
    'dashboard.view',
    'products.view',
    'distributors.view',
    'distributors.edit',
    'inventory.view',
    'inventory.transfer',
    'reports.view'
  ]),
  R('QUALITY_FIELD', 'Field Quality Liaison', ['dashboard.view', 'doctors.view', 'orders.view', 'reports.view']),
  R('MED_REP_FOCUSED', 'Medical Rep (narrow)', [
    'dashboard.view',
    'products.view',
    'distributors.view',
    'inventory.view',
    'pharmacies.view',
    'orders.view',
    'orders.create',
    'payments.view',
    'attendance.mark',
    'weeklyPlans.markVisit'
  ])
];

const MEDIUM_CUSTOM = [
  R('AREA_MANAGER', 'Area Manager', LARGE_CUSTOM[0].permissions.slice(0)),
  R('INV_LEAD_MEDIUM', 'Inventory Lead', LARGE_CUSTOM[2].permissions.slice(0)),
  R('RETAIL_EXEC', 'Retail Executive', [
    'dashboard.view',
    'pharmacies.view',
    'doctors.view',
    'orders.view',
    'orders.create',
    'payments.view',
    'reports.view'
  ])
];

/** Small tenant: managers + reps only — one managerial custom role beyond system defaults */
const SMALL_CUSTOM = [
  R('TEAM_MANAGER', 'Team Manager', MEDIUM_CUSTOM[0].permissions.filter((_, i) => i < 16))
];

module.exports = { LARGE_CUSTOM, MEDIUM_CUSTOM, SMALL_CUSTOM };
