const { ACCOUNT_GROUP_TYPE, MONEY_ACCOUNT_NATURE } = require('./enums');

/**
 * Business-friendly account types → GL structure (auto-generated).
 * Users never see codes, parents, or group types.
 */
const SIMPLE_ACCOUNT_TYPE = {
  BANK: 'BANK',
  CASH: 'CASH',
  EXPENSE: 'EXPENSE',
  INCOME: 'INCOME',
  INVENTORY: 'INVENTORY',
  SUPPLIER_PAYABLE: 'SUPPLIER_PAYABLE',
  CUSTOMER_RECEIVABLE: 'CUSTOMER_RECEIVABLE'
};

/** Money types creatable with payments.create only */
const MONEY_SIMPLE_TYPES = [SIMPLE_ACCOUNT_TYPE.BANK, SIMPLE_ACCOUNT_TYPE.CASH];

const SIMPLE_ACCOUNT_TEMPLATES = {
  [SIMPLE_ACCOUNT_TYPE.BANK]: {
    label: 'Bank Account',
    parentCode: '1100',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isBank: true,
    isMoneyAccount: true,
    moneyAccountNature: MONEY_ACCOUNT_NATURE.BANK,
    codeRange: { start: 1121, end: 1199 }
  },
  [SIMPLE_ACCOUNT_TYPE.CASH]: {
    label: 'Cash Account',
    parentCode: '1100',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    isCash: true,
    isMoneyAccount: true,
    moneyAccountNature: MONEY_ACCOUNT_NATURE.CASH,
    codeRange: { start: 1111, end: 1119 }
  },
  [SIMPLE_ACCOUNT_TYPE.EXPENSE]: {
    label: 'Expense Category',
    parentCode: '6000',
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    codeRange: { start: 6140, end: 6199 }
  },
  [SIMPLE_ACCOUNT_TYPE.INCOME]: {
    label: 'Income Category',
    parentCode: '4000',
    groupType: ACCOUNT_GROUP_TYPE.INCOME,
    codeRange: { start: 4300, end: 4399 }
  },
  [SIMPLE_ACCOUNT_TYPE.INVENTORY]: {
    label: 'Inventory / Asset',
    parentCode: '1100',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    codeRange: { start: 1150, end: 1154 }
  },
  [SIMPLE_ACCOUNT_TYPE.SUPPLIER_PAYABLE]: {
    label: 'Other Payable',
    parentCode: '2100',
    groupType: ACCOUNT_GROUP_TYPE.LIABILITY,
    codeRange: { start: 2130, end: 2149 }
  },
  [SIMPLE_ACCOUNT_TYPE.CUSTOMER_RECEIVABLE]: {
    label: 'Other Receivable',
    parentCode: '1100',
    groupType: ACCOUNT_GROUP_TYPE.ASSET,
    codeRange: { start: 1160, end: 1169 }
  }
};

module.exports = { SIMPLE_ACCOUNT_TYPE, SIMPLE_ACCOUNT_TEMPLATES, MONEY_SIMPLE_TYPES };
