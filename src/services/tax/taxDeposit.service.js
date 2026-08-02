const mongoose = require('mongoose');
const TaxDeposit = require('../../models/TaxDeposit');
const TaxRegisterEntry = require('../../models/TaxRegisterEntry');
const DeliveryRecord = require('../../models/DeliveryRecord');
const ApiError = require('../../utils/ApiError');
const { roundPKR } = require('../../utils/currency');
const { getNextSequenceNumber } = require('../../utils/orderNumber');
const auditService = require('../audit.service');
const taxCoa = require('./taxCoa.service');
const glPosting = require('../glPosting.service');
const moneyAccountService = require('../moneyAccount.service');
const mediaAttach = require('../media.attach');
const MediaAsset = require('../../models/MediaAsset');
const { VOUCHER_TYPE, GL_SOURCE_MODULE } = require('../../constants/enums');
const {
  TAX_DEPOSIT_STATUS,
  TAX_REGISTER_STATUS,
  TAX_REGISTER_ENTRY_TYPE
} = require('../../constants/taxCatalog');

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const userId = (reqUser) => reqUser?.userId || reqUser?._id || null;

const assertDraft = (deposit) => {
  if (deposit.status !== TAX_DEPOSIT_STATUS.DRAFT) {
    throw new ApiError(400, 'Submitted remittances are immutable. Cancel drafts only, or reverse a submitted remittance.');
  }
};

const enrichDepositReceipt = async (companyId, deposit) => {
  if (!deposit) return deposit;
  const out = { ...deposit };
  if (deposit.receiptAttachment?.mediaAssetId) {
    const image = await mediaAttach.resolveEntityImage({
      companyId,
      resource: 'tax-deposits',
      id: deposit._id
    });
    if (image?.url) {
      out.receiptAttachment = {
        ...(deposit.receiptAttachment || {}),
        url: image.url,
        mimeType: image.mime || deposit.receiptAttachment?.mimeType || '',
        mediaAssetId: image.assetId
      };
    }
  }
  // UI-facing aliases
  out.remittanceNumber = deposit.depositNumber;
  out.isComplete = [TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED].includes(deposit.status);
  out.canReverse = [TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED].includes(deposit.status);
  out.canEdit = deposit.status === TAX_DEPOSIT_STATUS.DRAFT;
  return out;
};

const resolveLiabilityCode = async (entry, session) => {
  let liabCode = '2140';
  if (entry.deliveryId && entry.snapshotLineRef != null) {
    const del = await DeliveryRecord.findById(entry.deliveryId)
      .select('taxSnapshot')
      .session(session)
      .lean();
    const line = (del?.taxSnapshot?.lines || []).find((l) => l.sequence === entry.snapshotLineRef);
    if (line?.liabilityAccountCode) liabCode = line.liabilityAccountCode;
  }
  return liabCode;
};

const listDeposits = async (companyId, query = {}) => {
  const filter = { companyId: oid(companyId), isDeleted: { $ne: true } };
  if (query.status) filter.status = query.status;
  if (query.search) {
    const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ depositNumber: rx }, { paymentReference: rx }, { governmentAuthority: rx }];
  }
  const rows = await TaxDeposit.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(query.limit) || 100, 500))
    .populate('createdBy', 'name')
    .populate('submittedBy', 'name')
    .populate('moneyAccountId', 'name code')
    .lean();
  return { rows, count: rows.length };
};

const getDeposit = async (companyId, depositId) => {
  const deposit = await TaxDeposit.findOne({
    _id: oid(depositId),
    companyId: oid(companyId),
    isDeleted: { $ne: true }
  })
    .populate('createdBy', 'name')
    .populate('submittedBy', 'name')
    .populate('moneyAccountId', 'name code')
    .lean();
  if (!deposit) throw new ApiError(404, 'Tax remittance not found');

  const entries = await TaxRegisterEntry.find({
    companyId: oid(companyId),
    taxDepositId: deposit._id,
    isDeleted: { $ne: true },
    entryType: {
      $in: [
        TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
        TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
        TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
      ]
    }
  })
    .populate('pharmacyId', 'name')
    .sort({ businessDate: 1 })
    .lean();

  const enriched = await enrichDepositReceipt(companyId, deposit);
  return { ...enriched, entries };
};

