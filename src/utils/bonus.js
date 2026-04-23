/**
 * Buy X Get Y free units (Y per full set of X paid).
 * @param {number} quantity - paid quantity
 * @param {number} buyQty - X
 * @param {number} getQty - Y
 * @returns {number} bonus (free) units
 */
const calculateBonus = (quantity, buyQty, getQty) => {
  const q = Number(quantity) || 0;
  const b = Number(buyQty) || 0;
  const g = Number(getQty) || 0;
  if (b <= 0 || g <= 0) return 0;
  return Math.floor(q / b) * g;
};

const normalizeBonusScheme = (scheme) => {
  const buyQty = Math.max(0, Number(scheme?.buyQty) || 0);
  const getQty = Math.max(0, Number(scheme?.getQty) || 0);
  return { buyQty, getQty };
};

/** Total physical units for an order line (paid + bonus) */
const lineTotalQuantity = (paidQty, bonusQty) => (Number(paidQty) || 0) + (Number(bonusQty) || 0);

module.exports = {
  calculateBonus,
  normalizeBonusScheme,
  lineTotalQuantity
};
