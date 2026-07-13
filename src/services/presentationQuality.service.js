const { SECTION_KEYS } = require('../models/ProductPresentation');

const HERO_TYPES = new Set(['IMAGE', 'HERO']);
const CLINICAL_TYPES = new Set(['CLINICAL']);
const SUMMARY_TYPES = new Set(['SUMMARY', 'CTA']);
const BENEFIT_TYPES = new Set(['BENEFITS']);

function hexLuminance(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.trim().replace('#', '');
  if (![3, 6].includes(m.length)) return null;
  const full =
    m.length === 3
      ? m
          .split('')
          .map((c) => c + c)
          .join('')
      : m;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Presentation publish quality score (rules engine — not ML).
 * ERROR blocks publish when blockOnError=true; WARN/INFO are advisory.
 */
function evaluatePresentationQuality(presentation) {
  const checks = [];
  const slides = [...(presentation.slides || [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );
  const sections = [...(presentation.sections || [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );
  const theme = presentation.theme || {};

  if (!slides.length) {
    checks.push({
      code: 'NO_SLIDES',
      severity: 'ERROR',
      message: 'Presentation has no slides'
    });
  }

  const first = slides[0];
  if (first && !HERO_TYPES.has(first.type) && first.type !== 'PROBLEM') {
    checks.push({
      code: 'HERO_MISSING',
      severity: 'WARN',
      message: 'First slide is not a Hero / Image opener',
      slideId: first.slideId || null
    });
  } else if (first && HERO_TYPES.has(first.type)) {
    checks.push({
      code: 'HERO_EXISTS',
      severity: 'INFO',
      message: 'Hero / opener slide present',
      slideId: first.slideId || null
    });
  }

  if (theme.primaryColor) {
    checks.push({
      code: 'THEME_APPLIED',
      severity: 'INFO',
      message: 'Brand theme color applied'
    });
  } else {
    checks.push({
      code: 'THEME_MISSING',
      severity: 'WARN',
      message: 'No primary brand color on theme'
    });
  }

  const hasClinical =
    slides.some((s) => CLINICAL_TYPES.has(s.type)) ||
    sections.some((s) => s.key === 'CLINICAL_EVIDENCE' && (s.slideIds || []).length > 0);
  if (hasClinical) {
    checks.push({
      code: 'CLINICAL_INCLUDED',
      severity: 'INFO',
      message: 'Clinical evidence content included'
    });
  } else {
    checks.push({
      code: 'CLINICAL_MISSING',
      severity: 'WARN',
      message: 'No clinical evidence slide/section'
    });
  }

  const hasSummary =
    slides.some((s) => SUMMARY_TYPES.has(s.type)) ||
    sections.some((s) => (s.key === 'SUMMARY' || s.key === 'CTA') && (s.slideIds || []).length > 0);
  if (hasSummary) {
    checks.push({
      code: 'SUMMARY_EXISTS',
      severity: 'INFO',
      message: 'Summary / CTA slide present'
    });
  } else {
    checks.push({
      code: 'SUMMARY_MISSING',
      severity: 'ERROR',
      message: 'Add a Summary or Call-To-Action slide before publishing'
    });
  }

  const hasImage = slides.some((s) => s.assetId || s.backgroundAssetId);
  if (hasImage) {
    checks.push({
      code: 'PRODUCT_IMAGE',
      severity: 'INFO',
      message: 'At least one slide has media'
    });
  } else {
    checks.push({
      code: 'MISSING_PRODUCT_IMAGE',
      severity: 'WARN',
      message: 'No slide images attached — consider adding a product visual'
    });
  }

  for (const s of slides) {
    const bodyLen = (s.body || '').trim().length;
    const bullets = Array.isArray(s.bullets) ? s.bullets : [];
    if (bodyLen > 180) {
      checks.push({
        code: 'TEXT_DENSITY',
        severity: 'WARN',
        message: `Slide "${s.title || s.type}" has too much text (${bodyLen} chars) — prefer short bullets`,
        slideId: s.slideId || null
      });
    }
    if (bullets.length > 5) {
      checks.push({
        code: 'TOO_MANY_BULLETS',
        severity: 'WARN',
        message: `Slide "${s.title || s.type}" has more than 5 bullets`,
        slideId: s.slideId || null
      });
    }
    if (BENEFIT_TYPES.has(s.type) && bullets.length === 0 && bodyLen > 0) {
      checks.push({
        code: 'BENEFITS_USE_BULLETS',
        severity: 'INFO',
        message: 'Benefits slides work best with short bullets',
        slideId: s.slideId || null
      });
    }
  }

  const lum = hexLuminance(theme.primaryColor);
  if (lum != null && theme.surfaceStyle === 'light' && lum > 0.7) {
    checks.push({
      code: 'CONTRAST_WARN',
      severity: 'WARN',
      message: 'Primary color may be too light for light surface — check contrast'
    });
  } else if (theme.primaryColor) {
    checks.push({
      code: 'CONTRAST_OK',
      severity: 'INFO',
      message: 'Theme contrast looks acceptable'
    });
  }

  if (sections.length) {
    checks.push({
      code: 'STORY_SECTIONS',
      severity: 'INFO',
      message: `Story has ${sections.length} sections`
    });
  } else if (slides.length) {
    checks.push({
      code: 'NO_STORY_SECTIONS',
      severity: 'INFO',
      message: 'No story sections — slides play as a flat list (still valid)'
    });
  }

  // Score: start 100, ERROR -18, WARN -8, INFO +0 (cap 0–100); INFO positives via missing penalties only
  let score = 100;
  for (const c of checks) {
    if (c.severity === 'ERROR') score -= 18;
    if (c.severity === 'WARN') score -= 8;
  }
  score = Math.max(0, Math.min(100, score));

  const errors = checks.filter((c) => c.severity === 'ERROR');
  return {
    score,
    checks,
    canPublish: errors.length === 0,
    checkedAt: new Date()
  };
}

/** Default cardiology-style story section skeleton for new decks. */
function defaultStorySections() {
  const mongoose = require('mongoose');
  const defs = [
    { key: 'PROBLEM', title: 'Problem', isOptional: false },
    { key: 'OUR_PRODUCT', title: 'Our Product', isOptional: false },
    { key: 'KEY_BENEFITS', title: 'Key Benefits', isOptional: false },
    { key: 'CLINICAL_EVIDENCE', title: 'Clinical Evidence', isOptional: true },
    { key: 'SUMMARY', title: 'Summary', isOptional: false },
    { key: 'CTA', title: 'Call To Action', isOptional: true }
  ];
  return defs.map((d, i) => ({
    sectionId: new mongoose.Types.ObjectId(),
    key: d.key,
    title: d.title,
    sortOrder: i,
    isOptional: d.isOptional,
    slideIds: []
  }));
}

module.exports = {
  evaluatePresentationQuality,
  defaultStorySections,
  SECTION_KEYS
};
