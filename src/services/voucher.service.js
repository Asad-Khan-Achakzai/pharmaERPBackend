const mongoose = require('mongoose');
const Voucher = require('../models/Voucher');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const glPosting = require('./glPosting.service');
const glBridge = require('./glBridge.service');
const coaSeed = require('./coaSeed.service');
const auditService = require('./audit.service');
const { VOUCHER_TYPE, VOUCHER_STATUS } = require('../constants/enums');
const { escapeRegex, qScalar, applyDateFieldRangeFromQuery } = require('../utils/listQuery');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const list = async (companyId, query, timeZone = 'UTC') => {
  await coaSeed.ensureCoaForCompany(companyId);
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId: oid(companyId), ...nd };
  if (query.voucherType) filter.voucherType = query.voucherType;
  if (query.status) filter.status = query.status;
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ voucherNumber: { $regex: rx, $options: 'i' } }, { narration: { $regex: rx, $options: 'i' } }];
  }
  const [docs, total] = await Promise.all([
    Voucher.find(filter).sort(sort || { date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Voucher.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const v = await Voucher.findOne({ _id: oid(id), companyId: oid(companyId), ...nd }).lean();
  if (!v) throw new ApiError(404, 'Voucher not found');
  return v;
};

const createManual = async (companyId, data, reqUser) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const voucherType = data.voucherType || VOUCHER_TYPE.JV;
  if (!Object.values(VOUCHER_TYPE).includes(voucherType)) {
    throw new ApiError(400, 'Invalid voucher type');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType,
        date: data.date || new Date(),
        narration: data.narration,
        lines: data.lines,
        paymentMethod: data.paymentMethod || null,
        status: VOUCHER_STATUS.POSTED
      },
      reqUser,
      session
    );
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'voucher.create',
      entityType: 'Voucher',
      entityId: voucher._id,
      changes: { after: voucher.toObject() }
    });
    await session.commitTransaction();
    return voucher;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const createFundTransfer = async (companyId, data, reqUser) => {
  const fromAccountId = data.fromMoneyAccountId || data.fromAccountId;
  const toAccountId = data.toMoneyAccountId || data.toAccountId;
  await coaSeed.ensureCoaForCompany(companyId);
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const voucher = await glBridge.postFundTransferGl(
      companyId,
      {
        fromMoneyAccountId: fromAccountId,
        toMoneyAccountId: toAccountId,
        amount: data.amount,
        date: data.date,
        narration: data.narration
      },
      reqUser,
      session
    );
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'voucher.fundTransfer',
      entityType: 'Voucher',
      entityId: voucher._id,
      changes: { after: voucher.toObject() }
    });
    await session.commitTransaction();
    return voucher;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const reverse = async (companyId, id, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await glPosting.reverseVoucher(companyId, id, reqUser, session);
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'voucher.reverse',
      entityType: 'Voucher',
      entityId: id,
      changes: { reversalId: result.reversal._id }
    });
    await session.commitTransaction();
    return result;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

module.exports = { list, getById, createManual, createFundTransfer, reverse };
