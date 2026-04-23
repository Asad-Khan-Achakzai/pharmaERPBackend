const generateOrderNumber = async (Model, companyId, prefix = 'ORD') => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const pattern = `${prefix}-${dateStr}-`;

  const lastDoc = await Model.findOne(
    { companyId, orderNumber: { $regex: `^${pattern}` } },
    { orderNumber: 1 },
    { sort: { orderNumber: -1 } }
  );

  let seq = 1;
  if (lastDoc) {
    const lastSeq = parseInt(lastDoc.orderNumber.split('-').pop(), 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${pattern}${String(seq).padStart(3, '0')}`;
};

module.exports = { generateOrderNumber };
