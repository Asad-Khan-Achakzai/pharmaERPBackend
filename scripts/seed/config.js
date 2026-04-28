/**
 * Dimension presets for seeded tenants. Larger numbers stress-test reports and dashboards.
 */
const SCALE = {
  large: {
    userTarget: 100,
    rolesTotal: 10,
    /** Still “large” for RBAC and API testing; raw row counts toned down so `npm run seed` finishes (<~15–25 min Atlas). Raise locally for perf stress. */
    ops: {
      productCount: 90,
      distributorCount: 14,
      pharmacyCount: 28,
      stockTransferCount: 120,
      orderDays: 55,
      collectionAttempts: 140,
      expenseCount: 55,
      supplierPaymentCount: 20,
      doctorsApprox: 120,
      plansPerCompany: 180,
      attendanceDaysBack: 60
    }
  },
  medium: {
    userTarget: 20,
    rolesTotal: 5,
    ops: {
      productCount: 32,
      distributorCount: 6,
      pharmacyCount: 12,
      stockTransferCount: 52,
      orderDays: 60,
      collectionAttempts: 88,
      expenseCount: 28,
      supplierPaymentCount: 10,
      doctorsApprox: 48,
      plansPerCompany: 48,
      attendanceDaysBack: 45
    }
  },
  small: {
    userTarget: 5,
    rolesTotal: 3,
    ops: {
      productCount: 14,
      distributorCount: 4,
      pharmacyCount: 6,
      stockTransferCount: 22,
      orderDays: 35,
      collectionAttempts: 36,
      expenseCount: 12,
      supplierPaymentCount: 5,
      doctorsApprox: 12,
      plansPerCompany: 12,
      attendanceDaysBack: 24
    }
  }
};

const DEFAULT_SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL || 'superadmin@seed.pharmaerp.test';
const DEFAULT_SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD || 'Super@123';
const PLATFORM_ADMIN_EMAIL = process.env.SEED_PLATFORM_ADMIN_EMAIL || 'platform.admin@seed.pharmaerp.test';
const PLATFORM_ADMIN_PASSWORD = process.env.SEED_PLATFORM_ADMIN_PASSWORD || 'Platform@123';

module.exports = {
  SCALE,
  DEFAULT_SUPER_ADMIN_EMAIL,
  DEFAULT_SUPER_ADMIN_PASSWORD,
  PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_PASSWORD
};
