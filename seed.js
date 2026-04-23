#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const { roundPKR } = require('./src/utils/currency');
const { generateOrderNumber } = require('./src/utils/orderNumber');
const {
  Company,
  User,
  Product,
  Distributor,
  DistributorInventory,
  StockTransfer,
  Pharmacy,
  Order,
  DeliveryRecord,
  Collection,
  Transaction,
  Expense,
  Payroll,
  Supplier,
  SupplierLedger,
  Settlement,
  Ledger
} = require('./src/models');
const SettlementAllocation = require('./src/models/SettlementAllocation');
const {
  ROLES,
  ORDER_STATUS,
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  COLLECTOR_TYPE,
  SETTLEMENT_DIRECTION,
  LEDGER_REFERENCE_TYPE,
  LEDGER_COLLECTION_PORTION,
  PAYMENT_METHOD,
  EXPENSE_CATEGORY,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE
} = require('./src/constants/enums');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pharma_erp';
const shouldDrop = process.argv.includes('--drop');

const dayMs = 24 * 60 * 60 * 1000;

function createRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function sample(rng, arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i += 1) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function dateDaysAgo(daysAgo, hour = 11) {
  const d = new Date(Date.now() - daysAgo * dayMs);
  d.setHours(hour, randInt(Math.random, 0, 59), randInt(Math.random, 0, 59), 0);
  return d;
}

