const Pharmacy = require('../models/Pharmacy');
const { normalizeBonusScheme } = require('../utils/bonus');

const applyBonusSchemeInput = (data) => {
  if (data.bonusScheme !== undefined) {
    data.bonusScheme = normalizeBonusScheme(data.bonusScheme);
  }
};

const normalizePharmacyInput = (data) => {
  const o = { ...data };
  applyBonusSchemeInput(o);

  if (Object.prototype.hasOwnProperty.call(o, 'latitude')) {
    if (o.latitude === '' || o.latitude == null || Number.isNaN(Number(o.latitude))) {
      o.latitude = null;
    } else {
      o.latitude = Number(o.latitude);
    }
  }
  if (Object.prototype.hasOwnProperty.call(o, 'longitude')) {
    if (o.longitude === '' || o.longitude == null || Number.isNaN(Number(o.longitude))) {
      o.longitude = null;
    } else {
      o.longitude = Number(o.longitude);
    }
  }

  const hasLat = Object.prototype.hasOwnProperty.call(o, 'latitude') && o.latitude != null;
  const hasLng = Object.prototype.hasOwnProperty.call(o, 'longitude') && o.longitude != null;
  if (hasLat !== hasLng) {
    throw new ApiError(400, 'Valid latitude and longitude are required together');
  }

  return o;
};
const Doctor = require('../models/Doctor');
const Ledger = require('../models/Ledger');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const mediaAttach = require('./media.attach');

/** Attach a transient signed imageUrl to pharmacy docs from MediaAsset (source of truth). */
async function withPharmacyImages(companyId, docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const ids = list.filter(Boolean).map((d) => String(d._id));
  const images = await mediaAttach.resolveEntityImages({ companyId, resource: 'pharmacies', ids });
  const decorate = (d) => {
    if (!d) return d;
    const obj = typeof d.toObject === 'function' ? d.toObject() : d;
    const img = images.get(String(obj._id));
    obj.imageUrl = img ? img.url : null;
    return obj;
  };
  return Array.isArray(docs) ? list.map(decorate) : decorate(docs);
}

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Pharmacy.find(filter).sort(sort).skip(skip).limit(limit),
    Pharmacy.countDocuments(filter)
  ]);
  const withUrls = await withPharmacyImages(companyId, docs);
  return { docs: withUrls, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const { assetId, ...raw } = data;
  const pharmacyData = normalizePharmacyInput(raw);
  const pharmacy = await Pharmacy.create({ ...pharmacyData, companyId, createdBy: reqUser.userId });
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'pharmacies',
      id: pharmacy._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.create', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { after: pharmacy.toObject() } });
  return withPharmacyImages(companyId, pharmacy);
};

const getById = async (companyId, id) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');

  const [doctors, ledgerBalance] = await Promise.all([
    Doctor.find({ companyId, pharmacyId: id, isActive: true }),
    Ledger.aggregate([
      { $match: { companyId: pharmacy.companyId, entityId: pharmacy._id, entityType: 'PHARMACY' } },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
          totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
        }
      }
    ])
  ]);

  const balance = ledgerBalance[0] || { totalDebit: 0, totalCredit: 0 };
  const outstanding = Math.round((balance.totalDebit - balance.totalCredit) * 100) / 100;

  const image = await mediaAttach.resolveEntityImage({ companyId, resource: 'pharmacies', id });
  return { ...pharmacy.toObject(), doctors, outstanding, ledgerSummary: balance, imageUrl: image ? image.url : null };
};

const update = async (companyId, id, data, reqUser) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  const before = pharmacy.toObject();
  const { assetId, ...raw } = data;
  const pharmacyData = normalizePharmacyInput(raw);
  Object.assign(pharmacy, { ...pharmacyData, updatedBy: reqUser.userId });
  await pharmacy.save();
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'pharmacies',
      id: pharmacy._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.update', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { before, after: pharmacy.toObject() } });
  return withPharmacyImages(companyId, pharmacy);
};

const remove = async (companyId, id, reqUser) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  await pharmacy.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.delete', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { after: { isActive: false } } });
  return pharmacy;
};

module.exports = { list, create, getById, update, remove };
