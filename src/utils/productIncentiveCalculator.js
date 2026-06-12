const { roundPKR } = require('./currency');
const { qtyForIncentiveRule } = require('../services/repDeliveredPacksByProduct.service');

/**
 * Flat slab: entire quantity uses the single matching tier rate.
 */
const matchSlab = (slabs, qty) => {
  if (!Array.isArray(slabs) || qty <= 0) return null;
  const sorted = [...slabs].sort((a, b) => a.fromPacks - b.fromPacks);
  for (const slab of sorted) {
    const from = Number(slab.fromPacks) || 0;
    const to = slab.toPacks == null ? null : Number(slab.toPacks);
    if (qty >= from && (to == null || qty <= to)) return slab;
  }
  return null;
};

const ruleProductId = (rule) => {
  if (!rule?.productId) return '';
  if (typeof rule.productId === 'object' && rule.productId._id) return String(rule.productId._id);
  return String(rule.productId);
};

/**
 * @param {Array} rules - structure.productPackIncentives
 * @param {Map<string,{physicalQty,paidQty,bonusQty}>} deliveredByProduct
 * @param {Map<string,{name?:string,composition?:string}>} [productNames] optional id→name
 */
const calculateProductIncentives = (rules, deliveredByProduct, productNames = new Map()) => {
  const lines = [];
  let total = 0;

  for (const rule of rules || []) {
    if ((rule.type || 'pack_slab') !== 'pack_slab') continue;
    const productId = ruleProductId(rule);
    if (!productId) continue;

    const includeBonusQty = rule.includeBonusQty !== false;
    const deliveredQty = qtyForIncentiveRule(deliveredByProduct, productId, includeBonusQty);
    const matchedSlab = matchSlab(rule.slabs || [], deliveredQty);
    const ratePerPack = matchedSlab ? Number(matchedSlab.ratePerPack) || 0 : 0;
    const amount = matchedSlab ? roundPKR(deliveredQty * ratePerPack) : 0;

    const nameMeta = productNames.get(productId);
    const productName =
      nameMeta?.name ||
      (typeof rule.productId === 'object' ? rule.productId.name : null) ||
      'Unknown product';

    lines.push({
      productId,
      productName,
      deliveredQty,
      includeBonusQty,
      matchedSlab: matchedSlab
        ? {
            fromPacks: matchedSlab.fromPacks,
            toPacks: matchedSlab.toPacks ?? null,
            ratePerPack: matchedSlab.ratePerPack
          }
        : null,
      amount,
      calculationType: 'pack_slab'
    });
    total += amount;
  }

  return { lines, total: roundPKR(total) };
};

module.exports = {
  matchSlab,
  calculateProductIncentives
};
