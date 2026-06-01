const { ACCOUNT_GROUP_TYPE } = require('./enums');

/**
 * Standard Pakistani pharma distributor/manufacturer COA seed.
 * Codes are stable — glBridge resolves accounts by code per company.
 */
const DEFAULT_COA = [
  { code: '1000', name: 'Assets', groupType: ACCOUNT_GROUP_TYPE.ASSET, isGroup: true, parentCode: null },
  { code: '1100', name: 'Current Assets', groupType: ACCOUNT_GROUP_TYPE.ASSET, isGroup: true, parentCode: '1000' },
  {
    code: '1110',
    name: 'Cash in Hand',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isGroup: false,
    parentCode: '1100',
    isCash: true,
    isMoneyAccount: true,
    moneyAccountNature: 'CASH',
    isControlAccount: false
  },
  {
    code: '1120',
    name: 'Bank Account',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isGroup: false,
    parentCode: '1100',
    isBank: true,
    isMoneyAccount: true,
    moneyAccountNature: 'BANK',
    isControlAccount: false
  },
  {
    code: '1130',
    name: 'Accounts Receivable',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isGroup: false,
    parentCode: '1100',
    isControlAccount: true,
    linkedEntityType: 'PHARMACY'
  },
  {
    code: '1140',
    name: 'Inventory',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isGroup: false,
    parentCode: '1100',
    isControlAccount: false
  },
  { code: '1200', name: 'Fixed Assets', groupType: ACCOUNT_GROUP_TYPE.ASSET, isGroup: true, parentCode: '1000' },
  {
    code: '1210',
    name: 'Plant & Machinery',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isGroup: false,
    parentCode: '1200'
  },

  { code: '2000', name: 'Liabilities', groupType: ACCOUNT_GROUP_TYPE.LIABILITY, isGroup: true, parentCode: null },
  { code: '2100', name: 'Current Liabilities', groupType: ACCOUNT_GROUP_TYPE.LIABILITY, isGroup: true, parentCode: '2000' },
  {
    code: '2110',
    name: 'Accounts Payable',
    groupType: ACCOUNT_GROUP_TYPE.LIABILITY,
    isGroup: false,
    parentCode: '2100',
    isControlAccount: true,
    linkedEntityType: 'SUPPLIER'
  },
  {
    code: '2120',
    name: 'Distributor Clearing Payable',
    groupType: ACCOUNT_GROUP_TYPE.LIABILITY,
    isGroup: false,
    parentCode: '2100',
    isControlAccount: true,
    linkedEntityType: 'DISTRIBUTOR_CLEARING'
  },

  { code: '3000', name: 'Equity', groupType: ACCOUNT_GROUP_TYPE.EQUITY, isGroup: true, parentCode: null },
  {
    code: '3100',
    name: 'Retained Earnings',
    groupType: ACCOUNT_GROUP_TYPE.EQUITY,
    isGroup: false,
    parentCode: '3000'
  },
  {
    code: '3200',
    name: 'Owner Capital',
    groupType: ACCOUNT_GROUP_TYPE.EQUITY,
    isGroup: false,
    parentCode: '3000'
  },

  { code: '4000', name: 'Income', groupType: ACCOUNT_GROUP_TYPE.INCOME, isGroup: true, parentCode: null },
  {
    code: '4100',
    name: 'Sales Revenue',
    groupType: ACCOUNT_GROUP_TYPE.INCOME,
    isGroup: false,
    parentCode: '4000'
  },
  {
    code: '4200',
    name: 'Sales Returns',
    groupType: ACCOUNT_GROUP_TYPE.INCOME,
    isGroup: false,
    parentCode: '4000'
  },

  { code: '5000', name: 'Cost of Sales', groupType: ACCOUNT_GROUP_TYPE.EXPENSE, isGroup: true, parentCode: null },
  {
    code: '5100',
    name: 'Cost of Goods Sold',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: false,
    parentCode: '5000'
  },

  { code: '6000', name: 'Operating Expenses', groupType: ACCOUNT_GROUP_TYPE.EXPENSE, isGroup: true, parentCode: null },
  {
    code: '6100',
    name: 'General Operating Expenses',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: false,
    parentCode: '6000'
  },
  {
    code: '6110',
    name: 'Salary Expense',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: false,
    parentCode: '6000'
  },
  {
    code: '6120',
    name: 'Rent Expense',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: false,
    parentCode: '6000'
  },
  {
    code: '6130',
    name: 'Logistics Expense',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: false,
    parentCode: '6000'
  }
];

/** Well-known account codes for GL posting adapters. */
const ACCOUNT_CODES = {
  CASH: '1110',
  BANK: '1120',
  ACCOUNTS_RECEIVABLE: '1130',
  INVENTORY: '1140',
  ACCOUNTS_PAYABLE: '2110',
  DISTRIBUTOR_CLEARING: '2120',
  RETAINED_EARNINGS: '3100',
  SALES_REVENUE: '4100',
  SALES_RETURNS: '4200',
  COGS: '5100',
  OPERATING_EXPENSE: '6100',
  SALARY_EXPENSE: '6110',
  RENT_EXPENSE: '6120',
  LOGISTICS_EXPENSE: '6130'
};

module.exports = { DEFAULT_COA, ACCOUNT_CODES };
