const { TERRITORY_KIND } = require('../constants/enums');

/**
 * When anchor is a brick, extra coverage is normally explicit bricks only (new UX).
 * Legacy rows may still store area/zone nodes in `coverageTerritoryIds`; those keep expanding via path.
 */
function inferTerritoryAssignmentLabel(anchorPopulated, coveragePopulated) {
  const cov = Array.isArray(coveragePopulated) ? coveragePopulated.filter(Boolean) : [];
  const coverageLen = cov.length;
  const coverageAllBrick =
    coverageLen > 0 && cov.every((c) => typeof c === 'object' && c && c.kind === TERRITORY_KIND.BRICK);
  const anchor = anchorPopulated && typeof anchorPopulated === 'object' ? anchorPopulated : null;
  if (!anchor || !anchor.kind) return { key: 'NONE', label: 'None' };
  const k = anchor.kind;

  const countSeedsOfKind = (kind) => {
    let n = anchor.kind === kind ? 1 : 0;
    for (const c of cov) {
      if (typeof c === 'object' && c && c.kind === kind) n += 1;
    }
    return n;
  };

  const areaSeedCount = countSeedsOfKind(TERRITORY_KIND.AREA);
  const zoneSeedCount = countSeedsOfKind(TERRITORY_KIND.ZONE);

  if (k === TERRITORY_KIND.ZONE) {
    if (zoneSeedCount > 1) {
      return { key: 'MULTI_ZONE', label: `Multi-Zone (${zoneSeedCount})` };
    }
    if (coverageLen === 0) return { key: 'ENTIRE_ZONE', label: 'Entire Zone' };
  }
  if (k === TERRITORY_KIND.AREA) {
    if (areaSeedCount > 1) {
      return { key: 'MULTI_AREA', label: `Multi-Area (${areaSeedCount})` };
    }
    if (coverageLen === 0) return { key: 'ENTIRE_AREA', label: 'Entire Area' };
  }
  if (k === TERRITORY_KIND.BRICK && coverageLen === 0) return { key: 'SINGLE_BRICK', label: 'Single Brick' };
  if (k === TERRITORY_KIND.BRICK && coverageLen > 0 && coverageAllBrick) {
    return { key: 'CUSTOM_MULTI_BRICK', label: 'Custom Multi-Brick' };
  }
  if (coverageLen > 0) {
    return { key: 'HIERARCHICAL_PLUS_EXTRA', label: 'Hierarchical + extra coverage' };
  }
  return { key: 'CUSTOM', label: 'Custom / legacy' };
}

module.exports = {
  inferTerritoryAssignmentLabel
};