const createDeposit = async (companyId, body, reqUser) => {
  const depositNumber = await getNextSequenceNumber(companyId, 'TR');
  const [deposit] = await TaxDeposit.create([
    {
      companyId: oid(companyId),
      depositNumber,
      governmentAuthority: body.governmentAuthority || 'FBR',
      taxPeriodFrom: body.taxPeriodFrom ? new Date(body.taxPeriodFrom) : null,
      taxPeriodTo: body.taxPeriodTo ? new Date(body.taxPeriodTo) : null,
      paymentDate: body.paymentDate ? new Date(body.paymentDate) : null,
      paymentReference: body.paymentReference || '',
      bankReference: body.bankReference || '',
      moneyAccountId: body.moneyAccountId ? oid(body.moneyAccountId) : null,
      notes: body.notes || '',
      status: TAX_DEPOSIT_STATUS.DRAFT,
      currency: body.currency || 'PKR',
      createdBy: userId(reqUser),
      updatedBy: userId(reqUser)
    }
  ]);

  await auditService.log({
    companyId,
    userId: userId(reqUser),
    action: 'TAX_DEPOSIT_CREATED',
    entityType: 'TaxDeposit',
    entityId: deposit._id,
    changes: { depositNumber, status: TAX_DEPOSIT_STATUS.DRAFT }
  });

  let entryIds = Array.isArray(body.registerEntryIds) ? body.registerEntryIds.map(String) : [];
  // Default: auto-select all eligible OPEN register entries (ERP remittance behaviour).
  if (!entryIds.length && body.autoSelectAll !== false) {
    const open = await listOpenEntries(companyId, {});
    entryIds = (open.rows || []).map((r) => String(r._id));
  }

  if (entryIds.length) {
    return addEntries(companyId, deposit._id, entryIds, reqUser);
  }
  return getDeposit(companyId, deposit._id);
};

const updateDeposit = async (companyId, depositId, body, reqUser) => {
  const deposit = await TaxDeposit.findOne({
    _id: oid(depositId),
    companyId: oid(companyId),
    isDeleted: { $ne: true }
  });
  if (!deposit) throw new ApiError(404, 'Tax remittance not found');
  assertDraft(deposit);

  const fields = [
    'governmentAuthority',
    'paymentReference',
    'bankReference',
    'notes',
    'currency'
  ];
  for (const f of fields) {
    if (body[f] !== undefined) deposit[f] = body[f];
  }
  if (body.taxPeriodFrom !== undefined) {
    deposit.taxPeriodFrom = body.taxPeriodFrom ? new Date(body.taxPeriodFrom) : null;
  }
  if (body.taxPeriodTo !== undefined) {
    deposit.taxPeriodTo = body.taxPeriodTo ? new Date(body.taxPeriodTo) : null;
  }
  if (body.paymentDate !== undefined) {
    deposit.paymentDate = body.paymentDate ? new Date(body.paymentDate) : null;
  }
  if (body.moneyAccountId !== undefined) {
    deposit.moneyAccountId = body.moneyAccountId ? oid(body.moneyAccountId) : null;
  }
  deposit.updatedBy = userId(reqUser);
  await deposit.save();

  await auditService.log({
    companyId,
    userId: userId(reqUser),
    action: 'TAX_DEPOSIT_UPDATED',
    entityType: 'TaxDeposit',
    entityId: deposit._id,
    changes: body
  });

  return getDeposit(companyId, deposit._id);
};

