const mongoose = require('mongoose');
const Remittance = require('../models/Remittance');
const Collection = require('../models/Collection');
const Settlement = require('../models/Settlement');
const SettlementAllocation = require('../models/SettlementAllocation');
const Pharmacy = require('../models/Pharmacy');
const Distributor = require('../models/Distributor');
const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { roundPKR } = require('../utils/currency');
const { escapeRegex, qScalar, applyDateFieldRangeFromQuery } = require('../utils/listQuery');
const {
  COLLECTOR_TYPE,
  SETTLEMENT_DIRECTION,
  REMITTANCE_KIND,
  REMITTANCE_STATUS,
  PAYMENT_METHOD
} = require('../constants/enums');
const financialService = require('./financial.service');
const logger = require('../utils/logger');
const {
  fifoApplyReceivedToOpenLines,
  classifyReceivedVsExpected,
  OPEN_EPS
} = require('../utils/remittanceMath');

const oid = (id) => new mongoose.Types.ObjectId(id);

const abortQuietly = async (session) => {
  try {
    await session.abortTransaction();
  } catch {
    /* already aborted by the server — do not mask the original error */
  }
};

const isTransientTxnError = (err) =>
  Boolean(
    err?.errorLabels?.includes('TransientTransactionError') ||
      err?.code === 112 ||
      /WriteConflict/i.test(err?.message || '')
  );

/**
 * Mongo forbids creating a collection (first insert into a new namespace) inside
 * a multi-document transaction. Remittance is a new model; prod may not have
 * `remittances` yet. Create it before starting the txn.
 */
const ensureRemittanceCollection = async () => {
  try {
    await Remittance.createCollection();
  } catch (err) {
    if (err?.code === 48 || err?.codeName === 'NamespaceExists') return;
    throw err;
  }
};

const runInTransaction = async (fn) => {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (e) {
      await abortQuietly(session);
      session.endSession();
      lastErr = e;
      if (!isTransientTxnError(e) || attempt === 2) break;
      logger.warn({
        msg: 'remittance.transaction.retry',
        attempt: attempt + 1,
        err: e.message
      });
    }
  }
  throw lastErr;
};

const preview = async (companyId, body) => {
  const distributorId = body.distributorId;
  if (!distributorId) throw new ApiError(400, 'distributorId is required');
  const dist = await Distributor.findOne({ _id: oid(distributorId), companyId: oid(companyId) });
  if (!dist) throw new ApiError(404, 'Distributor not found');

  const newCollections = Array.isArray(body.newCollections) ? body.newCollections : [];
  const collectionIds = Array.isArray(body.collectionIds) ? body.collectionIds : [];
  if (!newCollections.length && !collectionIds.length) {
    throw new ApiError(400, 'Add at least one pharmacy collection or existing collection');
  }

  const linePreviews = [];
  let collectedAmount = 0;
  let expectedFromNew = 0;

  for (const line of newCollections) {
    const prev = await financialService.previewDistributorCollection(companyId, {
      pharmacyId: line.pharmacyId,
      distributorId,
      amount: line.amount
    });
    collectedAmount = roundPKR(collectedAmount + prev.amount);
    expectedFromNew = roundPKR(expectedFromNew + prev.sliceCompany);
    linePreviews.push({
      pharmacyId: line.pharmacyId,
      amount: prev.amount,
      outstanding: prev.outstanding,
      sliceCompany: prev.sliceCompany,
      sliceDist: prev.sliceDist
    });
  }

  const existingOpen = await financialService.listOpenRemittanceDueLinesForCollections(
    companyId,
    distributorId,
    collectionIds
  );
  const expectedFromExisting = roundPKR(existingOpen.reduce((s, l) => s + l.open, 0));
  const existingByCollection = {};
  for (const l of existingOpen) {
    const key = String(l.collectionId);
    if (!existingByCollection[key]) existingByCollection[key] = { collectionId: key, open: 0 };
    existingByCollection[key].open = roundPKR(existingByCollection[key].open + l.open);
  }

  const existingCols = collectionIds.length
    ? await Collection.find({ _id: { $in: collectionIds.map(oid) }, companyId: oid(companyId) })
        .select('amount pharmacyId')
        .lean()
    : [];
  for (const c of existingCols) {
    collectedAmount = roundPKR(collectedAmount + (c.amount || 0));
  }

  const expectedAmount = roundPKR(expectedFromNew + expectedFromExisting);
  const receivedAmount =
    body.receivedAmount != null && body.receivedAmount !== '' ? roundPKR(body.receivedAmount) : expectedAmount;
  const classified = classifyReceivedVsExpected(expectedAmount, receivedAmount);

  return {
    distributorId,
    collectedAmount,
    expectedAmount,
    receivedAmount: classified.received,
    differenceAmount: classified.difference,
    status: classified.status,
    distributorShare: roundPKR(collectedAmount - expectedAmount),
    newCollectionPreviews: linePreviews,
    existingOpenByCollection: Object.values(existingByCollection)
  };
};

