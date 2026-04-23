const PERMISSIONS = {
  dashboard:    ['view'],
  products:     ['view', 'create', 'edit', 'delete'],
  distributors: ['view', 'create', 'edit', 'delete'],
  inventory:    ['view', 'transfer'],
  pharmacies:   ['view', 'create', 'edit', 'delete'],
  doctors:      ['view', 'create', 'edit', 'delete'],
  orders:       ['view', 'create', 'edit', 'deliver', 'return'],
  payments:     ['view', 'create'],
  ledger:       ['view'],
  targets:      ['view', 'create', 'edit'],
  weeklyPlans:  ['view', 'create', 'edit', 'markVisit'],
  expenses:     ['view', 'create', 'edit', 'delete'],
  payroll:      ['view', 'create', 'edit', 'pay'],
  attendance:   ['view', 'mark'],
  reports:      ['view'],
  suppliers:    ['view', 'manage'],
  users:        ['view', 'create', 'edit', 'delete']
};

const ALL_PERMISSIONS = [];
for (const [module, actions] of Object.entries(PERMISSIONS)) {
  for (const action of actions) {
    ALL_PERMISSIONS.push(`${module}.${action}`);
  }
}

const getModulePermissions = (moduleName) => {
  const actions = PERMISSIONS[moduleName] || [];
  return actions.map((action) => `${moduleName}.${action}`);
};

module.exports = { PERMISSIONS, ALL_PERMISSIONS, getModulePermissions };