const addEntries = async (companyId, depositId, entryIds, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deposit = await TaxDeposit.findOne({
      _id: oid(depositId),
      companyId: oid(companyId),
      isDeleted: { $ne: true }
    }).session(session);
    if (!deposit) throw new ApiError(404, 'Tax remittance not found');
    assertDraft(deposit);

    const ids = (entryIds || []).map(oid);
    const entries = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      _id: { $in: ids },
      isDeleted: { $ne: true }
    }).session(session);

    if (entries.length !== ids.length) {
      throw new ApiError(400, 'One or more tax register entries were not found');
    }

    for (const e of entries) {
      if (e.status !== TAX_REGISTER_STATUS.OPEN) {
        throw new ApiError(
          400,
          `Entry ${e.invoiceNumber || e._id} is not open for deposit (status ${e.status})`
        );
      }
      if (
        ![
          TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
          TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
          TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
        ].includes(e.entryType)
      ) {
        throw new ApiError(400, `Entry type ${e.entryType} cannot be included in a deposit`);
      }
      if (e.taxDepositId && String(e.taxDepositId) !== String(deposit._id)) {
        throw new ApiError(400, `Entry already linked to another deposit`);
      }

      e.status = TAX_REGISTER_STATUS.INCLUDED_IN_DEPOSIT;
      e.taxDepositId = deposit._id;
      e.depositNumber = deposit.depositNumber;
      e.depositDate = null;
      e.updatedBy = userId(reqUser);
      await e.save({ session });
    }

    const linked = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      taxDepositId: deposit._id,
      isDeleted: { $ne: true }
    }).session(session);

    deposit.registerEntryIds = linked.map((e) => e._id);
    deposit.amount = roundPKR(linked.reduce((s, e) => s + (e.taxAmount || 0), 0));
    if (deposit.amount <= 0) {
      throw new ApiError(400, 'Deposit total must be positive after selecting entries');
    }
    deposit.updatedBy = userId(reqUser);
    await deposit.save({ session });

    await session.commitTransaction();
    return getDeposit(companyId, deposit._id);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const removeEntry = async (companyId, depositId, entryId, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deposit = await TaxDeposit.findOne({
      _id: oid(depositId),
      companyId: oid(companyId),
      isDeleted: { $ne: true }
    }).session(session);
    if (!deposit) throw new ApiError(404, 'Tax remittance not found');
    assertDraft(deposit);

    const entry = await TaxRegisterEntry.findOne({
      _id: oid(entryId),
      companyId: oid(companyId),
      taxDepositId: deposit._id,
      isDeleted: { $ne: true }
    }).session(session);
    if (!entry) throw new ApiError(404, 'Register entry not linked to this deposit');

    entry.status = TAX_REGISTER_STATUS.OPEN;
    entry.taxDepositId = null;
    entry.depositNumber = '';
    entry.depositDate = null;
    entry.updatedBy = userId(reqUser);
    await entry.save({ session });

    const linked = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      taxDepositId: deposit._id,
      isDeleted: { $ne: true }
    }).session(session);
    deposit.registerEntryIds = linked.map((e) => e._id);
    deposit.amount = roundPKR(linked.reduce((s, e) => s + (e.taxAmount || 0), 0));
    deposit.updatedBy = userId(reqUser);
    await deposit.save({ session });

    await session.commitTransaction();
    return getDeposit(companyId, deposit._id);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const submitDeposit = async (companyId, depositId, body, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deposit = await TaxDeposit.findOne({
      _id: oid(depositId),
      companyId: oid(companyId),
      isDeleted: { $ne: true }
    }).session(session);
    if (!deposit) throw new ApiError(404, 'Tax remittance not found');
    assertDraft(deposit);

    const moneyAccountId = body.moneyAccountId || deposit.moneyAccountId;
    if (!moneyAccountId) throw new ApiError(400, 'Money account (bank/cash) is required');

    const moneyAccount = await moneyAccountService.assertMoneyAccount(
      companyId,
      moneyAccountId,
      session
    );

    const entries = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      taxDepositId: deposit._id,
      status: TAX_REGISTER_STATUS.INCLUDED_IN_DEPOSIT,
      isDeleted: { $ne: true }
    }).session(session);

    if (!entries.length) throw new ApiError(400, 'Select at least one tax register entry before submit');

    const amount = roundPKR(entries.reduce((s, e) => s + (e.taxAmount || 0), 0));
    if (amount <= 0) throw new ApiError(400, 'Remittance amount must be positive');

    // Prevent duplicate remittance
    for (const e of entries) {
      if (e.status === TAX_REGISTER_STATUS.REMITTED || e.status === TAX_REGISTER_STATUS.CLEARED) {
        throw new ApiError(400, 'One or more entries were already remitted');
      }
    }

    await taxCoa.ensureTaxLiabilityAccounts(companyId, reqUser, session);

    const accountDebits = {};
    for (const e of entries) {
      // Only debit liability for positive tax (invoice); negatives reduce net amount already
      if ((e.taxAmount || 0) <= 0) continue;
      const code = await resolveLiabilityCode(e, session);
      accountDebits[code] = roundPKR((accountDebits[code] || 0) + e.taxAmount);
    }

    // If net includes negative reversals, reduce debit proportionally from first account
    const positiveSum = roundPKR(Object.values(accountDebits).reduce((s, v) => s + v, 0));
    if (positiveSum + 0.001 < amount) {
      // amount includes negatives; adjust — amount is net of all entries
    }
    const netPositive = roundPKR(
      entries.filter((e) => e.taxAmount > 0).reduce((s, e) => s + e.taxAmount, 0)
    );
    const netNegative = roundPKR(
      Math.abs(entries.filter((e) => e.taxAmount < 0).reduce((s, e) => s + e.taxAmount, 0))
    );
    // GL: Dr liability for net remittance amount (what we pay government)
    // When depositing only positive invoice tax, debit = amount.
    // Negatives in same deposit reduce cash paid.
    if (amount <= 0) throw new ApiError(400, 'Net deposit amount must be positive');

    const lines = [];
    if (netNegative > 0 && netPositive > 0) {
      // Scale debits to net amount
      for (const [code, debitAmt] of Object.entries(accountDebits)) {
        const scaled = roundPKR((debitAmt / netPositive) * amount);
        if (scaled <= 0) continue;
        const acc = await glPosting.getAccountByCode(companyId, code, session);
        if (!acc) throw new ApiError(400, `Tax liability account ${code} not found`);
        lines.push({ accountId: acc._id, debit: scaled, credit: 0 });
      }
    } else {
      for (const [code, debitAmt] of Object.entries(accountDebits)) {
        if (debitAmt <= 0) continue;
        const acc = await glPosting.getAccountByCode(companyId, code, session);
        if (!acc) throw new ApiError(400, `Tax liability account ${code} not found`);
        lines.push({ accountId: acc._id, debit: debitAmt, credit: 0 });
      }
    }
    lines.push({ accountId: moneyAccount._id, debit: 0, credit: amount });

    const paymentDate = body.paymentDate
      ? new Date(body.paymentDate)
      : deposit.paymentDate || new Date();

    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.PV,
        date: paymentDate,
        narration:
          body.narration ||
          deposit.notes ||
          `Tax remittance ${deposit.depositNumber} to ${deposit.governmentAuthority || 'government'}`,
        lines,
        sourceModule: GL_SOURCE_MODULE.TAX_DEPOSIT,
        sourceRefId: deposit._id,
        moneyAccountId: moneyAccount._id,
        moneyAccountNature: moneyAccount.moneyAccountNature
      },
      reqUser,
      session
    );

    const paymentDateFinal = paymentDate;
    // Remittance is settlement of existing liability — update register rows in place.
    // Do NOT create Tax Register REMITTANCE rows (those are not tax events).
    for (const e of entries) {
      e.status = TAX_REGISTER_STATUS.REMITTED;
      e.depositNumber = deposit.depositNumber;
      e.depositDate = paymentDateFinal;
      e.taxDepositId = deposit._id;
      e.remittanceId = voucher._id;
      e.updatedBy = userId(reqUser);
      // Do NOT mutate taxAmount
      await e.save({ session });
    }

    if (body.paymentReference !== undefined) deposit.paymentReference = body.paymentReference;
    if (body.bankReference !== undefined) deposit.bankReference = body.bankReference;
    if (body.governmentAuthority !== undefined) {
      deposit.governmentAuthority = body.governmentAuthority;
    }

    deposit.moneyAccountId = moneyAccount._id;
    deposit.amount = amount;
    deposit.paymentDate = paymentDateFinal;
    deposit.voucherId = voucher._id;
    deposit.status = TAX_DEPOSIT_STATUS.SUBMITTED;
    deposit.submittedAt = new Date();
    deposit.submittedBy = userId(reqUser);
    deposit.updatedBy = userId(reqUser);
    await deposit.save({ session });

    await auditService.logInSession(session, {
      companyId,
      userId: userId(reqUser),
      action: 'TAX_DEPOSIT_SUBMITTED',
      entityType: 'TaxDeposit',
      entityId: deposit._id,
      changes: {
        depositNumber: deposit.depositNumber,
        amount,
        voucherId: voucher._id,
        entryCount: entries.length
      }
    });

    await session.commitTransaction();
    return getDeposit(companyId, deposit._id);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const attachReceipt = async (companyId, depositId, body, reqUser) => {
  const deposit = await TaxDeposit.findOne({
    _id: oid(depositId),
    companyId: oid(companyId),
    isDeleted: { $ne: true }
  });
  if (!deposit) throw new ApiError(404, 'Tax remittance not found');
  if (
    ![TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED, TAX_DEPOSIT_STATUS.DRAFT].includes(
      deposit.status
    )
  ) {
    throw new ApiError(400, 'Cannot attach receipt to this remittance');
  }
  if (
    deposit.status === TAX_DEPOSIT_STATUS.CANCELLED ||
    deposit.status === TAX_DEPOSIT_STATUS.REVERSED
  ) {
    throw new ApiError(400, 'Cannot attach receipt to a cancelled or reversed remittance');
  }

  const mediaAssetId = body.mediaAssetId ? oid(body.mediaAssetId) : null;
  if (!mediaAssetId) {
    throw new ApiError(400, 'Upload a receipt file (PDF or image). URL paste is not supported.');
  }

  const asset = await MediaAsset.findOne({
    _id: mediaAssetId,
    companyId: oid(companyId),
    status: 'READY',
    deletedAt: null
  }).lean();
  if (!asset) throw new ApiError(404, 'Uploaded receipt file not found');

  await mediaAttach.attachEntityImage({
    companyId,
    uploadedBy: userId(reqUser),
    resource: 'tax-deposits',
    id: deposit._id,
    assetId: mediaAssetId
  });

  deposit.receiptAttachment = {
    url: '',
    fileName: body.fileName || asset.key?.split('/').pop() || 'receipt',
    mimeType: body.mimeType || asset.mime || '',
    mediaAssetId,
    uploadedAt: new Date(),
    uploadedBy: userId(reqUser)
  };
  deposit.updatedBy = userId(reqUser);
  await deposit.save();

  await auditService.log({
    companyId,
    userId: userId(reqUser),
    action: 'TAX_DEPOSIT_RECEIPT_UPLOADED',
    entityType: 'TaxDeposit',
    entityId: deposit._id,
    changes: {
      fileName: deposit.receiptAttachment.fileName,
      mediaAssetId: String(mediaAssetId)
    }
  });

  return getDeposit(companyId, deposit._id);
};

