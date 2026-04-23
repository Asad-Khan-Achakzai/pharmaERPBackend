/* eslint-disable no-console */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  Product,
  Distributor,
  Pharmacy,
  Supplier,
  DistributorInventory
} = require('../src/models');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api/v1`;

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
  return payload;
}

function d(payload) {
  return payload?.data ?? payload;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Use seeded admin tenant (new-tenant order number generation currently collides globally)
  const ts = Date.now();
  const login = await req('POST', '/auth/login', null, {
    email: 'admin@pharmaplus.pk',
    password: 'Admin@123'
  });
  const token = d(login).tokens.accessToken;
  const me = d(login).user;

  // Seed exact scenario entities
  const distributor = await Distributor.create({
    companyId: me.companyId,
    name: `Scenario Distributor ${ts}`,
    city: 'Karachi',
    discountOnTP: 5,
    createdBy: me._id
  });

  const pharmacy = await Pharmacy.create({
    companyId: me.companyId,
    name: `Scenario Pharmacy ${ts}`,
    city: 'Karachi',
    discountOnTP: 10,
    bonusScheme: { buyQty: 5, getQty: 1 }, // 50 paid -> 10 bonus
    createdBy: me._id
  });

  const product = await Product.create({
    companyId: me.companyId,
    name: `Scenario Product ${ts}`,
    composition: 'N/A',
    tp: 200,
    casting: 100,
    mrp: 250,
    createdBy: me._id
  });

  const supplierRes = await req('POST', '/suppliers', token, {
    name: 'Scenario Supplier',
    openingBalance: 0
  });
  const supplier = d(supplierRes);

  // 1) Transfer stock: 100 units, casting 100, shipping 1000
  const transferRes = await req('POST', '/inventory/transfer', token, {
    distributorId: distributor._id.toString(),
    supplierId: supplier._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 100 }],
    totalShippingCost: 1000,
    notes: 'Scenario stock transfer'
  });
  const transfer = d(transferRes);

  // 2) Create order: paid qty 50, discounts from entities, bonus auto from scheme
  let orderRes;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      orderRes = await req('POST', '/orders', token, {
        pharmacyId: pharmacy._id.toString(),
        distributorId: distributor._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 50 }],
        notes: 'Scenario order'
      });
      break;
    } catch (e) {
      const msg = e?.response?.data?.message || '';
      if (attempt < 3 && String(msg).includes('Duplicate value for: orderNumber')) {
        await sleep(200);
        continue;
      }
      throw e;
    }
  }
  const order = d(orderRes);

  // 3) Deliver order: full physical qty includes bonus => 60 units
  const deliveryRes = await req('POST', `/orders/${order._id}/deliver`, token, {
    items: [{ productId: product._id.toString(), quantity: 60 }]
  });
  const delivery = d(deliveryRes);

  // 4) Receive full payment (full pharmacy receivable from delivery)
  const fullPaymentAmount = Number(delivery.totalAmount || 0);
  await req('POST', '/payments', token, {
    pharmacyId: pharmacy._id.toString(),
    amount: fullPaymentAmount,
    paymentMethod: 'CASH',
    notes: 'Scenario full payment'
  });

  // 5) Add expense 5000
  await req('POST', '/expenses', token, {
    category: 'OFFICE',
    amount: 5000,
    date: new Date().toISOString(),
    description: 'Scenario expense'
  });

  // 6) Pay supplier partially
  await req('POST', `/suppliers/${supplier._id}/payments`, token, {
    amount: 3000,
    paymentMethod: 'CASH',
    notes: 'Scenario partial supplier payment'
  });

  // Pull system snapshots
  const inv = await DistributorInventory.findOne({
    companyId: me.companyId,
    distributorId: distributor._id,
    productId: product._id
  }).lean();
  const supplierBalance = d(await req('GET', `/suppliers/${supplier._id}/balance`, token));
  const summary = d(await req('GET', '/reports/summary', token));
  const dashboard = d(await req('GET', '/reports/dashboard', token));
  const finSummary = d(await req('GET', '/reports/financial-summary', token));

  // Manual calculations (step-by-step)
  const qtyTransferred = 100;
  const casting = 100;
  const shippingTotal = 1000;
  const shippingPerUnit = shippingTotal / qtyTransferred; // 10
  const unitCost = casting + shippingPerUnit; // 110

  const paidQty = 50;
  const bonusQty = 10;
  const deliveredQty = 60;
  const tp = 200;
  const distributorDiscountPct = 5;
  const pharmacyDiscountPct = 10;

  const grossTP = paidQty * tp; // 10000
  const afterDistributorDiscount = grossTP * (1 - distributorDiscountPct / 100); // 9500
  const revenue = afterDistributorDiscount * (1 - pharmacyDiscountPct / 100); // 8550
  const cogs = deliveredQty * unitCost; // 6600
  const grossProfit = revenue - cogs; // 1950
  const expense = 5000;
  const netProfit = grossProfit - expense; // -3050

  const supplierPurchase = qtyTransferred * casting; // 10000 (supplier purchase uses casting only)
  const supplierPaid = 3000;
  const supplierPayable = supplierPurchase - supplierPaid; // 7000

  const pharmacyReceivable = 0; // full paid
  const distributorPayable = grossTP * (distributorDiscountPct / 100); // 500
  const cashBalance = revenue - expense - supplierPaid; // 550

  const output = {
    scenario: {
      transfer: { qtyTransferred, casting, shippingTotal },
      order: {
        paidQty,
        pharmacyDiscountPct,
        distributorDiscountPct,
        bonusQty
      },
      delivery: { deliveredQty },
      paymentReceived: fullPaymentAmount,
      expenseAdded: expense,
      supplierPaid
    },
    manualCalculation: {
      steps: {
        inventoryUnitCost: `${casting} + (${shippingTotal}/${qtyTransferred}) = ${unitCost}`,
        grossTP: `${paidQty} * ${tp} = ${grossTP}`,
        afterDistributorDiscount: `${grossTP} * (1 - ${distributorDiscountPct}%) = ${afterDistributorDiscount}`,
        revenue: `${afterDistributorDiscount} * (1 - ${pharmacyDiscountPct}%) = ${revenue}`,
        cogs: `${deliveredQty} * ${unitCost} = ${cogs}`,
        grossProfit: `${revenue} - ${cogs} = ${grossProfit}`,
        netProfit: `${grossProfit} - ${expense} = ${netProfit}`,
        supplierPayable: `${supplierPurchase} - ${supplierPaid} = ${supplierPayable}`,
        cashBalance: `${revenue} - ${expense} - ${supplierPaid} = ${cashBalance}`
      },
      final: {
        inventoryCost: cogs,
        revenue,
        profit: netProfit,
        supplierPayable,
        pharmacyReceivable,
        distributorPayable,
        cashBalance
      }
    },
    systemValues: {
      transferId: transfer._id,
      orderId: order._id,
      deliveryId: delivery._id,
      orderTotalBonusQuantity: order.totalBonusQuantity,
      inventory: {
        avgCostPerUnit: inv.avgCostPerUnit,
        remainingQty: inv.quantity
      },
      reports: {
        summary,
        dashboard,
        financialSummary: finSummary
      },
      supplierBalance
    },
    comparison: {
      inventoryCostVsSystemCostTx: {
        manual: cogs,
        system: delivery.totalCost,
        diff: Number((cogs - Number(delivery.totalCost || 0)).toFixed(2))
      },
      revenueVsSystemSale: {
        manual: revenue,
        system: delivery.totalAmount,
        diff: Number((revenue - Number(delivery.totalAmount || 0)).toFixed(2))
      },
      netProfitVsDashboard: {
        manual: netProfit,
        system: Number(dashboard.netProfit || 0),
        diff: Number((netProfit - Number(dashboard.netProfit || 0)).toFixed(2))
      },
      supplierPayable: {
        manual: supplierPayable,
        system: Number(supplierBalance.payable || 0),
        diff: Number((supplierPayable - Number(supplierBalance.payable || 0)).toFixed(2))
      },
      pharmacyReceivableVsFinancialSummary: {
        manual: pharmacyReceivable,
        system: Number(finSummary.totalReceivables || 0),
        diff: Number((pharmacyReceivable - Number(finSummary.totalReceivables || 0)).toFixed(2))
      },
      distributorPayableVsFinancialSummary: {
        manual: distributorPayable,
        system: Number(finSummary.totalDistributorPayables || 0),
        diff: Number((distributorPayable - Number(finSummary.totalDistributorPayables || 0)).toFixed(2))
      },
      cashBalanceVsFinancialSummary: {
        manual: cashBalance,
        system: Number(finSummary.cashInHand || 0),
        diff: Number((cashBalance - Number(finSummary.cashInHand || 0)).toFixed(2))
      }
    }
  };

  console.log(JSON.stringify(output, null, 2));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('SCENARIO_FAILED', e?.response?.data || e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
