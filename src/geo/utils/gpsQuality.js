/**
 * GPS quality classification for Live Tracking vs Route History.
 *
 * Live eligibility uses maxAccuracyMeters.
 * History retention uses historyMaxAccuracyMeters (higher ceiling).
 * Exact band edges for excellent/good are defaults; companies may override later.
 */

const DEFAULT_LIVE_MAX_ACCURACY_METERS = 150;
const DEFAULT_HISTORY_MAX_ACCURACY_METERS = 500;
const DEFAULT_EXCELLENT_MAX_M = 30;
const DEFAULT_GOOD_MAX_M = 80;

const QUALITY_LEVELS = Object.freeze([
  'excellent',
  'good',
  'acceptable',
  'low_confidence',
  'invalid'
]);

/**
 * @param {object} [opts]
 * @param {number} [opts.maxAccuracyMeters] live pin max
 * @param {number} [opts.historyMaxAccuracyMeters] history retention max
 * @param {number} [opts.excellentMaxMeters]
 * @param {number} [opts.goodMaxMeters]
 */
function resolveAccuracyPolicy(opts = {}) {
  const liveMax = Number(opts.maxAccuracyMeters);
  const historyMax = Number(opts.historyMaxAccuracyMeters);
  const excellentMax = Number(opts.excellentMaxMeters);
  const goodMax = Number(opts.goodMaxMeters);

  const maxAccuracyMeters =
    Number.isFinite(liveMax) && liveMax > 0 ? liveMax : DEFAULT_LIVE_MAX_ACCURACY_METERS;
  let historyMaxAccuracyMeters =
    Number.isFinite(historyMax) && historyMax > 0
      ? historyMax
      : DEFAULT_HISTORY_MAX_ACCURACY_METERS;
  // History ceiling must never be stricter than live
  if (historyMaxAccuracyMeters < maxAccuracyMeters) {
    historyMaxAccuracyMeters = maxAccuracyMeters;
  }

  return {
    maxAccuracyMeters,
    historyMaxAccuracyMeters,
    excellentMaxMeters:
      Number.isFinite(excellentMax) && excellentMax > 0
        ? excellentMax
        : DEFAULT_EXCELLENT_MAX_M,
    goodMaxMeters:
      Number.isFinite(goodMax) && goodMax > 0 ? goodMax : DEFAULT_GOOD_MAX_M
  };
}

/**
 * Classify a GPS sample.
 * @param {number|null|undefined} accuracy
 * @param {object} [policyOrOpts] resolveAccuracyPolicy result or raw company liveTracking
 * @returns {{ qualityLevel: string, usableForLive: boolean, retainForHistory: boolean }}
 */
function classifyGpsQuality(accuracy, policyOrOpts = {}) {
  const policy =
    policyOrOpts.maxAccuracyMeters != null && policyOrOpts.historyMaxAccuracyMeters != null
      ? policyOrOpts
      : resolveAccuracyPolicy(policyOrOpts);

  const {
    maxAccuracyMeters,
    historyMaxAccuracyMeters,
    excellentMaxMeters,
    goodMaxMeters
  } = policy;

  if (accuracy == null || accuracy === '' || Number.isNaN(Number(accuracy))) {
    return {
      qualityLevel: 'acceptable',
      usableForLive: true,
      retainForHistory: true
    };
  }

  const meters = Number(accuracy);
  if (!Number.isFinite(meters) || meters < 0) {
    return {
      qualityLevel: 'invalid',
      usableForLive: false,
      retainForHistory: false
    };
  }

  if (meters > historyMaxAccuracyMeters) {
    return {
      qualityLevel: 'invalid',
      usableForLive: false,
      retainForHistory: false
    };
  }

  if (meters > maxAccuracyMeters) {
    return {
      qualityLevel: 'low_confidence',
      usableForLive: false,
      retainForHistory: true
    };
  }

  let qualityLevel = 'acceptable';
  if (meters <= excellentMaxMeters) qualityLevel = 'excellent';
  else if (meters <= goodMaxMeters) qualityLevel = 'good';

  return {
    qualityLevel,
    usableForLive: true,
    retainForHistory: true
  };
}

function isLiveEligible(accuracy, policyOrOpts) {
  return classifyGpsQuality(accuracy, policyOrOpts).usableForLive;
}

function isHistoryEligible(accuracy, policyOrOpts) {
  return classifyGpsQuality(accuracy, policyOrOpts).retainForHistory;
}

module.exports = {
  QUALITY_LEVELS,
  DEFAULT_LIVE_MAX_ACCURACY_METERS,
  DEFAULT_HISTORY_MAX_ACCURACY_METERS,
  DEFAULT_EXCELLENT_MAX_M,
  DEFAULT_GOOD_MAX_M,
  resolveAccuracyPolicy,
  classifyGpsQuality,
  isLiveEligible,
  isHistoryEligible
};
