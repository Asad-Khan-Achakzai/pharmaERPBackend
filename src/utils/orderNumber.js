const mongoose = require('mongoose');
const OrderCounter = require('../models/OrderCounter');

const toYYYYMMDD_UTC = (d = new Date()) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

const toCompanyObjectId = (companyId) => {
  if (companyId instanceof mongoose.Types.ObjectId) return companyId;
  if (typeof companyId === 'string' && mongoose.isValidObjectId(companyId)) {
    return new mongoose.Types.ObjectId(companyId);
  }
  return companyId;
};

/**
 * Next document number: single atomic { $inc: 1 } on order_counters.
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {string} key - Prefix segment (e.g. ORD, INV, or seed O{code})
 * @param {{ session?: import('mongoose').ClientSession, now?: Date }} [options]
 * @returns {Promise<string>} e.g. ORD-20260125-0001
 */
const getNextSequenceNumber = async (companyId, key, options = {}) => {
  const { session, now } = options;
  const date = toYYYYMMDD_UTC(now || new Date());
  const k = String(key || 'ORD').trim() || 'ORD';
  const oid = toCompanyObjectId(companyId);

  const doc = await OrderCounter.findOneAndUpdate(
    { companyId: oid, date, key: k },
    { $inc: { sequence: 1 } },
    { upsert: true, new: true, session: session || undefined, setDefaultsOnInsert: true }
  );

  if (!doc || !Number.isFinite(doc.sequence) || doc.sequence < 1) {
    throw new Error('order counter: invalid result after increment');
  }

  return `${k}-${date}-${String(doc.sequence).padStart(4, '0')}`;
};

module.exports = {
  getNextSequenceNumber,
  toYYYYMMDD_UTC,
  toCompanyObjectId
};
