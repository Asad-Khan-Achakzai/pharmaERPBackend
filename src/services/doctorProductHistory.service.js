const VisitLog = require('../models/VisitLog');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');

/**
 * Aggregate doctor product presentation history from VisitLog (no duplicate store).
 */
const productHistoryForDoctor = async (companyId, doctorId, { limit = 50 } = {}) => {
  if (!doctorId) throw new ApiError(400, 'doctorId is required');
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const logs = await VisitLog.find({
    companyId,
    doctorId,
    productsDiscussed: { $exists: true, $ne: [] }
  })
    .select('productsDiscussed primaryProductId notes visitTime')
    .sort({ visitTime: -1 })
    .limit(500)
    .lean();

  const map = new Map();
  for (const log of logs) {
    const ids = (log.productsDiscussed || []).map(String);
    for (const pid of ids) {
      let row = map.get(pid);
      if (!row) {
        row = {
          productId: pid,
          timesPresented: 0,
          timesAsPrimary: 0,
          lastPresentedAt: null,
          lastPrimary: false,
          lastNotes: null,
          lastVisitLogId: null
        };
        map.set(pid, row);
      }
      row.timesPresented += 1;
      const isPrimary = log.primaryProductId && String(log.primaryProductId) === pid;
      if (isPrimary) row.timesAsPrimary += 1;
      if (!row.lastPresentedAt || new Date(log.visitTime) > new Date(row.lastPresentedAt)) {
        row.lastPresentedAt = log.visitTime;
        row.lastPrimary = Boolean(isPrimary);
        row.lastNotes = log.notes || null;
        row.lastVisitLogId = String(log._id);
      }
    }
  }

  const rows = [...map.values()].sort(
    (a, b) => new Date(b.lastPresentedAt) - new Date(a.lastPresentedAt)
  );
  const sliced = rows.slice(0, cap);
  const productIds = sliced.map((r) => r.productId);
  const products = await Product.find({ _id: { $in: productIds }, companyId })
    .select('name sku brandId')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return sliced.map((r) => {
    const p = byId.get(r.productId);
    return {
      ...r,
      productName: p?.name || 'Unknown',
      sku: p?.sku || null
    };
  });
};

module.exports = { productHistoryForDoctor };