/**
 * Close is no longer part of the finance workflow. Remittance is complete on submit.
 * Kept for API compatibility — maps SUBMITTED → CLOSED without requiring a receipt.
 */
const closeDeposit = async (companyId, depositId, reqUser) => {
  const deposit = await TaxDeposit.findOne({
    _id: oid(depositId),
    companyId: oid(companyId),
    isDeleted: { $ne: true }
  });
  if (!deposit) throw new ApiError(404, 'Tax remittance not found');
  if (deposit.status === TAX_DEPOSIT_STATUS.SUBMITTED) {
    deposit.status = TAX_DEPOSIT_STATUS.CLOSED;
    deposit.updatedBy = userId(reqUser);
    await deposit.save();
  }
  return getDeposit(companyId, depositId);
};

/**
 * Reverse a submitted remittance: Dr Bank / Cr Tax Liability, reopen register entries.
 * The original remittance document is preserved (status REVERSED) — never deleted.
 */
const reverseDeposit = async (companyId, depositId, body, reqUser) => {
  const reason = String(body?.reason || body?.reverseReason || '').trim();
  if (!reason || reason.length < 3) {
    throw new ApiError(400, 'A reversal reason is required');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deposit = await TaxDeposit.findOne({
      _id: oid(depositId),
      companyId: oid(companyId),
      isDeleted: { $ne: true }
    }).session(session);
    if (!deposit) throw new ApiError(404, 'Tax remittance not found');
    if (
      ![TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED].includes(deposit.status)
    ) {
      throw new ApiError(400, 'Only submitted remittances can be reversed');
    }
    if (!deposit.voucherId || !deposit.moneyAccountId || !(deposit.amount > 0)) {
      throw new ApiError(400, 'Remittance is missing posting data and cannot be reversed');
    }

    const moneyAccount = await moneyAccountService.assertMoneyAccount(
      companyId,
      deposit.moneyAccountId,
      session
    );

    const entries = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      taxDepositId: deposit._id,
      entryType: {
        $in: [
          TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
          TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
          TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
        ]
      },
      status: { $in: [TAX_REGISTER_STATUS.REMITTED, TAX_REGISTER_STATUS.CLEARED] },
      isDeleted: { $ne: true }
    }).session(session);

    await taxCoa.ensureTaxLiabilityAccounts(companyId, reqUser, session);

    const amount = roundPKR(deposit.amount);
    const accountCredits = {};
    for (const e of entries) {
      if ((e.taxAmount || 0) <= 0) continue;
      const code = await resolveLiabilityCode(e, session);
      accountCredits[code] = roundPKR((accountCredits[code] || 0) + e.taxAmount);
    }

    const netPositive = roundPKR(
      entries.filter((e) => e.taxAmount > 0).reduce((s, e) => s + e.taxAmount, 0)
    );
    const lines = [];
    if (netPositive > 0) {
      for (const [code, creditAmt] of Object.entries(accountCredits)) {
        const scaled = roundPKR((creditAmt / netPositive) * amount);
        if (scaled <= 0) continue;
        const acc = await glPosting.getAccountByCode(companyId, code, session);
        if (!acc) throw new ApiError(400, `Tax liability account ${code} not found`);
        lines.push({ accountId: acc._id, debit: 0, credit: scaled });
      }
    } else {
      const acc = await glPosting.getAccountByCode(companyId, '2140', session);
      if (!acc) throw new ApiError(400, 'Tax liability account 2140 not found');
      lines.push({ accountId: acc._id, debit: 0, credit: amount });
    }
    lines.push({ accountId: moneyAccount._id, debit: amount, credit: 0 });

    const reverseVoucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.PV,
        date: new Date(),
        narration: `Reverse tax remittance ${deposit.depositNumber}: ${reason}`,
        lines,
        sourceModule: GL_SOURCE_MODULE.TAX_DEPOSIT,
        sourceRefId: new mongoose.Types.ObjectId(),
        moneyAccountId: moneyAccount._id,
        moneyAccountNature: moneyAccount.moneyAccountNature
      },
      reqUser,
      session
    );

    // Reopen original tax events only — remittance audit lives on TaxDeposit + GL vouchers.
    for (const e of entries) {
      e.status = TAX_REGISTER_STATUS.OPEN;
      e.taxDepositId = null;
      e.depositNumber = '';
      e.depositDate = null;
      e.remittanceId = null;
      e.updatedBy = userId(reqUser);
      e.meta = {
        ...(e.meta?.toObject?.() || e.meta || {}),
        narration: `Reopened from reversed remittance ${deposit.depositNumber}`,
        reversedFromDepositId: deposit._id
      };
      await e.save({ session });
    }

    // Soft-hide any legacy REMITTANCE movement rows from older builds (no longer created).
    await TaxRegisterEntry.updateMany(
      {
        companyId: oid(companyId),
        taxDepositId: deposit._id,
        entryType: TAX_REGISTER_ENTRY_TYPE.REMITTANCE,
        isDeleted: { $ne: true }
      },
      {
        $set: {
          status: TAX_REGISTER_STATUS.VOID,
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: userId(reqUser),
          updatedBy: userId(reqUser),
          'meta.narration': `Superseded — remittances no longer create register rows (${deposit.depositNumber})`
        }
      },
      { session }
    );

    deposit.status = TAX_DEPOSIT_STATUS.REVERSED;
    deposit.reversedAt = new Date();
    deposit.reversedBy = userId(reqUser);
    deposit.reverseReason = reason;
    deposit.reverseVoucherId = reverseVoucher._id;
    deposit.updatedBy = userId(reqUser);
    await deposit.save({ session });

    await auditService.logInSession(session, {
      companyId,
      userId: userId(reqUser),
      action: 'TAX_DEPOSIT_REVERSED',
      entityType: 'TaxDeposit',
      entityId: deposit._id,
      changes: {
        depositNumber: deposit.depositNumber,
        reason,
        reverseVoucherId: reverseVoucher._id,
        reopenedEntries: entries.length
      }
    });

    await session.commitTransaction();
    return getDeposit(companyId, deposit._id);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const cancelDeposit = async (companyId, depositId, body, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deposit = await TaxDeposit.findOne({
      _id: oid(depositId),
      companyId: oid(companyId),
      isDeleted: { $ne: true }
    }).session(session);
    if (!deposit) throw new ApiError(404, 'Tax remittance not found');
    if (deposit.status !== TAX_DEPOSIT_STATUS.DRAFT) {
      throw new ApiError(400, 'Only draft remittances can be cancelled. Use Reverse Remittance for submitted documents.');
    }

    await TaxRegisterEntry.updateMany(
      {
        companyId: oid(companyId),
        taxDepositId: deposit._id,
        status: TAX_REGISTER_STATUS.INCLUDED_IN_DEPOSIT,
        isDeleted: { $ne: true }
      },
      {
        $set: {
          status: TAX_REGISTER_STATUS.OPEN,
          taxDepositId: null,
          depositNumber: '',
          depositDate: null,
          updatedBy: userId(reqUser)
        }
      },
      { session }
    );

    deposit.status = TAX_DEPOSIT_STATUS.CANCELLED;
    deposit.cancelledAt = new Date();
    deposit.cancelReason = body?.reason || body?.cancelReason || '';
    deposit.registerEntryIds = [];
    deposit.amount = 0;
    deposit.updatedBy = userId(reqUser);
    await deposit.save({ session });

    await auditService.logInSession(session, {
      companyId,
      userId: userId(reqUser),
      action: 'TAX_DEPOSIT_CANCELLED',
      entityType: 'TaxDeposit',
      entityId: deposit._id,
      changes: { reason: deposit.cancelReason }
    });

    await session.commitTransaction();
    return getDeposit(companyId, deposit._id);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const listOpenEntries = async (companyId, query = {}) => {
  const filter = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    status: TAX_REGISTER_STATUS.OPEN,
    entryType: {
      $in: [
        TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
        TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
        TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
      ]
    }
  };
  if (query.taxTypeCode) filter.taxTypeCode = query.taxTypeCode;
  if (query.pharmacyId) filter.pharmacyId = oid(query.pharmacyId);

  const rows = await TaxRegisterEntry.find(filter)
    .sort({ businessDate: 1 })
    .limit(Math.min(Number(query.limit) || 500, 2000))
    .populate('pharmacyId', 'name')
    .lean();

  return {
    rows,
    total: roundPKR(rows.reduce((s, r) => s + (r.taxAmount || 0), 0))
  };
};

module.exports = {
  listDeposits,
  getDeposit,
  createDeposit,
  updateDeposit,
  addEntries,
  removeEntry,
  submitDeposit,
  attachReceipt,
  closeDeposit,
  reverseDeposit,
  cancelDeposit,
  listOpenEntries
};
