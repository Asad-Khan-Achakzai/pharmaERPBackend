const FINANCIAL_MODEL = 'ERP_STANDARD_V1';

const FINANCIAL_SCOPE = {
  SNAPSHOT: 'snapshot',
  PERIOD: 'period',
  LINE: 'line'
};

const FINANCIAL_SCHEMA = {
  revenue: { gross: 'revenueGross' },
  profit: {
    grossOperational: 'profitGrossOperational',
    netFinal: 'profitNetFinal',
    marginPercent: 'profitMarginPercent'
  },
  cash: {
    balanceSnapshot: 'cashBalanceSnapshot',
    openingBalance: 'cashOpeningBalance',
    movementPeriod: 'cashMovementPeriod'
  },
  supplier: { payableTotal: 'supplierPayableTotal' },
  distributor: { commissionPayableTotal: 'distributorCommissionPayableTotal' },
  pharmacy: { receivableTotal: 'pharmacyReceivableTotal' },
  expenses: {
    operatingTotal: 'expenseOperatingTotal',
    payrollTotal: 'expensePayrollTotal'
  },
  inventory: { costOfGoodsSold: 'inventoryCostOfGoodsSold' }
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const canonicalFromDashboard = (data = {}) => ({
  revenueGross: num(data.totalSales),
  profitGrossOperational: num(data.grossProfit),
  profitNetFinal: num(data.netProfit),
  expenseOperatingTotal: num(data.totalExpenses),
  expensePayrollTotal: num(data.totalPayroll),
  distributorCommissionPayableTotal: num(data.distributorCommissionTotal),
  pharmacyReceivableTotal: num(data.totalOutstanding),
  ordersByStatus: data.ordersByStatus || {},
  bonusUnitsDelivered: num(data.totalBonusGiven)
});

const canonicalFromProfit = (data = {}) => {
  const revenueGross = Array.isArray(data.breakdown)
    ? data.breakdown.reduce((sum, row) => sum + num(row?.revenue), 0)
    : 0;
  return {
    revenueGross,
    profitGrossOperational: num(data.grossProfit),
    profitNetFinal: num(data.netProfit),
    expenseOperatingTotal: num(data.totalExpenses),
    expensePayrollTotal: num(data.totalPayroll),
    distributorCommissionPayableTotal: num(data.distributorCommissionTotal)
  };
};

const canonicalFromSummary = (data = {}) => ({
  revenueGross: num(data.totalRevenue),
  profitGrossOperational: num(data.grossProfit),
  profitNetFinal: num(data.netProfit),
  profitMarginPercent: data.profitMarginPercent ?? null,
  inventoryCostOfGoodsSold: num(data.breakdown?.productCost),
  expenseOperatingTotal: num(data.breakdown?.otherExpenses),
  expensePayrollTotal: num(data.breakdown?.payrollCost),
  distributorCommissionPayableTotal: num(data.breakdown?.distributorCommissionCost),
  cashMovementPeriod: num(data.liquidity?.netCashMovementInPeriod),
  pharmacyReceivableTotal: num(data.liquidity?.snapshot?.outstandingReceivableFromPharmacies)
});

const canonicalFromTrends = (data = {}) => ({
  granularity: data.granularity || 'month',
  lines: Array.isArray(data.series)
    ? data.series.map((row) => ({
        periodKey: row.period || null,
        revenueGross: num(row.revenue),
        profitGrossOperational: num(row.grossProfit),
        profitNetFinal: num(row.netProfit),
        inventoryCostOfGoodsSold: num(row.breakdown?.productCost),
        expenseOperatingTotal: num(row.breakdown?.otherExpenses),
        expensePayrollTotal: num(row.breakdown?.payrollCost),
        distributorCommissionPayableTotal: num(row.breakdown?.distributorCommissionCost)
      }))
    : []
});

const withFinancialEnvelope = ({ data, scope, canonical }) => ({
  ...data,
  financialModel: FINANCIAL_MODEL,
  scope,
  canonical
});

module.exports = {
  FINANCIAL_MODEL,
  FINANCIAL_SCOPE,
  FINANCIAL_SCHEMA,
  canonicalFromDashboard,
  canonicalFromProfit,
  canonicalFromSummary,
  canonicalFromTrends,
  withFinancialEnvelope
};