const create = async (companyId, body, reqUser) => {
  await ensureRemittanceCollection();
  return runInTransaction(async (session) => {
    const distributorId = body.distributorId;
    const dist = await Distributor.findOne({
      _id: oid(distributorId),
      companyId: oid(companyId)
    }).session(session);
    if (!dist) throw new ApiError(404, 'Distributor not found');

    const newCollections = Array.isArray(body.newCollections) ? body.newCollections : [];
    const collectionIds = [...new Set((body.collectionIds || []).map(String))];
    if (!newCollections.length && !collectionIds.length) {
      throw new ApiError(400, 'Add at least one pharmacy collection or existing collection');
    }

    const receivedAmount = roundPKR(body.receivedAmount);
    if (receivedAmount < 0.01) throw new ApiError(400, 'Amount received must be greater than zero');

    const kind = newCollections.length ? REMITTANCE_KIND.COLLECT_AND_REMIT : REMITTANCE_KIND.REMIT_EXISTING;
    const date = body.date ? new Date(body.date) : new Date();

    const createdIds = [];
    let collectedAmount = 0;

    for (const line of newCollections) {
      const doc = await financialService.createCollection(
        companyId,
        {
          pharmacyId: line.pharmacyId,
          collectorType: COLLECTOR_TYPE.DISTRIBUTOR,
          distributorId,
          amount: line.amount,
          paymentMethod: body.paymentMethod || PAYMENT_METHOD.CASH,
          notes: line.notes,
          date
        },
        reqUser,
        session
      );
      createdIds.push(doc._id);
      collectedAmount = roundPKR(collectedAmount + roundPKR(line.amount));
    }

    if (collectionIds.length) {
      const existing = await Collection.find({
        _id: { $in: collectionIds.map(oid) },
        companyId: oid(companyId)
      }).session(session);
      if (existing.length !== collectionIds.length) {
        throw new ApiError(404, 'One or more collections were not found');
      }
      for (const c of existing) {
        if (c.collectorType !== COLLECTOR_TYPE.DISTRIBUTOR) {
          throw new ApiError(400, 'Only distributor collections can be remitted');
        }
        if (String(c.distributorId) !== String(distributorId)) {
          throw new ApiError(400, 'Collection does not belong to the selected distributor');
        }
        collectedAmount = roundPKR(collectedAmount + roundPKR(c.amount));
      }
    }

    const allCollectionIds = [...createdIds.map(String), ...collectionIds];
    const openLines = await financialService.listOpenRemittanceDueLinesForCollections(
      companyId,
      distributorId,
      allCollectionIds,
      session
    );
    const expectedAmount = roundPKR(openLines.reduce((s, l) => s + l.open, 0));
    if (expectedAmount < OPEN_EPS) {
      throw new ApiError(409, 'These collections have no remaining company share to remit');
    }

    const classified = classifyReceivedVsExpected(expectedAmount, receivedAmount);
    if (classified.status === 'EXCESS') {
      throw new ApiError(
        400,
        `Amount received (${classified.received}) exceeds expected remittance of PKR ${classified.expected} (company share of selected collections, not total collected). Extra cash cannot be posted as pharmacy collections.`
      );
    }

    const { slices, unapplied } = fifoApplyReceivedToOpenLines(openLines, classified.received);
    if (unapplied > OPEN_EPS) {
      throw new ApiError(409, 'Outstanding remittance due changed. Refresh and try again.');
    }
    const applied = roundPKR(slices.reduce((s, x) => s + x.amount, 0));
    if (Math.abs(applied - classified.received) > OPEN_EPS) {
      throw new ApiError(409, 'Could not allocate the received amount to the selected collections. Refresh and try again.');
    }

    const [remittance] = await Remittance.create(
      [
        {
          companyId,
          distributorId,
          kind,
          status: REMITTANCE_STATUS.POSTED,
          collectedAmount,
          expectedAmount,
          receivedAmount: classified.received,
          differenceAmount: classified.difference,
          differenceReason: classified.status === 'SHORT' ? body.differenceReason || undefined : undefined,
          paymentMethod: body.paymentMethod,
          moneyAccountId: body.moneyAccountId,
          referenceNumber: body.referenceNumber,
          notes: body.notes,
          date,
          postedBy: reqUser.userId
        }
      ],
      { session, ordered: true }
    );

    if (createdIds.length) {
      await Collection.updateMany(
        { _id: { $in: createdIds }, companyId: oid(companyId) },
        { $set: { remittanceId: remittance._id } },
        { session }
      );
    }

    const settlement = await financialService.createSettlement(
      companyId,
      {
        distributorId,
        direction: SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY,
        amount: classified.received,
        paymentMethod: body.paymentMethod,
        moneyAccountId: body.moneyAccountId,
        referenceNumber: body.referenceNumber,
        date,
        notes: body.notes,
        remittanceId: remittance._id,
        allocationSlices: slices
      },
      reqUser,
      session
    );

    remittance.settlementId = settlement._id;
    remittance.moneyAccountNature = settlement.moneyAccountNature;
    remittance.updatedBy = reqUser.userId;
    await remittance.save({ session });

    return remittance;
  });
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.distributorId) filter.distributorId = query.distributorId;
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ referenceNumber: { $regex: rx, $options: 'i' } }, { notes: { $regex: rx, $options: 'i' } }];
  }

  const [docs, total] = await Promise.all([
    Remittance.find(filter)
      .populate('distributorId', 'name city')
      .populate('postedBy', 'name')
      .populate('moneyAccountId', 'name code')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Remittance.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const doc = await Remittance.findOne({ _id: id, companyId })
    .populate('distributorId', 'name city')
    .populate('postedBy', 'name')
    .populate('moneyAccountId', 'name code');
  if (!doc) return null;

  const allocations = doc.settlementId
    ? await SettlementAllocation.find({ companyId, settlementId: doc.settlementId }).lean()
    : [];
  const allocatedCollectionIds = [
    ...new Set(allocations.map((a) => a.collectionId).filter(Boolean).map(String))
  ];
  const created = await Collection.find({ companyId, remittanceId: doc._id })
    .populate('pharmacyId', 'name city')
    .sort({ date: 1 })
    .lean();
  const extraIds = allocatedCollectionIds.filter((id) => !created.some((c) => String(c._id) === id));
  const extraCols = extraIds.length
    ? await Collection.find({ _id: { $in: extraIds.map(oid) }, companyId })
        .populate('pharmacyId', 'name city')
        .lean()
    : [];

  const settlement = doc.settlementId
    ? await Settlement.findOne({ _id: doc.settlementId, companyId })
        .populate('settledBy', 'name')
        .lean()
    : null;

  return {
    ...doc.toObject(),
    collections: [...created, ...extraCols],
    allocations,
    settlement
  };
};

const reverse = async (companyId, id, body, reqUser) => {
  return runInTransaction(async (session) => {
    const remittance = await Remittance.findOne({ _id: oid(id), companyId: oid(companyId) }).session(session);
    if (!remittance) throw new ApiError(404, 'Remittance not found');
    if (remittance.status === REMITTANCE_STATUS.REVERSED) {
      throw new ApiError(400, 'Remittance already reversed');
    }

    if (remittance.settlementId) {
      await financialService.reverseSettlement(
        companyId,
        remittance.settlementId,
        body,
        reqUser,
        session,
        { allowRemittanceOwned: true }
      );
    }

    if (remittance.kind === REMITTANCE_KIND.COLLECT_AND_REMIT) {
      const created = await Collection.find({
        companyId: oid(companyId),
        remittanceId: remittance._id
      }).session(session);
      for (const c of created) {
        c.remittanceId = undefined;
        await c.save({ session });
        await financialService.reverseCollection(companyId, c._id, body, reqUser, session);
      }
    }

    remittance.status = REMITTANCE_STATUS.REVERSED;
    remittance.isDeleted = true;
    remittance.deletedAt = new Date();
    remittance.deletedBy = reqUser.userId;
    await remittance.save({ session });

    return {
      reversed: true,
      remittanceId: remittance._id,
      reversalReason: body?.reversalReason || null
    };
  });
};

const pharmacyOutstanding = async (companyId, distributorId, query) => {
  const dist = await Distributor.findOne({ _id: oid(distributorId), companyId: oid(companyId) });
  if (!dist) throw new ApiError(404, 'Distributor not found');

  const { page, limit, skip, search } = parsePagination(query);
  const orders = await Order.find({ companyId: oid(companyId), distributorId: oid(distributorId) })
    .select('pharmacyId')
    .lean();
  let pharmacyIds = [...new Set(orders.map((o) => String(o.pharmacyId)).filter(Boolean))];

  const searchTerm = qScalar(search);
  const pharmFilter = { companyId: oid(companyId), _id: { $in: pharmacyIds.map(oid) } };
  if (searchTerm) pharmFilter.name = { $regex: escapeRegex(searchTerm), $options: 'i' };
  const named = await Pharmacy.find(pharmFilter).select('_id name city').sort({ name: 1 }).lean();
  pharmacyIds = named.map((p) => String(p._id));

  const pageIds = pharmacyIds.slice(skip, skip + limit);
  const rows = [];
  for (const pid of pageIds) {
    const state = await financialService.computePharmacyReceivableState(companyId, pid);
    const distRows = state.rows.filter(
      (r) => r.distributorId && String(r.distributorId) === String(distributorId)
    );
    const outstanding = roundPKR(distRows.reduce((s, r) => s + Math.max(0, r.open), 0));
    if (outstanding < OPEN_EPS) continue;
    const estimatedCompanyShare = roundPKR(
      distRows.reduce((s, r) => {
        const { sliceCompany } = financialService.sliceByRatios(
          r.open,
          r.pharmacyNetPayable,
          r.companyShareTotal,
          r.distributorShareTotal
        );
        return s + sliceCompany;
      }, 0)
    );
    const ph = named.find((p) => String(p._id) === pid);
    rows.push({
      pharmacyId: pid,
      pharmacyName: ph?.name,
      city: ph?.city,
      outstanding,
      estimatedCompanyShare,
      estimatedDistributorShare: roundPKR(outstanding - estimatedCompanyShare)
    });
  }

  return { docs: rows, total: pharmacyIds.length, page, limit };
};

const unremittedCollections = async (companyId, distributorId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = {
    companyId: oid(companyId),
    distributorId: oid(distributorId),
    collectorType: COLLECTOR_TYPE.DISTRIBUTOR
  };
  const docs = await Collection.find(filter)
    .populate('pharmacyId', 'name city')
    .sort(sort)
    .skip(skip)
    .limit(limit * 3)
    .lean();

  const ids = docs.map((d) => d._id);
  const openLines = await financialService.listOpenRemittanceDueLinesForCollections(
    companyId,
    distributorId,
    ids
  );
  const openByCol = {};
  for (const l of openLines) {
    const key = String(l.collectionId);
    openByCol[key] = roundPKR((openByCol[key] || 0) + l.open);
  }

  const unremitted = docs
    .filter((d) => (openByCol[String(d._id)] || 0) > OPEN_EPS)
    .map((d) => ({
      ...d,
      remittanceOpen: openByCol[String(d._id)] || 0
    }));

  const pageRows = unremitted.slice(0, limit);
  return { docs: pageRows, total: unremitted.length + skip, page, limit };
};

const collectionRemittanceStatus = async (companyId, collection) => {
  if (!collection) return null;
  const distributorId = collection.distributorId;
  if (collection.collectorType !== COLLECTOR_TYPE.DISTRIBUTOR || !distributorId) {
    return { remittanceStatus: 'NOT_APPLICABLE', remittanceOpen: 0, remittanceId: collection.remittanceId || null };
  }
  const Ledger = require('../models/Ledger');
  const {
    LEDGER_TYPE,
    LEDGER_ENTITY_TYPE,
    LEDGER_REFERENCE_TYPE,
    LEDGER_COLLECTION_PORTION
  } = require('../constants/enums');
  const dueLines = await Ledger.find({
    companyId: oid(companyId),
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    entityId: oid(distributorId),
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    referenceId: collection._id,
    type: LEDGER_TYPE.DEBIT,
    'meta.portion': LEDGER_COLLECTION_PORTION.REMITTANCE_DUE_TO_COMPANY,
    isDeleted: { $ne: true }
  }).lean();
  const originalDue = roundPKR(dueLines.reduce((s, l) => s + (l.amount || 0), 0));
  const openLines = await financialService.listOpenRemittanceDueLinesForCollections(companyId, distributorId, [
    collection._id
  ]);
  const remittanceOpen = roundPKR(openLines.reduce((s, l) => s + l.open, 0));
  let remittanceStatus = 'HELD_BY_DISTRIBUTOR';
  if (originalDue < OPEN_EPS || remittanceOpen < OPEN_EPS) remittanceStatus = 'REMITTED';
  else if (remittanceOpen + OPEN_EPS < originalDue) remittanceStatus = 'PARTIALLY_REMITTED';
  return {
    remittanceStatus,
    remittanceOpen,
    remittanceId: collection.remittanceId || null
  };
};

module.exports = {
  preview,
  create,
  list,
  getById,
  reverse,
  pharmacyOutstanding,
  unremittedCollections,
  collectionRemittanceStatus
};
