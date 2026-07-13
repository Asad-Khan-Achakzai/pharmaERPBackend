const mongoose = require('mongoose');
const ProductPresentation = require('../models/ProductPresentation');
const Product = require('../models/Product');
const MediaAsset = require('../models/MediaAsset');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const r2 = require('./storage/r2.client');
const env = require('../config/env');
const {
  evaluatePresentationQuality,
  defaultStorySections
} = require('./presentationQuality.service');

const SLIDE_TYPES = ProductPresentation.SLIDE_TYPES;
const SECTION_KEYS = ProductPresentation.SECTION_KEYS;
const COMPONENT_TYPES = ProductPresentation.COMPONENT_TYPES;

async function bumpProductCatalogVersion(product) {
  product.catalogVersion = (product.catalogVersion || 0) + 1;
}

async function signAsset(asset) {
  if (!asset) return null;
  const r2Active = env.MEDIA_STORAGE_PROVIDER === 'r2' && r2.isConfigured();
  let url = null;
  let expiresIn = 0;
  if (r2Active) {
    const signed = await r2.getPresignedGetUrl({ key: asset.key });
    url = signed.url;
    expiresIn = signed.expiresIn;
  } else if (env.MEDIA_PUBLIC_BASE_URL) {
    url = `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${asset.key}`;
  }
  return {
    assetId: String(asset._id),
    mime: asset.mime,
    url,
    expiresIn
  };
}

async function withSlideUrls(companyId, presentation) {
  if (!presentation) return presentation;
  const obj = typeof presentation.toObject === 'function' ? presentation.toObject() : { ...presentation };
  const assetIds = [];
  for (const s of obj.slides || []) {
    if (s.assetId) assetIds.push(s.assetId);
    if (s.backgroundAssetId) assetIds.push(s.backgroundAssetId);
  }
  if (obj.theme?.logoAssetId) assetIds.push(obj.theme.logoAssetId);
  if (obj.theme?.backgroundAssetId) assetIds.push(obj.theme.backgroundAssetId);

  if (!assetIds.length) return obj;

  const assets = await MediaAsset.find({
    _id: { $in: assetIds },
    companyId,
    status: 'READY',
    deletedAt: null
  }).lean();
  const byId = new Map(assets.map((a) => [String(a._id), a]));

  obj.slides = await Promise.all(
    (obj.slides || []).map(async (s) => {
      const asset = s.assetId ? byId.get(String(s.assetId)) : null;
      const bg = s.backgroundAssetId ? byId.get(String(s.backgroundAssetId)) : null;
      return {
        ...s,
        media: await signAsset(asset),
        backgroundMedia: await signAsset(bg)
      };
    })
  );

  if (obj.theme) {
    const logo = obj.theme.logoAssetId ? byId.get(String(obj.theme.logoAssetId)) : null;
    const bg = obj.theme.backgroundAssetId ? byId.get(String(obj.theme.backgroundAssetId)) : null;
    obj.theme = {
      ...obj.theme,
      logoMedia: await signAsset(logo),
      backgroundMedia: await signAsset(bg)
    };
  }

  return obj;
}

const normalizeComponents = (components) => {
  if (!Array.isArray(components) || !components.length) return undefined;
  return components.map((c) => {
    if (!COMPONENT_TYPES.includes(c.type)) {
      throw new ApiError(400, `Invalid component type: ${c.type}`);
    }
    return {
      componentId: c.componentId
        ? new mongoose.Types.ObjectId(c.componentId)
        : new mongoose.Types.ObjectId(),
      type: c.type,
      version: c.version != null ? Number(c.version) : 1,
      props: c.props && typeof c.props === 'object' ? c.props : {},
      style: c.style || null,
      analyticsId: c.analyticsId || null
    };
  });
};

