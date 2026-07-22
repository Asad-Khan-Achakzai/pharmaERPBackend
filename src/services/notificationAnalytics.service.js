const Notification = require('../models/Notification');
const NotificationDailyStat = require('../models/NotificationDailyStat');
const { PUSH_STATUS } = require('../models/Notification');
const { parsePagination } = require('../utils/pagination');

function utcDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function rollupDay(companyId, day = utcDayKey()) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(`${day}T23:59:59.999Z`);
  const filter = { companyId, createdAt: { $gte: start, $lte: end } };

  const kinds = await Notification.distinct('kind', filter);
  for (const kind of kinds) {
    const base = { ...filter, kind };
    const [created, sent, delivered, failed, opened, read] = await Promise.all([
      Notification.countDocuments(base),
      Notification.countDocuments({ ...base, pushStatus: PUSH_STATUS.SENT }),
      Notification.countDocuments({ ...base, pushStatus: PUSH_STATUS.DELIVERED }),
      Notification.countDocuments({ ...base, pushStatus: PUSH_STATUS.FAILED }),
      Notification.countDocuments({ ...base, readSource: 'push_tap' }),
      Notification.countDocuments({ ...base, readAt: { $ne: null } })
    ]);

    await NotificationDailyStat.findOneAndUpdate(
      { companyId, day, kind },
      {
        $set: { created, sent, delivered, failed, opened, read }
      },
      { upsert: true }
    );
  }

  return { companyId: String(companyId), day, kinds: kinds.length };
}

async function rollupRecent(companyId, days = 7) {
  const results = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    results.push(await rollupDay(companyId, utcDayKey(d)));
  }
  return results;
}

async function companyHealth(companyId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { companyId };
  if (query.day) filter.day = String(query.day);
  const [docs, total] = await Promise.all([
    NotificationDailyStat.find(filter).sort({ day: -1, kind: 1 }).skip(skip).limit(limit).lean(),
    NotificationDailyStat.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
}

module.exports = { rollupDay, rollupRecent, companyHealth, utcDayKey };
