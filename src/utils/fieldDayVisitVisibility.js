/**
 * Pure merge helpers for Field Day visit visibility.
 * Isolated from Partner / participants — never writes PlanItem rows.
 */

const idOf = (item) => (item == null ? '' : String(item._id));

/**
 * Drop Field Day rows that are already visible as owned visits or Partner/co-visit.
 */
const excludeAlreadyVisible = (fieldDayItems, ownedItems, coVisitItems) => {
  const seen = new Set();
  for (const item of ownedItems || []) {
    const id = idOf(item);
    if (id) seen.add(id);
  }
  for (const item of coVisitItems || []) {
    const id = idOf(item);
    if (id) seen.add(id);
  }
  return (fieldDayItems || []).filter((item) => {
    const id = idOf(item);
    return id && !seen.has(id);
  });
};

const tagFieldDayObserverView = (items) =>
  (items || []).map((item) => ({
    ...item,
    isFieldDayView: true,
    fieldDayRole: 'OBSERVER'
  }));

module.exports = { excludeAlreadyVisible, tagFieldDayObserverView };
