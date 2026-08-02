const mongoose = require('mongoose');
const Account = require('../../models/Account');
const { ACCOUNT_GROUP_TYPE } = require('../../constants/enums');
const { TAX_ACCOUNT_CODES } = require('../../constants/taxCatalog');
const { ensureCoaForCompany } = require('../coaSeed.service');

const TAX_LIABILITY_DEFS = [
  {
    code: TAX_ACCOUNT_CODES.ADVANCE_TAX_PAYABLE,
    name: 'Advance Tax Payable',
    parentCode: '2100',
    groupType: ACCOUNT_GROUP_TYPE.LIABILITY
  }
];

/**
 * Ensure tax liability accounts exist for a company (additive; safe when COA already seeded).
 */
const ensureTaxLiabilityAccounts = async (companyId, reqUser = null, session = null) => {
  const cid =
    companyId instanceof mongoose.Types.ObjectId
      ? companyId
      : new mongoose.Types.ObjectId(String(companyId));

  await ensureCoaForCompany(cid, { createdBy: reqUser?.userId || null, session });

  const opts = session ? { session } : {};
  const created = [];

  for (const def of TAX_LIABILITY_DEFS) {
    const existing = await Account.findOne({
      companyId: cid,
      code: def.code,
      isDeleted: { $ne: true }
    }).session(session || null);
    if (existing) continue;

    let parentId = null;
    if (def.parentCode) {
      const parent = await Account.findOne({
        companyId: cid,
        code: def.parentCode,
        isDeleted: { $ne: true }
      })
        .session(session || null)
        .lean();
      parentId = parent?._id || null;
    }

    const [row] = await Account.create(
      [
        {
          companyId: cid,
          code: def.code,
          name: def.name,
          groupType: def.groupType,
          parentId,
          isGroup: false,
          isControlAccount: false,
          isSystem: true,
          isActive: true,
          openingBalance: 0,
          currentBalance: 0,
          createdBy: reqUser?.userId || null
        }
      ],
      opts
    );
    created.push(row);
  }

  return { created: created.length, codes: TAX_LIABILITY_DEFS.map((d) => d.code) };
};

module.exports = { ensureTaxLiabilityAccounts, TAX_LIABILITY_DEFS };
