const PERMISSIONS = {
  system:       ['admin.access', 'roles.manage'],
  dashboard:    ['view'],
  products:     ['view', 'create', 'edit', 'delete', 'viewCostPrice'],
  distributors: ['view', 'create', 'edit', 'delete'],
  inventory:    ['view', 'transfer'],
  pharmacies:   ['view', 'create', 'edit', 'delete'],
  /** `assign` = change territoryId / assignedRepId / monthlyVisitTarget / tier on a doctor. */
  doctors:      ['view', 'create', 'edit', 'delete', 'assign'],
  orders:       ['view', 'create', 'edit', 'deliver', 'return'],
  payments:     ['view', 'create'],
  ledger:       ['view'],
  accounts:     ['view', 'manage'],
  vouchers:     ['view', 'create', 'post', 'reverse'],
  targets:      ['view', 'create', 'edit'],
  /** `review` lets a manager open a submitted plan; `approve` lets them activate or reject it. */
  weeklyPlans:  ['view', 'create', 'edit', 'markVisit', 'review', 'approve'],
  expenses:     ['view', 'create', 'edit', 'delete'],
  payroll:      ['view', 'create', 'edit', 'pay'],
  /**
   * `request.create` — submit attendance regularization when company has approvals enabled.
   * `approve.direct` / `approve.escalated` — matrix steps (admin.access still overrides).
   * `approve` — umbrella: satisfies both direct and escalated approval route checks when granted.
   * `viewTeam` — team attendance list/report (alias-style; often paired with `view`).
   * `viewEscalations` — read attendance exception summaries / ops views without full matrix manage.
   * `override` — correct attendance rows (admin tools) without full `admin.access`.
   * `matrix.manage` — edit approval matrices / policies.
   * `governance.view` — read attendance settings & monitoring summaries.
   * `viewCompany` — optional custom role: company-wide attendance reads without admin.access.
   * Company operators with `admin.access` already see the full tenant and act as attendance administrators.
   */
  attendance:   [
    'view',
    'mark',
    'viewTeam',
    'viewCompany',
    'request.create',
    'approve',
    'approve.direct',
    'approve.escalated',
    'viewEscalations',
    'override',
    'matrix.manage',
    'governance.view'
  ],
  reports:      ['view', 'accounting'],
  suppliers:    ['view', 'manage'],
  /** SAP-style PO / GRN; liability on SupplierLedger only when GRN is posted — see procurement.routes */
  procurement:  ['view', 'create', 'approve', 'receive', 'invoicePost', 'return', 'grnReverse', 'cancelPo'],
  users:        ['view', 'create', 'edit', 'delete'],
  /**
   * MRep team hierarchy.
   *   `view`            – see the "My Team" widget / direct reports list
   *   `manage`          – change managerId / employeeCode / territoryId on users
   *   `viewAllReports`  – see plans / visits / sales of the whole subtree (granted to ASM & RM)
   */
  team:         ['view', 'manage', 'viewAllReports'],
  /** MRep territory tree (Zone/Area/Brick). `manage` covers create/edit/delete; `view` is read-only. */
  territories:  ['view', 'manage'],
  /**
   * Enterprise onboarding & migration orchestration.
   * `manage` controls session/step transitions; `import` runs jobs; `approveGoLive` finalizes cutover.
   */
  onboarding:   ['view', 'manage', 'import', 'approveGoLive', 'rollback'],
  platform:     ['dashboard.view', 'companies.manage']
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
