/**
 * One-time (idempotent): align order_counters.sequence with max existing document numbers
 * so new atomic numbering does not collide with legacy ORD-/INV-/O*- strings.
 *
 * Run: node scripts/migrateOrderCountersFromExisting.js
 * Env: MONGODB_URI
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../src/models/Order');
const DeliveryRecord = require('../src/models/DeliveryRecord');
const OrderCounter = require('../src/models/OrderCounter');

const parseDocNumber = (s) => {
  if (!s || typeof s !== 'string') return null;
  const parts = s.trim().split('-');
  if (parts.length < 3) return null;
  const key = parts[0];
  const date = parts[1];
  if (!/^\d{8}$/.test(date)) return null;
  const seq = parseInt(parts[2], 10);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { key, date, seq };
};

const collectMax = (rows, field) => {
  const maxBy = new Map();
  for (const row of rows) {
    const p = parseDocNumber(row[field]);
    if (!p) continue;
    const companyId = row.companyId && row.companyId.toString();
    if (!companyId) continue;
    const id = `${companyId}|${p.date}|${p.key}`;
    const prev = maxBy.get(id) || 0;
    if (p.seq > prev) maxBy.set(id, p.seq);
  }
  return maxBy;
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await mongoose.connect(uri);

  // Native collection read so soft-deleted rows still block number reuse
  const [orders, deliveries] = await Promise.all([
    Order.collection.find({}).project({ companyId: 1, orderNumber: 1 }).toArray(),
    DeliveryRecord.collection.find({}).project({ companyId: 1, invoiceNumber: 1 }).toArray()
  ]);

  const m1 = collectMax(orders, 'orderNumber');
  const m2 = collectMax(deliveries, 'invoiceNumber');

  const all = new Map(m1);
  for (const [k, v] of m2) {
    const prev = all.get(k) || 0;
    if (v > prev) all.set(k, v);
  }

  let n = 0;
  for (const [id, maxSeq] of all) {
    const [companyIdStr, date, key] = id.split('|');
    if (!companyIdStr || !date || !key) continue;
    await OrderCounter.updateOne(
      { companyId: new mongoose.Types.ObjectId(companyIdStr), date, key },
      { $max: { sequence: maxSeq } },
      { upsert: true }
    );
    n += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`Order counters aligned: ${n} (companyId|date|key) group(s) from ${orders.length} orders and ${deliveries.length} delivery records.`);
  await mongoose.disconnect();
};

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
