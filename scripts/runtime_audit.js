/* eslint-disable no-console */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Company, User, Product, Distributor, Pharmacy, Supplier, DistributorInventory, StockTransfer, SupplierLedger, Order, DeliveryRecord, Payment, Transaction, Expense, Payroll, Attendance } = require('../src/models');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api/v1`;

const result = {
  security: [],
  business: [],
  edgeCases: [],
  financial: { manual: {}, system: {}, diff: {} },
  performance: []
};

function dataOf(res) {
  return res?.data?.data ?? res?.data;
}

async function expectFail(label, fn, expectedStatus) {
  try {
    await fn();
    result.security.push({ label, ok: false, expectedStatus, actual: 'success' });
  } catch (e) {
    const status = e?.response?.status || 0;
    result.security.push({ label, ok: status === expectedStatus, expectedStatus, actual: status, message: e?.response?.data?.message || e.message });
  }
}

async function req(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload?.message || `HTTP ${res.status}`);
    err.response = { status: res.status, data: payload };
    throw err;
  }
  return { data: payload };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  await mongoose.connect(mongoUri);

  const adminLogin = await req('POST', '/auth/login', null, { email: 'admin@pharmaplus.pk', password: 'Admin@123' });
  const adminToken = dataOf(adminLogin).tokens.accessToken;
  const admin = dataOf(adminLogin).user;

  const repLogin = await req('POST', '/auth/login', null, { email: 'ahmed@pharmaplus.pk', password: 'Rep@1234' });
  const repToken = dataOf(repLogin).tokens.accessToken;

  const superAdminUser = await User.findOne({ role: 'SUPER_ADMIN' }).lean();
  const superToken = jwt.sign({ userId: superAdminUser._id, role: superAdminUser.role }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  await expectFail('super-admin login blocked by email validator (.local)', () => req('POST', '/auth/login', null, { email: 'superadmin@platform.local', password: 'Super@123' }), 400);


  // STEP 2: SECURITY VALIDATION
  await expectFail('missing-token /auth/me', () => req('GET', '/auth/me'), 401);
  await expectFail('invalid-token /auth/me', () => req('GET', '/auth/me', 'not-a-token'), 401);
  const expired = jwt.sign({ userId: admin._id, role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });
  await expectFail('expired-token /auth/me', () => req('GET', '/auth/me', expired), 401);

  await expectFail('rep create payroll', () => req('POST', '/payroll', repToken, { employeeId: admin._id, month: '2026-04' }), 403);
  await expectFail('rep patch company cash opening', () => req('PATCH', '/reports/company-cash-opening', repToken, { cashOpeningBalance: 1 }), 403);

  // Input validation
  await expectFail(
    'negative payment amount',
    () => req('POST', '/payments', adminToken, { pharmacyId: 'x', amount: -50, paymentMethod: 'CASH' }),
    400
  );
  await expectFail(
    'zero quantity order',
    () => req('POST', '/orders', adminToken, { pharmacyId: 'x', distributorId: 'y', items: [{ productId: 'z', quantity: 0 }] }),
    400
  );

  // Multi-tenancy simulation
  const c2 = await req('POST', '/super-admin/companies', superToken, {
    name: 'Tenant Two Labs',
    city: 'Lahore',
    country: 'Pakistan',
    currency: 'PKR',
    phone: '+92-300-0000001',
    email: 'tenant2@example.com'
  });
  const secondCompanyId = dataOf(c2)._id;
  await req('POST', '/super-admin/switch-company', superToken, { companyId: secondCompanyId });
  const usersInC2 = await req('GET', '/users', superToken);
  result.security.push({
    label: 'tenant isolation check after super-admin switch',
    ok: Array.isArray(dataOf(usersInC2)?.docs || dataOf(usersInC2)) && ((dataOf(usersInC2).docs || dataOf(usersInC2)).length === 0),
    usersVisibleInTenant2: (dataOf(usersInC2).docs || dataOf(usersInC2)).length
  });
  await req('POST', '/super-admin/switch-company', superToken, { companyId: admin.companyId });

  // STEP 3A: STOCK + SUPPLIER
  const distributorsRes = dataOf(await req('GET', '/distributors', adminToken));
  const productsRes = dataOf(await req('GET', '/products', adminToken));
  const pharmaciesRes = dataOf(await req('GET', '/pharmacies', adminToken));
  const doctorsRes = dataOf(await req('GET', '/doctors', adminToken));
  const distributors = distributorsRes.docs || distributorsRes;
  const products = productsRes.docs || productsRes;
  const pharmacies = pharmaciesRes.docs || pharmaciesRes;
  const doctors = doctorsRes.docs || doctorsRes;

  const supplierCreate = await req('POST', '/suppliers', adminToken, { name: 'Audit Supplier One', openingBalance: 0 });
  const supplierId = dataOf(supplierCreate)._id;

  const d0 = distributors[0];
  const p0 = products[0];
  const p1 = products[1];

  const beforeInv0 = await DistributorInventory.findOne({ companyId: admin.companyId, distributorId: d0._id, productId: p0._id }).lean();
  const transfer = await req('POST', '/inventory/transfer', adminToken, {
    distributorId: d0._id,
    supplierId,
    items: [{ productId: p0._id, quantity: 10 }, { productId: p1._id, quantity: 5 }],
    totalShippingCost: 300,
    notes: 'QA audit transfer'
  });
  const transferId = dataOf(transfer)._id;
  const afterInv0 = await DistributorInventory.findOne({ companyId: admin.companyId, distributorId: d0._id, productId: p0._id }).lean();
  const supplierBal1 = dataOf(await req('GET', `/suppliers/${supplierId}/balance`, adminToken));
  result.business.push({
    step: 'stock_transfer_with_supplier',
    transferId,
    inventoryIncreased: afterInv0.quantity > beforeInv0.quantity,
    avgCostPerUnit: afterInv0.avgCostPerUnit,
    supplierPayableAfterPurchase: supplierBal1.payable
  });

  await req('POST', `/suppliers/${supplierId}/payments`, adminToken, {
    amount: 500,
    paymentMethod: 'CASH',
    notes: 'QA payment'
  });
  const supplierBal2 = dataOf(await req('GET', `/suppliers/${supplierId}/balance`, adminToken));
  result.business.push({
    step: 'supplier_payment',
    payableReduced: supplierBal2.payable < supplierBal1.payable,
    payableBefore: supplierBal1.payable,
    payableAfter: supplierBal2.payable
  });

  // STEP 3B: ORDER -> DELIVERY -> PAYMENT
  const createOrderRes = await req('POST', '/orders', adminToken, {
    pharmacyId: pharmacies[0]._id,
    doctorId: doctors[0]._id,
    distributorId: d0._id,
    medicalRepId: admin._id,
    items: [
      { productId: p0._id, quantity: 4, clinicDiscount: 10, distributorDiscount: 5 },
      { productId: p1._id, quantity: 3, clinicDiscount: 10, distributorDiscount: 5 }
    ],
    notes: 'QA order'
  });
  const order = dataOf(createOrderRes);

  const expectedOrder = order.items.reduce((acc, it) => {
    const tpTotal = it.tpAtTime * it.quantity;
    const afterDist = tpTotal * (1 - ((it.distributorDiscount || 0) / 100));
    const finalAmount = afterDist * (1 - ((it.clinicDiscount || 0) / 100));
    acc.tp += tpTotal;
    acc.final += finalAmount;
    return acc;
  }, { tp: 0, final: 0 });

  const invBeforeDelivery = await DistributorInventory.findOne({ companyId: admin.companyId, distributorId: d0._id, productId: p0._id }).lean();
  await req('POST', `/orders/${order._id}/deliver`, adminToken, { items: [{ productId: p0._id, quantity: 4 }, { productId: p1._id, quantity: 3 }] });
  const invAfterDelivery = await DistributorInventory.findOne({ companyId: admin.companyId, distributorId: d0._id, productId: p0._id }).lean();
  const saleTx = await Transaction.findOne({ companyId: admin.companyId, type: 'SALE' }).sort({ createdAt: -1 }).lean();

  try {
    await req('POST', '/payments', adminToken, {
      pharmacyId: pharmacies[0]._id,
      amount: 100,
      paymentMethod: 'CASH',
      notes: 'QA collection'
    });
  } catch (e) {
    result.edgeCases.push({
      label: 'payment rejected due no outstanding',
      status: e?.response?.status || 0,
      message: e?.response?.data?.message || e.message
    });
  }

  result.business.push({
    step: 'order_delivery_payment',
    orderId: order._id,
    systemTotalOrderedAmount: order.totalOrderedAmount,
    expectedTP: Number(expectedOrder.tp.toFixed(2)),
    expectedFinal: Number(expectedOrder.final.toFixed(2)),
    inventoryReduced: invAfterDelivery.quantity < invBeforeDelivery.quantity,
    saleTransactionProfit: saleTx?.profit
  });

  // STEP 3C: ATTENDANCE -> PAYROLL
  try {
    await req('POST', '/attendance/checkin', repToken, {});
  } catch (e) {
    result.edgeCases.push({ label: 'duplicate attendance checkin', status: e?.response?.status || 0, message: e?.response?.data?.message || e.message });
  }
  try {
    await req('POST', '/attendance/checkout', repToken, {});
  } catch (e) {
    result.edgeCases.push({ label: 'checkout validation', status: e?.response?.status || 0, message: e?.response?.data?.message || e.message });
  }
  const repUser = dataOf(repLogin).user;
  const month = new Date().toISOString().slice(0, 7);
  const preview = dataOf(await req('POST', '/payroll/preview', adminToken, { employeeId: repUser._id, month, manual: true, baseSalary: 50000 }));
  let payrollCreated;
  try {
    payrollCreated = dataOf(await req('POST', '/payroll', adminToken, { employeeId: repUser._id, month, manual: true, baseSalary: 50000 }));
    await req('POST', `/payroll/${payrollCreated._id}/pay`, adminToken, {});
  } catch (e) {
    result.edgeCases.push({ label: 'duplicate payroll protection', status: e?.response?.status || 0, message: e?.response?.data?.message || e.message });
  }
  result.business.push({
    step: 'attendance_payroll',
    previewNetSalary: preview.netSalary,
    payrollCreated: Boolean(payrollCreated?._id)
  });

  // STEP 3D: EXPENSE
  await req('POST', '/expenses', adminToken, {
    category: 'OFFICE',
    amount: 777,
    date: new Date().toISOString(),
    description: 'QA manual expense'
  });

  // STEP 4: FINANCIAL VALIDATION
  const tx = await Transaction.find({ companyId: admin.companyId }).lean();
  const totalRevenue = tx.filter(t => t.type === 'SALE').reduce((s, t) => s + (t.revenue || 0), 0);
  const totalCost = tx.filter(t => t.type === 'SALE').reduce((s, t) => s + (t.cost || 0), 0);
  const totalExpenses = tx.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.cost || 0), 0);
  const netProfitManual = Number((totalRevenue - totalCost - totalExpenses).toFixed(2));
  const cashManual = Number((tx.reduce((s, t) => s + (t.profit || 0), 0)).toFixed(2));

  const summary = dataOf(await req('GET', '/reports/summary', adminToken));
  const dash = dataOf(await req('GET', '/reports/dashboard', adminToken));
  const fsum = dataOf(await req('GET', '/reports/financial-summary', adminToken));

  result.financial.manual = {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
    totalExpenses: Number(totalExpenses.toFixed(2)),
    netProfit: netProfitManual,
    currentCashApprox: cashManual
  };
  result.financial.system = {
    reportSummaryRevenue: summary.totalRevenue,
    reportSummaryCost: summary.totalCost,
    reportSummaryNetProfit: summary.netProfit,
    dashboardNetProfit: dash.netProfit,
    financialSummaryCash: fsum.cashInHand
  };
  result.financial.diff = {
    netProfitVsSummary: Number((netProfitManual - (summary.netProfit || 0)).toFixed(2)),
    netProfitVsDashboard: Number((netProfitManual - (dash.netProfit || 0)).toFixed(2))
  };

  // STEP 5 edge
  await expectFail('negative stock attempt', () => req('POST', '/inventory/transfer', adminToken, {
    distributorId: d0._id, items: [{ productId: p0._id, quantity: -10 }]
  }), 400);

  await expectFail('overpayment attempt', () => req('POST', `/suppliers/${supplierId}/payments`, adminToken, {
    amount: 999999999, paymentMethod: 'CASH'
  }), 400);

  // STEP 6 quick performance probe
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => req('GET', '/reports/dashboard', adminToken)));
  const elapsed = Date.now() - t0;
  result.performance.push({ probe: '20x /reports/dashboard parallel', elapsedMs: elapsed, avgMs: Math.round(elapsed / 20) });

  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('AUDIT_RUN_FAILED', e?.response?.data || e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