const normalizeSlides = (slides = []) => {
  if (!Array.isArray(slides)) throw new ApiError(400, 'slides must be an array');
  return slides.map((s, idx) => {
    if (!SLIDE_TYPES.includes(s.type)) throw new ApiError(400, `Invalid slide type: ${s.type}`);
    const bullets = Array.isArray(s.bullets)
      ? s.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 8)
      : undefined;
    return {
      slideId: s.slideId ? new mongoose.Types.ObjectId(s.slideId) : new mongoose.Types.ObjectId(),
      sortOrder: s.sortOrder != null ? Number(s.sortOrder) : idx,
      type: s.type,
      sectionId: s.sectionId ? new mongoose.Types.ObjectId(s.sectionId) : null,
      title: s.title || '',
      body: s.body || '',
      bullets,
      highlight: s.highlight || null,
      assetId: s.assetId || null,
      backgroundAssetId: s.backgroundAssetId || null,
      iconKey: s.iconKey || null,
      durationHintSec: s.durationHintSec != null ? Number(s.durationHintSec) : null,
      isOfflineEligible: s.isOfflineEligible !== false,
      components: normalizeComponents(s.components)
    };
  });
};

const normalizeSections = (sections) => {
  if (!Array.isArray(sections)) return [];
  return sections.map((s, idx) => {
    if (!SECTION_KEYS.includes(s.key)) throw new ApiError(400, `Invalid section key: ${s.key}`);
    return {
      sectionId: s.sectionId
        ? new mongoose.Types.ObjectId(s.sectionId)
        : new mongoose.Types.ObjectId(),
      key: s.key,
      title: s.title || s.key,
      sortOrder: s.sortOrder != null ? Number(s.sortOrder) : idx,
      isOptional: Boolean(s.isOptional),
      slideIds: Array.isArray(s.slideIds)
        ? s.slideIds.filter(Boolean).map((id) => new mongoose.Types.ObjectId(id))
        : []
    };
  });
};

const normalizeTheme = (theme) => {
  if (!theme || typeof theme !== 'object') return undefined;
  return {
    primaryColor: theme.primaryColor || '#0B6E4F',
    secondaryColor: theme.secondaryColor || '#083D77',
    surfaceStyle: ['dark', 'light', 'brandWash'].includes(theme.surfaceStyle)
      ? theme.surfaceStyle
      : 'brandWash',
    logoAssetId: theme.logoAssetId || null,
    backgroundAssetId: theme.backgroundAssetId || null,
    fontStyle: theme.fontStyle === 'classic' ? 'classic' : 'modern'
  };
};

const applyQuality = (doc) => {
  const report = evaluatePresentationQuality(doc.toObject ? doc.toObject() : doc);
  doc.qualityReport = {
    score: report.score,
    checkedAt: report.checkedAt,
    checks: report.checks
  };
  return report;
};

const listForProduct = async (companyId, productId) => {
  const product = await Product.findOne({ _id: productId, companyId }).select('_id').lean();
  if (!product) throw new ApiError(404, 'Product not found');
  const docs = await ProductPresentation.find({ companyId, productId }).sort({ updatedAt: -1 }).lean();
  // Sign slide/theme media so the builder keeps image previews after save/reload.
  return Promise.all(docs.map((d) => withSlideUrls(companyId, d)));
};

const getById = async (companyId, id, { withMedia = true } = {}) => {
  const doc = await ProductPresentation.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Presentation not found');
  return withMedia ? withSlideUrls(companyId, doc) : doc.toObject();
};

const getDefaultForProduct = async (companyId, productId) => {
  const doc = await ProductPresentation.findOne({
    companyId,
    productId,
    status: 'PUBLISHED',
    isDefault: true
  });
  if (!doc) return null;
  return withSlideUrls(companyId, doc);
};

const create = async (companyId, productId, data, reqUser) => {
  const product = await Product.findOne({ _id: productId, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  const slides = normalizeSlides(data.slides || []);
  const sections =
    data.sections != null ? normalizeSections(data.sections) : defaultStorySections();
  const theme = normalizeTheme(data.theme) || {
    primaryColor: '#0B6E4F',
    secondaryColor: '#083D77',
    surfaceStyle: 'brandWash',
    fontStyle: 'modern'
  };

  const doc = await ProductPresentation.create({
    companyId,
    productId,
    title: String(data.title || `${product.name} Presentation`).trim(),
    status: 'DRAFT',
    version: 1,
    isDefault: false,
    audience: data.audience || 'GENERAL',
    origin: data.origin === 'AI_DRAFT' ? 'AI_DRAFT' : 'MANUAL',
    theme,
    sections,
    slides,
    createdBy: reqUser.userId
  });
  applyQuality(doc);
  await doc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'presentation.create',
    entityType: 'ProductPresentation',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });
  return withSlideUrls(companyId, doc);
};