function dateWithRng(rng, daysAgo, baseHour = 10) {
  const d = new Date(Date.now() - daysAgo * dayMs);
  d.setHours(baseHour + randInt(rng, 0, 6), randInt(rng, 0, 59), randInt(rng, 0, 59), 0);
  return d;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function weightedCollector(rng) {
  return rng() < 0.58 ? COLLECTOR_TYPE.COMPANY : COLLECTOR_TYPE.DISTRIBUTOR;
}

async function createCompanyBundle({ rng, code, index }) {
  const company = await Company.create({
    name: `Pharma ${code} Distribution`,
    address: `${20 + index} Main Commercial Road`,
    city: index === 0 ? 'Karachi' : 'Lahore',
    state: 'Punjab',
    country: 'Pakistan',
    phone: `+92-3${index}0-100200${index}`,
    email: `ops+${code.toLowerCase()}@pharmaerp.pk`,
    currency: 'PKR',
    cashOpeningBalance: index === 0 ? 400000 : 250000
  });

  const permissions = [
    'dashboard.view',
    'products.view',
    'distributors.view',
    'inventory.view',
    'pharmacies.view',
    'orders.view',
    'orders.create',
    'payments.view',
    'payments.create',
    'ledger.view',
    'reports.view',
    'attendance.view',
    'attendance.mark'
  ];

  const admin = await User.create({
    companyId: company._id,
    name: `Admin ${code}`,
    email: `admin.${code.toLowerCase()}@pharmaerp.pk`,
    password: 'Admin@123',
    role: ROLES.ADMIN,
    phone: `+92-300-11${index}11${index}`,
    permissions: []
  });

  const reps = [];
  for (let i = 1; i <= 5; i += 1) {
    reps.push(
      await User.create({
        companyId: company._id,
        name: `${code} Rep ${i}`,
        email: `rep${i}.${code.toLowerCase()}@pharmaerp.pk`,
        password: 'Rep@1234',
        role: ROLES.MEDICAL_REP,
        phone: `+92-321-${index}${i}${i}${i}${i}${i}${i}${i}`,
        permissions,
        createdBy: admin._id
      })
    );
  }

  const productBase = [
    ['Amoxicillin', 500],
    ['Omeprazole', 20],
    ['Metformin', 500],
    ['Ciprofloxacin', 250],
    ['Amlodipine', 5],
    ['Losartan', 50],
    ['Cetirizine', 10],
    ['Azithromycin', 500],
    ['Atorvastatin', 20],
    ['Esomeprazole', 40],
    ['Montelukast', 10],
    ['Paracetamol', 500]
  ];

  const products = [];
  for (let i = 0; i < 24; i += 1) {
    const [name, mg] = productBase[i % productBase.length];
    const casting = randInt(rng, 55, 240);
    const tp = roundPKR(casting * (1.45 + rng() * 0.35));
    const mrp = roundPKR(tp * (1.18 + rng() * 0.2));
    products.push(
      await Product.create({
        companyId: company._id,
        name: `${name} ${mg}mg ${code}-${String(i + 1).padStart(2, '0')}`,
        composition: `${name} ${mg}mg`,
        mrp,
        tp,
        casting,
        tpPercent: roundPKR(((mrp - tp) / mrp) * 100),
        castingPercent: roundPKR((casting / mrp) * 100)
      })
    );
  }

  const distributors = [];
  for (let i = 1; i <= 7; i += 1) {
    const discountOnTP = randInt(rng, 4, 9);
    distributors.push(
      await Distributor.create({
        companyId: company._id,
        name: `${code} Distributor ${i}`,
        address: `Warehouse ${i}, ${company.city}`,
        city: company.city,
        state: company.state,
        phone: `+92-42-${index}${i}${i}${i}${i}${i}${i}`,
        email: `dist${i}.${code.toLowerCase()}@pharmaerp.pk`,
        discountOnTP,
        commissionPercentOnTP: discountOnTP
      })
    );
  }

  const pharmacies = [];
  for (let i = 1; i <= 10; i += 1) {
    pharmacies.push(
      await Pharmacy.create({
        companyId: company._id,
        name: `${code} Pharmacy ${i}`,
        address: `Sector ${i}, ${company.city}`,
        city: company.city,
        state: company.state,
        phone: `+92-51-${index}${i}${i}${i}${i}${i}${i}`,
        email: `pharmacy${i}.${code.toLowerCase()}@pharmaerp.pk`,
        discountOnTP: randInt(rng, 2, 6),
        bonusScheme: { buyQty: 20, getQty: 1 }
      })
    );
  }

  // exactly one supplier per company (tenant-local)
  const supplier = await Supplier.create({
    companyId: company._id,
    name: `${code} Central Supplier`,
    phone: `+92-300-77700${index}`,
    email: `supplier.${code.toLowerCase()}@pharmaerp.pk`,
    address: `Industrial Estate ${index + 1}`,
    openingBalance: 800000,
    createdBy: admin._id
  });

  const inventoryMap = new Map();
  const supplierPurchases = [];

  // 55 stock transfers over last 60 days
  for (let t = 0; t < 55; t += 1) {
    const daysAgo = randInt(rng, 1, 60);
    const transferDate = dateWithRng(rng, daysAgo, 7);
    const distributor = pick(rng, distributors);
    const items = sample(rng, products, randInt(rng, 3, 6)).map((p) => {
      const quantity = randInt(rng, 80, 280);
      const shippingCostPerUnit = randInt(rng, 2, 11);
      return {
        productId: p._id,
        quantity,
        castingAtTime: p.casting,
        shippingCostPerUnit
      };
    });
    const totalShippingCost = roundPKR(items.reduce((s, it) => s + it.quantity * it.shippingCostPerUnit, 0));
    const transfer = await StockTransfer.create({
      companyId: company._id,
      supplierId: supplier._id,
      distributorId: distributor._id,
      items,
      totalShippingCost,
      transferDate,
      notes: `Seed transfer ${t + 1}`,
      createdBy: admin._id
    });

    let purchaseAmount = 0;
    for (const item of items) {
      const key = `${distributor._id}-${item.productId}`;
      const addedCost = roundPKR(item.castingAtTime + item.shippingCostPerUnit);
      purchaseAmount += roundPKR(item.castingAtTime * item.quantity);
      const prev = inventoryMap.get(key) || { quantity: 0, totalCost: 0 };
      prev.quantity += item.quantity;
      prev.totalCost += addedCost * item.quantity;
      inventoryMap.set(key, prev);
    }

    supplierPurchases.push({ amount: roundPKR(purchaseAmount), date: transferDate, transferId: transfer._id });
    await SupplierLedger.create({
      companyId: company._id,
      supplierId: supplier._id,
      type: SUPPLIER_LEDGER_TYPE.PURCHASE,
      amount: roundPKR(purchaseAmount),
      referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.STOCK_TRANSFER,
      referenceId: transfer._id,
      date: transferDate,
      notes: `Purchase posted from stock transfer ${t + 1}`,
      createdBy: admin._id
    });
  }

  for (const [key, val] of inventoryMap.entries()) {
    const [distributorId, productId] = key.split('-');
    await DistributorInventory.create({
      companyId: company._id,
      distributorId,
      productId,
      quantity: val.quantity,
      avgCostPerUnit: roundPKR(val.totalCost / Math.max(1, val.quantity)),
      lastUpdated: new Date()
    });
  }

  const deliveriesByPharmacy = new Map();
  const remittanceLinesByDistributor = new Map();
  const commissionLinesByDistributor = new Map();

  const ordersPerDay = [];
  for (let d = 0; d < 60; d += 1) {
    const weekday = (new Date(Date.now() - d * dayMs)).getDay();
    const base = weekday === 5 ? 4 : weekday === 6 ? 2 : weekday === 1 ? 1 : 3;
    const trendBoost = d > 40 ? 1 : 0;
    const count = Math.max(1, base + trendBoost + (rng() < 0.2 ? 1 : 0));
    ordersPerDay.push({ daysAgo: d, count });
  }

  let orderCount = 0;
  let deliveredCount = 0;
  let collectionCount = 0;
  let invoiceSeq = 1;

  for (const day of ordersPerDay) {
    for (let i = 0; i < day.count; i += 1) {
      orderCount += 1;
      const pharmacy = pick(rng, pharmacies);
      const distributor = pick(rng, distributors);
      const rep = pick(rng, reps);
      const orderDate = dateWithRng(rng, day.daysAgo, 9);

      const orderItems = [];
      const pickedProducts = sample(rng, products, randInt(rng, 2, 4));
      let totalAmount = 0;
      let pharmacyDiscountAmount = 0;
      let afterPharmacy = 0;
      let distributorCommissionAmount = 0;
      let finalCompanyRevenue = 0;
      let totalBonusQty = 0;
      let totalCastingCost = 0;

      for (const p of pickedProducts) {
        const quantity = randInt(rng, 6, 40);
        const distributorDiscount = distributor.discountOnTP;
        const clinicDiscount = pharmacy.discountOnTP;
        const bonusQuantity = quantity >= 20 ? Math.floor(quantity / 20) : 0;
        const grossAmount = roundPKR(p.tp * quantity);
        const pharmacyDiscount = roundPKR(grossAmount * (clinicDiscount / 100));
        const netAfterPharmacy = roundPKR(grossAmount - pharmacyDiscount);
        const distributorCommission = roundPKR(grossAmount * (distributorDiscount / 100));
        const finalAmount = roundPKR(netAfterPharmacy - distributorCommission);
        const invCost = roundPKR(p.casting * (quantity + bonusQuantity));

        totalAmount += grossAmount;
        pharmacyDiscountAmount += pharmacyDiscount;
        afterPharmacy += netAfterPharmacy;
        distributorCommissionAmount += distributorCommission;
        finalCompanyRevenue += finalAmount;
        totalBonusQty += bonusQuantity;
        totalCastingCost += invCost;

        orderItems.push({
          productId: p._id,
          productName: p.name,
          quantity,
          deliveredQty: 0,
          returnedQty: 0,
          tpAtTime: p.tp,
          castingAtTime: p.casting,
          distributorDiscount,
          clinicDiscount,
          bonusScheme: { buyQty: 20, getQty: 1 },
          bonusQuantity,
          grossAmount,
          pharmacyDiscountAmount: pharmacyDiscount,
          netAfterPharmacy,
          distributorCommissionAmount: distributorCommission,
          finalCompanyAmount: finalAmount,
          inventoryCostAmount: invCost
        });
      }

      const orderStatusRoll = rng();
      const intendedStatus =
        orderStatusRoll < 0.88
          ? ORDER_STATUS.DELIVERED
          : orderStatusRoll < 0.95
            ? ORDER_STATUS.PARTIALLY_DELIVERED
            : ORDER_STATUS.PENDING;

      const orderNumber = await generateOrderNumber(Order, company._id, `O${code}`);

      const order = await Order.create({
        companyId: company._id,
        orderNumber,
        pharmacyId: pharmacy._id,
        distributorId: distributor._id,
        medicalRepId: rep._id,
        items: orderItems,
        status: ORDER_STATUS.PENDING,
        totalOrderedAmount: roundPKR(totalAmount),
        totalAmount: roundPKR(totalAmount),
        pharmacyDiscountAmount: roundPKR(pharmacyDiscountAmount),
        amountAfterPharmacyDiscount: roundPKR(afterPharmacy),
        distributorCommissionAmount: roundPKR(distributorCommissionAmount),
        finalCompanyRevenue: roundPKR(finalCompanyRevenue),
        totalBonusQuantity: totalBonusQty,
        totalCastingCost: roundPKR(totalCastingCost),
        createdAt: orderDate,
        updatedAt: orderDate
      });

      if (intendedStatus === ORDER_STATUS.PENDING) {
        continue;
      }

      const deliveredAt = new Date(orderDate.getTime() + randInt(rng, 6, 26) * 60 * 60 * 1000);
      const deliveryItems = [];
      let deliveryRevenue = 0;
      let deliveryCost = 0;
      let deliveryProfit = 0;
      let tpSubtotal = 0;
      let distributorShareTotal = 0;
      let companyShareTotal = 0;

      for (const oi of order.items) {
        const deliveredQty =
          intendedStatus === ORDER_STATUS.PARTIALLY_DELIVERED
            ? Math.max(1, Math.floor(oi.quantity * (0.55 + rng() * 0.25)))
            : oi.quantity;
        const bonusDelivered = intendedStatus === ORDER_STATUS.PARTIALLY_DELIVERED
          ? Math.floor(oi.bonusQuantity * (deliveredQty / oi.quantity))
          : oi.bonusQuantity;

        const invDoc = await DistributorInventory.findOne({
          companyId: company._id,
          distributorId: distributor._id,
          productId: oi.productId
        });
        const avgCostAtTime = invDoc ? invDoc.avgCostPerUnit : oi.castingAtTime;
        const tpLineTotal = roundPKR(oi.tpAtTime * deliveredQty);
        const linePharmacyNet = roundPKR(tpLineTotal * (1 - oi.clinicDiscount / 100) * (1 - oi.distributorDiscount / 100));
        const distributorShare = roundPKR(tpLineTotal * (oi.distributorDiscount / 100));
        const companyShare = roundPKR(linePharmacyNet - distributorShare);
        const unitSelling = roundPKR(linePharmacyNet / Math.max(1, deliveredQty));
        const lineCost = roundPKR(avgCostAtTime * (deliveredQty + bonusDelivered));
        const lineProfit = roundPKR(linePharmacyNet - lineCost);

        deliveryRevenue += linePharmacyNet;
        deliveryCost += lineCost;
        deliveryProfit += lineProfit;
        tpSubtotal += tpLineTotal;
        distributorShareTotal += distributorShare;
        companyShareTotal += companyShare;

        deliveryItems.push({
          productId: oi.productId,
          quantity: deliveredQty,
          avgCostAtTime: roundPKR(avgCostAtTime),
          finalSellingPrice: unitSelling,
          profitPerUnit: roundPKR(lineProfit / Math.max(1, deliveredQty)),
          totalProfit: lineProfit,
          tpLineTotal,
          distributorShare,
          linePharmacyNet,
          companyShare
        });

        oi.deliveredQty = deliveredQty;
        if (invDoc) {
          invDoc.quantity = Math.max(0, invDoc.quantity - deliveredQty - bonusDelivered);
          invDoc.lastUpdated = deliveredAt;
          await invDoc.save();
        }
      }

      const delivery = await DeliveryRecord.create({
        companyId: company._id,
        orderId: order._id,
        invoiceNumber: `INV-${code}-${String(invoiceSeq++).padStart(5, '0')}`,
        items: deliveryItems,
        totalAmount: roundPKR(deliveryRevenue),
        totalCost: roundPKR(deliveryCost),
        totalProfit: roundPKR(deliveryProfit),
        tpSubtotal: roundPKR(tpSubtotal),
        distributorShareTotal: roundPKR(distributorShareTotal),
        pharmacyNetPayable: roundPKR(deliveryRevenue),
        companyShareTotal: roundPKR(companyShareTotal),
        distributorCommissionPercent: distributor.discountOnTP,
        deliveredBy: admin._id,
        deliveredAt
      });

      deliveredCount += 1;
      order.status =
        intendedStatus === ORDER_STATUS.PARTIALLY_DELIVERED ? ORDER_STATUS.PARTIALLY_DELIVERED : ORDER_STATUS.DELIVERED;
      await order.save();

      if (!deliveriesByPharmacy.has(String(pharmacy._id))) deliveriesByPharmacy.set(String(pharmacy._id), []);
      deliveriesByPharmacy.get(String(pharmacy._id)).push({
        orderId: order._id,
        deliveryId: delivery._id,
        distributorId: distributor._id,
        amount: delivery.totalAmount,
        open: delivery.totalAmount,
        companyShareTotal: delivery.companyShareTotal,
        distributorShareTotal: delivery.distributorShareTotal
      });

      await Ledger.create({
        companyId: company._id,
        entityType: LEDGER_ENTITY_TYPE.PHARMACY,
        entityId: pharmacy._id,
        type: LEDGER_TYPE.DEBIT,
        amount: roundPKR(delivery.totalAmount),
        referenceType: LEDGER_REFERENCE_TYPE.ORDER,
        referenceId: order._id,
        description: `Delivery receivable ${order.orderNumber}`,
        date: deliveredAt
      });

      await Transaction.create({
        companyId: company._id,
        type: 'SALE',
        referenceType: LEDGER_REFERENCE_TYPE.DELIVERY,
        referenceId: delivery._id,
        revenue: roundPKR(delivery.totalAmount),
        cost: roundPKR(delivery.totalCost),
        profit: roundPKR(delivery.totalProfit),
        date: deliveredAt,
        description: `Delivery ${delivery.invoiceNumber}`
      });
    }
  }

  // 90 collections with FIFO allocation style
  for (let i = 0; i < 90; i += 1) {
    const pharmacy = pick(rng, pharmacies);
    const key = String(pharmacy._id);
    const queue = deliveriesByPharmacy.get(key) || [];
    const openRows = queue.filter((x) => x.open > 25);
    if (!openRows.length) continue;

    const allocationRows = [];
    let amountLeft = roundPKR(randInt(rng, 1200, 12000));
    for (const row of openRows) {
      if (amountLeft <= 0) break;
      const alloc = roundPKR(Math.min(row.open, amountLeft));
      if (alloc <= 0) continue;
      allocationRows.push({ row, amount: alloc });
      row.open = roundPKR(row.open - alloc);
      amountLeft = roundPKR(amountLeft - alloc);
    }
    const allocated = roundPKR(allocationRows.reduce((s, x) => s + x.amount, 0));
    if (allocated <= 0) continue;

    const collectorType = weightedCollector(rng);
    const isDistributorCollector = collectorType === COLLECTOR_TYPE.DISTRIBUTOR;
    const distributorForCollection = isDistributorCollector
      ? pick(rng, allocationRows.map((x) => x.row.distributorId))
      : null;
    const collectedBy = isDistributorCollector ? pick(rng, reps) : admin;
    const collectionDate = dateWithRng(rng, randInt(rng, 1, 58), 12);

    const collection = await Collection.create({
      companyId: company._id,
      pharmacyId: pharmacy._id,
      distributorId: distributorForCollection,
      collectorType,
      amount: allocated,
      paymentMethod: pick(rng, [PAYMENT_METHOD.CASH, PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.CHEQUE]),
      referenceNumber: `COL-${code}-${String(i + 1).padStart(4, '0')}`,
      collectedBy: collectedBy._id,
      date: collectionDate,
      notes: 'Seed collection',
      allocations: allocationRows.map((x) => ({
        deliveryId: x.row.deliveryId,
        orderId: x.row.orderId,
        distributorId: x.row.distributorId,
        amount: x.amount
      }))
    });

    await Ledger.create({
      companyId: company._id,
      entityType: LEDGER_ENTITY_TYPE.PHARMACY,
      entityId: pharmacy._id,
      type: LEDGER_TYPE.CREDIT,
      amount: allocated,
      referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
      referenceId: collection._id,
      description: `Collection ${collection.referenceNumber}`,
      date: collectionDate
    });

    // Distributor clearing lines
    for (const alloc of allocationRows) {
      const row = alloc.row;
      const companyPart = roundPKR(alloc.amount * (row.companyShareTotal / Math.max(1, row.amount)));
      const commissionPart = roundPKR(alloc.amount * (row.distributorShareTotal / Math.max(1, row.amount)));

      if (isDistributorCollector) {
        const remLine = await Ledger.create({
          companyId: company._id,
          entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          entityId: row.distributorId,
          type: LEDGER_TYPE.DEBIT,
          amount: companyPart,
          referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
          referenceId: collection._id,
          description: 'Distributor collected — remittance due to company',
          date: collectionDate,
          meta: {
            deliveryId: row.deliveryId,
            orderId: row.orderId,
            portion: LEDGER_COLLECTION_PORTION.REMITTANCE_DUE_TO_COMPANY
          }
        });
        await Ledger.create({
          companyId: company._id,
          entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          entityId: row.distributorId,
          type: LEDGER_TYPE.CREDIT,
          amount: commissionPart,
          referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
          referenceId: collection._id,
          description: 'Distributor collected — distributor commission portion',
          date: collectionDate,
          meta: {
            deliveryId: row.deliveryId,
            orderId: row.orderId,
            portion: LEDGER_COLLECTION_PORTION.DISTRIBUTOR_COMMISSION_ON_COLLECTION
          }
        });
        if (!remittanceLinesByDistributor.has(String(row.distributorId))) {
          remittanceLinesByDistributor.set(String(row.distributorId), []);
        }
        remittanceLinesByDistributor.get(String(row.distributorId)).push({ ledgerId: remLine._id, open: companyPart });
      } else {
        const comLine = await Ledger.create({
          companyId: company._id,
          entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          entityId: row.distributorId,
          type: LEDGER_TYPE.CREDIT,
          amount: commissionPart,
          referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
          referenceId: collection._id,
          description: 'Company collected — commission payable to distributor',
          date: collectionDate,
          meta: {
            deliveryId: row.deliveryId,
            orderId: row.orderId,
            portion: LEDGER_COLLECTION_PORTION.COMMISSION_PAYABLE_TO_DISTRIBUTOR
          }
        });
        if (!commissionLinesByDistributor.has(String(row.distributorId))) {
          commissionLinesByDistributor.set(String(row.distributorId), []);
        }
        commissionLinesByDistributor.get(String(row.distributorId)).push({ ledgerId: comLine._id, open: commissionPart });
      }
    }

    collectionCount += 1;
  }

  const settlementAllocations = [];
  let settlementCount = 0;
  const distributorIds = distributors.map((d) => String(d._id));

  for (const did of distributorIds) {
    const remLines = remittanceLinesByDistributor.get(did) || [];
    const commissionLines = commissionLinesByDistributor.get(did) || [];
    const remOpen = roundPKR(remLines.reduce((s, x) => s + x.open, 0));
    const comOpen = roundPKR(commissionLines.reduce((s, x) => s + x.open, 0));

    if (remOpen > 500) {
      const settleAmount = roundPKR(remOpen * (0.45 + rng() * 0.35));
      const settlement = await Settlement.create({
        companyId: company._id,
        distributorId: did,
        direction: SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY,
        amount: settleAmount,
        paymentMethod: PAYMENT_METHOD.BANK_TRANSFER,
        referenceNumber: `SET-D2C-${code}-${did.slice(-4)}`,
        settledBy: admin._id,
        date: dateWithRng(rng, randInt(rng, 1, 20), 15),
        notes: 'Seed settlement from distributor'
      });
      settlementCount += 1;

      await Ledger.create({
        companyId: company._id,
        entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        entityId: did,
        type: LEDGER_TYPE.CREDIT,
        amount: settleAmount,
        referenceType: LEDGER_REFERENCE_TYPE.SETTLEMENT,
        referenceId: settlement._id,
        description: 'Settlement received from distributor',
        date: settlement.date
      });

      let left = settleAmount;
      for (const line of remLines) {
        if (left <= 0) break;
        const alloc = roundPKR(Math.min(line.open, left));
        if (alloc <= 0) continue;
        line.open = roundPKR(line.open - alloc);
        left = roundPKR(left - alloc);
        settlementAllocations.push({
          companyId: company._id,
          settlementId: settlement._id,
          distributorId: did,
          ledgerEntryId: line.ledgerId,
          amount: alloc
        });
      }
    }

    if (comOpen > 300) {
      const settleAmount = roundPKR(comOpen * (0.3 + rng() * 0.35));
      const settlement = await Settlement.create({
        companyId: company._id,
        distributorId: did,
        direction: SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR,
        amount: settleAmount,
        paymentMethod: pick(rng, [PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.CHEQUE]),
        referenceNumber: `SET-C2D-${code}-${did.slice(-4)}`,
        settledBy: admin._id,
        date: dateWithRng(rng, randInt(rng, 1, 16), 16),
        notes: 'Seed settlement to distributor'
      });
      settlementCount += 1;

      await Ledger.create({
        companyId: company._id,
        entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        entityId: did,
        type: LEDGER_TYPE.DEBIT,
        amount: settleAmount,
        referenceType: LEDGER_REFERENCE_TYPE.SETTLEMENT,
        referenceId: settlement._id,
        description: 'Settlement paid to distributor',
        date: settlement.date
      });

      let left = settleAmount;
      for (const line of commissionLines) {
        if (left <= 0) break;
        const alloc = roundPKR(Math.min(line.open, left));
        if (alloc <= 0) continue;
        line.open = roundPKR(line.open - alloc);
        left = roundPKR(left - alloc);
        settlementAllocations.push({
          companyId: company._id,
          settlementId: settlement._id,
          distributorId: did,
          ledgerEntryId: line.ledgerId,
          amount: alloc
        });
      }
    }
  }

  if (settlementAllocations.length) {
    await SettlementAllocation.insertMany(settlementAllocations);
  }

  // Expenses 36 (include negative margin pressure days)
  const expenseRows = [];
  for (let i = 0; i < 36; i += 1) {
    const category = pick(rng, [
      EXPENSE_CATEGORY.LOGISTICS,
      EXPENSE_CATEGORY.OFFICE,
      EXPENSE_CATEGORY.RENT,
      EXPENSE_CATEGORY.OTHER,
      EXPENSE_CATEGORY.DOCTOR_INVESTMENT
    ]);
    const amount =
      i % 11 === 0
        ? randInt(rng, 90000, 145000)
        : randInt(rng, 6000, 36000);
    const date = dateWithRng(rng, randInt(rng, 1, 58), 13);
    const exp = await Expense.create({
      companyId: company._id,
      category,
      amount,
      description: `Seed ${category.toLowerCase().replace('_', ' ')}`,
      date,
      distributorId: rng() < 0.25 ? pick(rng, distributors)._id : undefined,
      approvedBy: admin._id
    });
    expenseRows.push(exp);
    await Transaction.create({
      companyId: company._id,
      type: 'EXPENSE',
      referenceType: 'EXPENSE',
      referenceId: exp._id,
      revenue: 0,
      cost: amount,
      profit: roundPKR(-amount),
      date,
      description: exp.description
    });
  }

  // Payroll + salary expense (two months)
  const payrollMonths = [monthKey(new Date(Date.now() - 30 * dayMs)), monthKey(new Date())];
  for (const m of payrollMonths) {
    for (const rep of reps) {
      const baseSalary = randInt(rng, 60000, 98000);
      const bonus = randInt(rng, 2000, 16000);
      const deductions = randInt(rng, 500, 5500);
      const netSalary = baseSalary + bonus - deductions;
      const paidOn = dateWithRng(rng, randInt(rng, 1, 25), 17);
      await Payroll.create({
        companyId: company._id,
        employeeId: rep._id,
        month: m,
        baseSalary,
        bonus,
        deductions,
        netSalary,
        status: 'PAID',
        paidOn
      });
      const salaryExpense = await Expense.create({
        companyId: company._id,
        category: EXPENSE_CATEGORY.SALARY,
        amount: netSalary,
        description: `Salary ${rep.name} ${m}`,
        date: paidOn,
        employeeId: rep._id,
        approvedBy: admin._id
      });
      await Transaction.create({
        companyId: company._id,
        type: 'EXPENSE',
        referenceType: 'EXPENSE',
        referenceId: salaryExpense._id,
        revenue: 0,
        cost: netSalary,
        profit: roundPKR(-netSalary),
        date: paidOn,
        description: `Salary ${rep.name}`
      });
    }
  }

  // Supplier payments (less than purchases => payable remains > 0)
  const purchaseTotal = roundPKR(supplierPurchases.reduce((s, x) => s + x.amount, 0) + supplier.openingBalance);
  let paymentTotal = 0;
  for (let i = 0; i < 12; i += 1) {
    const amount = randInt(rng, 50000, 180000);
    paymentTotal += amount;
    await SupplierLedger.create({
      companyId: company._id,
      supplierId: supplier._id,
      type: SUPPLIER_LEDGER_TYPE.PAYMENT,
      amount,
      referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.MANUAL,
      referenceId: new mongoose.Types.ObjectId(),
      date: dateWithRng(rng, randInt(rng, 1, 50), 18),
      notes: 'Seed supplier payment',
      createdBy: admin._id,
      paymentMethod: pick(rng, ['BANK', 'CHEQUE', 'CASH']),
      referenceNumber: `SUP-${code}-${String(i + 1).padStart(3, '0')}`
    });
  }

  return {
    company,
    admin,
    reps,
    counts: {
      products: products.length,
      distributors: distributors.length,
      pharmacies: pharmacies.length,
      stockTransfers: 55,
      orders: orderCount,
      deliveries: deliveredCount,
      collections: collectionCount,
      expenses: expenseRows.length + reps.length * payrollMonths.length,
      supplierLedger: supplierPurchases.length + 12,
      settlements: settlementCount
    },
    supplierPayableEstimate: roundPKR(purchaseTotal - paymentTotal)
  };
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  if (shouldDrop) {
    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const col of collections) {
      await mongoose.connection.db.dropCollection(col.name);
    }
    console.log('Dropped all collections');
  }

  const rngA = createRng(20260422);
  const rngB = createRng(20260423);

  const companyA = await createCompanyBundle({ rng: rngA, code: 'NOVA', index: 0 });
  const companyB = await createCompanyBundle({ rng: rngB, code: 'ORBIT', index: 1 });

  const platform = await Company.create({
    name: 'Platform Administration',
    address: 'Internal',
    city: 'Lahore',
    state: 'Punjab',
    country: 'Pakistan',
    phone: '+92-300-0000000',
    email: 'platform.internal@local',
    currency: 'PKR',
    isActive: true
  });
  await User.create({
    companyId: platform._id,
    activeCompanyId: companyA.company._id,
    name: 'Super Admin',
    email: 'superadmin@platform.local',
    password: 'Super@123',
    role: ROLES.SUPER_ADMIN,
    phone: '+92-300-9999999',
    permissions: []
  });

  console.log('\n================ SEED SUMMARY ================');
  for (const info of [companyA, companyB]) {
    console.log(`\nCompany: ${info.company.name}`);
    Object.entries(info.counts).forEach(([k, v]) => console.log(`  ${k.padEnd(14)}: ${v}`));
    console.log(`  supplierPayable : ${info.supplierPayableEstimate}`);
    console.log(`  admin login     : ${info.admin.email} / Admin@123`);
  }
  console.log('\nSuper Admin: superadmin@platform.local / Super@123');
  console.log('=============================================\n');

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
