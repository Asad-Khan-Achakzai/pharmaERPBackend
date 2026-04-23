const { DateTime } = require('luxon');

/** Pacific time (handles PST/PDT). */
const TZ = 'America/Los_Angeles';

const pstNow = () => DateTime.now().setZone(TZ);

/** Today's calendar date in Pacific, YYYY-MM-DD */
const pstTodayYmd = () => pstNow().toISODate();

/** Minutes since local midnight in Pacific (0–1440). */
const pstMinutesSinceMidnight = (d = new Date()) => {
  const n = DateTime.fromJSDate(d).setZone(TZ);
  return n.hour * 60 + n.minute + n.second / 60 + n.millisecond / 60000;
};

/**
 * Mongo `date` field: start of calendar day in Pacific, stored as UTC Date.
 * One document per employee per Pacific calendar day.
 */
const dateDocFromPstYmd = (ymd) => DateTime.fromISO(ymd, { zone: TZ }).startOf('day').toUTC().toJSDate();

/** End of Pacific calendar day (23:59:59.999 local) as UTC Date. */
const endOfPstDayJsDate = (ymd) => DateTime.fromISO(ymd, { zone: TZ }).endOf('day').toUTC().toJSDate();

/** Pacific calendar YYYY-MM-DD for an instant (e.g. stored attendance date). */
const pstYmdFromJsDate = (jsDate) => DateTime.fromJSDate(jsDate, { zone: 'utc' }).setZone(TZ).toISODate();

const formatHmPst = (jsDate) => {
  if (!jsDate) return null;
  return DateTime.fromJSDate(jsDate, { zone: 'utc' }).setZone(TZ).toFormat('HH:mm');
};

/** All YYYY-MM-DD keys for a payroll month (Pacific calendar). */
const pstMonthYmds = (monthStr) => {
  const [Y, M] = monthStr.split('-').map(Number);
  if (!Y || !M || M < 1 || M > 12) return [];
  let d = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: TZ }).startOf('day');
  const end = d.endOf('month');
  const keys = [];
  while (d <= end) {
    keys.push(d.toISODate());
    d = d.plus({ days: 1 });
  }
  return keys;
};

module.exports = {
  TZ,
  pstNow,
  pstTodayYmd,
  pstMinutesSinceMidnight,
  dateDocFromPstYmd,
  endOfPstDayJsDate,
  pstYmdFromJsDate,
  formatHmPst,
  pstMonthYmds
};