const update = async (companyId, id, data, reqUser) => {
  const doc = await ProductPresentation.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Presentation not found');
  if (doc.status === 'ARCHIVED') throw new ApiError(409, 'Cannot edit an archived presentation');
  const before = doc.toObject();
  if (data.title != null) doc.title = String(data.title).trim();
  if (data.audience != null) doc.audience = data.audience;
  if (data.slides != null) doc.slides = normalizeSlides(data.slides);
  if (data.sections != null) doc.sections = normalizeSections(data.sections);
  if (data.theme != null) doc.theme = normalizeTheme(data.theme);
  if (
    doc.status === 'PUBLISHED' &&
    (data.slides != null || data.sections != null || data.theme != null)
  ) {
    doc.status = 'DRAFT';
    doc.isDefault = false;
  }
  doc.updatedBy = reqUser.userId;
  applyQuality(doc);
  await doc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'presentation.update',
    entityType: 'ProductPresentation',
    entityId: doc._id,
    changes: { before, after: doc.toObject() }
  });
  return withSlideUrls(companyId, doc);
};

const qualityCheck = async (companyId, id) => {
  const doc = await ProductPresentation.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Presentation not found');
  const report = applyQuality(doc);
  await doc.save();
  return report;
};

const publish = async (companyId, id, reqUser) => {
  const doc = await ProductPresentation.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Presentation not found');
  if (!doc.slides || doc.slides.length === 0) {
    throw new ApiError(400, 'Cannot publish a presentation with no slides');
  }
  const report = applyQuality(doc);
  if (!report.canPublish) {
    const errs = report.checks.filter((c) => c.severity === 'ERROR').map((c) => c.message);
    throw new ApiError(400, `Quality gate failed: ${errs.join('; ')}`, report.checks);
  }

  const product = await Product.findOne({ _id: doc.productId, companyId });
  if (!product) throw new ApiError(404, 'Product not found');

  await ProductPresentation.updateMany(
    {
      companyId,
      productId: doc.productId,
      _id: { $ne: doc._id },
      isDefault: true,
      isDeleted: { $ne: true }
    },
    { $set: { isDefault: false, status: 'ARCHIVED', updatedBy: reqUser.userId } }
  );

  doc.status = 'PUBLISHED';
  doc.isDefault = true;
  doc.version = (doc.version || 0) + 1;
  doc.publishedAt = new Date();
  doc.updatedBy = reqUser.userId;
  await doc.save();

  product.defaultPresentationId = doc._id;
  await bumpProductCatalogVersion(product);
  await product.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'presentation.publish',
    entityType: 'ProductPresentation',
    entityId: doc._id,
    changes: { after: { status: 'PUBLISHED', version: doc.version, qualityScore: report.score } }
  });
  return withSlideUrls(companyId, doc);
};

const remove = async (companyId, id, reqUser) => {
  const doc = await ProductPresentation.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Presentation not found');
  if (doc.isDefault) {
    await Product.updateOne(
      { _id: doc.productId, companyId, defaultPresentationId: doc._id },
      { $set: { defaultPresentationId: null } }
    );
  }
  await doc.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'presentation.delete',
    entityType: 'ProductPresentation',
    entityId: doc._id,
    changes: { after: { isDeleted: true } }
  });
  return doc;
};

const listPublishedDefaults = async (companyId, { since, limit = 200 } = {}) => {
  const filter = { companyId, status: 'PUBLISHED', isDefault: true };
  if (since) filter.updatedAt = { $gt: new Date(since) };
  const docs = await ProductPresentation.find(filter).sort({ updatedAt: 1 }).limit(limit).lean();
  return Promise.all(docs.map((d) => withSlideUrls(companyId, d)));
};

module.exports = {
  listForProduct,
  getById,
  getDefaultForProduct,
  create,
  update,
  publish,
  remove,
  qualityCheck,
  listPublishedDefaults,
  withSlideUrls,
  evaluatePresentationQuality
};
