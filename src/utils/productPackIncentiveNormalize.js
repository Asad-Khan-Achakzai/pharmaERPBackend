const ApiError = require('./ApiError');

const normalizeSlabs = (slabs) => {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    throw new ApiError(400, 'Each product pack incentive must have at least one slab');
  }
  const normalized = slabs.map((s) => {
    const fromPacks = Math.max(1, Math.floor(Number(s.fromPacks) || 0));
    const toRaw = s.toPacks;
    const toPacks =
      toRaw === null || toRaw === undefined || toRaw === ''
        ? null
        : Math.max(fromPacks, Math.floor(Number(toRaw) || 0));
    const ratePerPack = Math.max(0, Number(s.ratePerPack) || 0);
    return { fromPacks, toPacks, ratePerPack };
  });
  normalized.sort((a, b) => a.fromPacks - b.fromPacks);

  for (let i = 0; i < normalized.length; i += 1) {
    const slab = normalized[i];
    if (slab.toPacks != null && slab.toPacks < slab.fromPacks) {
      throw new ApiError(400, 'Slab toPacks must be greater than or equal to fromPacks');
    }
    if (i > 0) {
      const prev = normalized[i - 1];
      if (prev.toPacks == null) {
        throw new ApiError(400, 'Only the last slab may have an open-ended upper limit');
      }
      if (slab.fromPacks <= prev.toPacks) {
        throw new ApiError(400, 'Product pack incentive slabs must not overlap');
      }
    }
  }
  return normalized;
};

const normalizeProductPackIncentives = (rows) => {
  if (!Array.isArray(rows)) return [];
  const byProduct = new Map();
  for (const row of rows) {
    const productId = String(row?.productId || '').trim();
    if (!productId) continue;
    if (byProduct.has(productId)) {
      throw new ApiError(400, 'Duplicate product in product pack incentives');
    }
    byProduct.set(productId, {
      type: 'pack_slab',
      productId,
      includeBonusQty: row.includeBonusQty !== false,
      slabs: normalizeSlabs(row.slabs || [])
    });
  }
  return Array.from(byProduct.values());
};

const snapshotProductPackIncentives = (rules) =>
  (rules || []).map((r) => ({
    type: 'pack_slab',
    productId: r.productId?._id ? String(r.productId._id) : String(r.productId || ''),
    includeBonusQty: r.includeBonusQty !== false,
    slabs: (r.slabs || []).map((s) => ({
      fromPacks: s.fromPacks,
      toPacks: s.toPacks ?? null,
      ratePerPack: s.ratePerPack
    }))
  }));

module.exports = {
  normalizeSlabs,
  normalizeProductPackIncentives,
  snapshotProductPackIncentives
};
