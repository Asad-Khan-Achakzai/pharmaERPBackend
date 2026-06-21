const mongoose = require('mongoose');
const Joi = require('joi');
const Product = require('../models/Product');
const Pharmacy = require('../models/Pharmacy');
const Distributor = require('../models/Distributor');
const User = require('../models/User');
const ImportJob = require('../models/ImportJob');
const ImportJobRow = require('../models/ImportJobRow');
const ImportCommit = require('../models/ImportCommit');
const OnboardingSession = require('../models/OnboardingSession');
const MigrationAuditEvent = require('../models/MigrationAuditEvent');
const MigrationReconciliation = require('../models/MigrationReconciliation');
const Company = require('../models/Company');
const Supplier = require('../models/Supplier');
const SupplierLedger = require('../models/SupplierLedger');
const Ledger = require('../models/Ledger');
const DistributorInventory = require('../models/DistributorInventory');
const ApiError = require('../utils/ApiError');
const { loadRowsFromWorkbook, sanitizeMapping } = require('./importEngine/adapterRunner');
const { IMPORT_MODE, IMPORT_JOB_STATUS, IMPORT_ROW_STATUS } = require('../constants/onboarding');
const {
  LEDGER_ENTITY_TYPE,
  LEDGER_TYPE,
  LEDGER_REFERENCE_TYPE,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_ADJUSTMENT_EFFECT,
  SUPPLIER_LEDGER_REFERENCE_TYPE
} = require('../constants/enums');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5000;
const PREVIEW_ROWS = 10;
const ERRORS_INLINE_LIMIT = 200;

const DEFAULT_EMPLOYEE_PASSWORD = 'ChangeMe123!';

const ENTITY_CONFIG = {
  products: {
    fields: ['name', 'composition', 'mrp', 'tp', 'casting', 'tpPercent', 'castingPercent'],
    required: ['name', 'mrp', 'tp', 'casting'],
    labels: {
      name: 'Product Name',
      composition: 'Composition',
      mrp: 'MRP',
      tp: 'Trade Price',
      casting: 'Cost Price',
      tpPercent: 'TP %',
      castingPercent: 'Casting %'
    }
  },
  pharmacies: {
    fields: ['name', 'address', 'city', 'state', 'phone', 'email', 'discountOnTP', 'bonusBuyQty', 'bonusGetQty'],
    required: ['name'],
    labels: {
      name: 'Pharmacy Name',
      address: 'Address',
      city: 'City',
      state: 'State',
      phone: 'Phone',
      email: 'Email',
      discountOnTP: 'Discount On TP',
      bonusBuyQty: 'Bonus Buy Qty',
      bonusGetQty: 'Bonus Get Qty'
    }
  },
  distributors: {
    fields: ['name', 'address', 'city', 'state', 'phone', 'email', 'discountOnTP', 'commissionPercentOnTP'],
    required: ['name'],
    labels: {
      name: 'Distributor Name',
      address: 'Address',
      city: 'City',
      state: 'State',
      phone: 'Phone',
      email: 'Email',
      discountOnTP: 'Discount On TP',
      commissionPercentOnTP: 'Commission % On TP'
    }
  },
  employees: {
    fields: ['name', 'email', 'phone', 'password', 'role', 'employeeCode'],
    required: ['name', 'email'],
    labels: {
      name: 'Employee Name',
      email: 'Email',
      phone: 'Phone',
      password: 'Password',
      role: 'Role',
      employeeCode: 'Employee Code'
    }
  },
  openingStock: {
    fields: ['distributor', 'product', 'quantity', 'avgCostPerUnit'],
    required: ['distributor', 'product', 'quantity', 'avgCostPerUnit'],
    labels: {
      distributor: 'Distributor',
      product: 'Product',
      quantity: 'Quantity',
      avgCostPerUnit: 'Avg Cost Per Unit'
    }
  },
  openingBalances: {
    fields: ['accountType', 'entityName', 'amount', 'side', 'notes'],
    required: ['accountType', 'amount'],
    labels: {
      accountType: 'Account Type',
      entityName: 'Entity Name',
      amount: 'Amount',
      side: 'Side',
      notes: 'Notes'
    }
  }
};

const employeeSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  email: Joi.string().required().trim().email(),
  phone: Joi.string().trim().allow(''),
  password: Joi.string().min(6).max(128).default(DEFAULT_EMPLOYEE_PASSWORD),
  role: Joi.string().valid('ADMIN', 'MEDICAL_REP').default('MEDICAL_REP'),
  employeeCode: Joi.string().trim().allow('', null).max(64)
});

const inferMapping = (headers, fields, labels) => {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const out = {};
  for (const f of fields) {
    const candidates = [f, labels[f], f.replace(/([A-Z])/g, ' $1')];
    let chosen = null;
    for (const c of candidates) {
      const hit = byNorm.get(norm(c));
      if (hit) {
        chosen = hit;
        break;
      }
    }
    out[f] = chosen;
  }
  return out;
};

const buildPayload = (row, mapping, fields) => {
  const payload = {};
  let blank = true;
  for (const f of fields) {
    const h = mapping[f];
    const v = h ? row[h] : '';
    const val = v == null ? '' : String(v).trim();
    payload[f] = val;
    if (val !== '') blank = false;
  }
  return { payload, blank };
};

const toNum = (v) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const validateAndNormalize = (entityType, payload) => {
  if (entityType === 'products') {
    const model = {
      name: payload.name,
      composition: payload.composition || '',
      mrp: toNum(payload.mrp),
      tp: toNum(payload.tp),
      casting: toNum(payload.casting),
      tpPercent: toNum(payload.tpPercent),
      castingPercent: toNum(payload.castingPercent)
    };
    const schema = Joi.object({
      name: Joi.string().required().trim().min(1).max(200),
      composition: Joi.string().allow(''),
      mrp: Joi.number().required().min(0),
      tp: Joi.number().required().min(0),
      casting: Joi.number().required().min(0),
      tpPercent: Joi.number().min(0).max(100).optional(),
      castingPercent: Joi.number().min(0).max(100).optional()
    });
    return schema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  if (entityType === 'pharmacies') {
    const model = {
      name: payload.name,
      address: payload.address || '',
      city: payload.city || '',
      state: payload.state || '',
      phone: payload.phone || '',
      email: payload.email || '',
      discountOnTP: toNum(payload.discountOnTP),
      bonusScheme: {
        buyQty: toNum(payload.bonusBuyQty) || 0,
        getQty: toNum(payload.bonusGetQty) || 0
      }
    };
    const schema = Joi.object({
      name: Joi.string().required().trim().min(1).max(200),
      address: Joi.string().allow(''),
      city: Joi.string().allow(''),
      state: Joi.string().allow(''),
      phone: Joi.string().allow(''),
      email: Joi.string().email().allow(''),
      discountOnTP: Joi.number().min(0).max(100).default(0),
      bonusScheme: Joi.object({
        buyQty: Joi.number().min(0).default(0),
        getQty: Joi.number().min(0).default(0)
      })
    });
    return schema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  if (entityType === 'distributors') {
    const model = {
      name: payload.name,
      address: payload.address || '',
      city: payload.city || '',
      state: payload.state || '',
      phone: payload.phone || '',
      email: payload.email || '',
      discountOnTP: toNum(payload.discountOnTP),
      commissionPercentOnTP:
        payload.commissionPercentOnTP === '' ? null : toNum(payload.commissionPercentOnTP)
    };
    const schema = Joi.object({
      name: Joi.string().required().trim().min(1).max(200),
      address: Joi.string().allow(''),
      city: Joi.string().allow(''),
      state: Joi.string().allow(''),
      phone: Joi.string().allow(''),
      email: Joi.string().email().allow(''),
      discountOnTP: Joi.number().min(0).max(100).default(0),
      commissionPercentOnTP: Joi.number().min(0).max(100).allow(null)
    });
    return schema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  if (entityType === 'employees') {
    const model = {
      name: payload.name,
      email: payload.email,
      phone: payload.phone || '',
      password: payload.password || DEFAULT_EMPLOYEE_PASSWORD,
      role: payload.role || 'MEDICAL_REP',
      employeeCode: payload.employeeCode || null
    };
    return employeeSchema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  if (entityType === 'openingStock') {
    const model = {
      distributor: payload.distributor,
      product: payload.product,
      quantity: toNum(payload.quantity),
      avgCostPerUnit: toNum(payload.avgCostPerUnit)
    };
    const schema = Joi.object({
      distributor: Joi.string().required().trim().min(1).max(200),
      product: Joi.string().required().trim().min(1).max(200),
      quantity: Joi.number().required().min(0),
      avgCostPerUnit: Joi.number().required().min(0)
    });
    return schema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  if (entityType === 'openingBalances') {
    const model = {
      accountType: String(payload.accountType || '').toUpperCase(),
      entityName: payload.entityName || '',
      amount: toNum(payload.amount),
      side: String(payload.side || 'DEBIT').toUpperCase(),
      notes: payload.notes || ''
    };
    const schema = Joi.object({
      accountType: Joi.string()
        .valid('PHARMACY_RECEIVABLE', 'DISTRIBUTOR_CLEARING', 'SUPPLIER_PAYABLE', 'COMPANY_CASH')
        .required(),
      entityName: Joi.string().allow(''),
      amount: Joi.number().required().min(0),
      side: Joi.string().valid('DEBIT', 'CREDIT').required(),
      notes: Joi.string().allow('').max(500)
    }).custom((obj, helpers) => {
      if (obj.accountType !== 'COMPANY_CASH' && !obj.entityName.trim()) {
        return helpers.error('any.custom', { message: 'Entity Name is required for this account type' });
      }
      return obj;
    });
    return schema.validate(model, { abortEarly: false, stripUnknown: true });
  }

  throw new ApiError(400, `Unsupported entityType ${entityType}`);
};

const dedupeFilter = (companyId, entityType, value) => {
  if (entityType === 'products') {
    return { companyId, name: value.name, isDeleted: { $ne: true } };
  }
  if (entityType === 'pharmacies') {
    return { companyId, name: value.name, city: value.city || '', isDeleted: { $ne: true } };
  }
  if (entityType === 'distributors') {
    return { companyId, name: value.name, city: value.city || '', isDeleted: { $ne: true } };
  }
  if (entityType === 'employees') {
    return { email: String(value.email).toLowerCase().trim(), isDeleted: { $ne: true } };
  }
  if (entityType === 'openingStock') {
    return null;
  }
  if (entityType === 'openingBalances') {
    return null;
  }
  return null;
};

const modelForEntity = (entityType) => {
  if (entityType === 'products') return Product;
  if (entityType === 'pharmacies') return Pharmacy;
  if (entityType === 'distributors') return Distributor;
  if (entityType === 'employees') return User;
  if (entityType === 'openingStock') return DistributorInventory;
  if (entityType === 'openingBalances') return Ledger;
  throw new ApiError(400, `Unsupported entityType ${entityType}`);
};

const ensureSession = async (companyId, reqUser) => {
  const existing = await OnboardingSession.findOne({ companyId });
  if (existing) return existing;
  return OnboardingSession.create({ companyId, ownerUserId: reqUser.userId });
};

const previewMasterImport = async ({ companyId, fileBase64, sheetName, entityType }) => {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) throw new ApiError(400, 'Unsupported master import entity type');
  const { wb, sheet, headers, rows } = loadRowsFromWorkbook({
    fileBase64,
    sheetName,
    maxFileBytes: MAX_FILE_BYTES,
    maxRows: MAX_ROWS
  });

  const mapping = inferMapping(headers, cfg.fields, cfg.labels);
  const sampleRows = rows.slice(0, PREVIEW_ROWS).map((r) => {
    const { payload } = buildPayload(r, mapping, cfg.fields);
    return { row: r.__rowNumber, ...payload };
  });

  void companyId;
  return {
    sheets: wb.SheetNames,
    sheet,
    headers,
    totalRows: rows.length,
    mapping,
    sampleRows,
    fields: cfg.fields,
    fieldLabels: cfg.labels,
    requiredFields: cfg.required,
    limits: { maxRows: MAX_ROWS, maxFileBytes: MAX_FILE_BYTES }
  };
};

const commitMasterImport = async ({
  companyId,
  reqUser,
  fileBase64,
  sheetName,
  entityType,
  mappingFromClient,
  mode = IMPORT_MODE.DRY_RUN,
  skipDuplicates = true,
  options = {}
}) => {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) throw new ApiError(400, 'Unsupported master import entity type');
  const session = await ensureSession(companyId, reqUser);
  const { sheet, headers, rows } = loadRowsFromWorkbook({
    fileBase64,
    sheetName,
    maxFileBytes: MAX_FILE_BYTES,
    maxRows: MAX_ROWS
  });
  const mapping = sanitizeMapping({ fields: cfg.fields, headers, mappingFromClient });
  for (const req of cfg.required) {
    if (!mapping[req]) throw new ApiError(400, `${cfg.labels[req] || req} column must be mapped`);
  }

  const job = await ImportJob.create({
    companyId,
    onboardingSessionId: session._id,
    entityType,
    mode,
    status: IMPORT_JOB_STATUS.RUNNING,
    requestedBy: reqUser.userId,
    mapping,
    file: { originalName: `${entityType}.xlsx` }
  });

  const Model = modelForEntity(entityType);
  const errors = [];
  let blankRows = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const insertedIds = [];
  const rowWrites = [];

  for (const r of rows) {
    const { payload, blank } = buildPayload(r, mapping, cfg.fields);
    if (blank) {
      blankRows += 1;
      rowWrites.push({
        companyId,
        onboardingSessionId: session._id,
        importJobId: job._id,
        rowNumber: r.__rowNumber,
        status: IMPORT_ROW_STATUS.SKIPPED,
        source: r,
        normalizedPayload: {},
        rowErrors: []
      });
      continue;
    }

    const { value, error } = validateAndNormalize(entityType, payload);
    if (error) {
      failed += 1;
      const msg = error.details[0]?.message || 'Validation failed';
      const field = error.details[0]?.path?.[0] || null;
      const rowErr = { row: r.__rowNumber, status: 'FAILED_VALIDATION', field, message: msg };
      errors.push(rowErr);
      rowWrites.push({
        companyId,
        onboardingSessionId: session._id,
        importJobId: job._id,
        rowNumber: r.__rowNumber,
        status: IMPORT_ROW_STATUS.INVALID,
        source: r,
        normalizedPayload: value || {},
        rowErrors: [{ field, code: 'VALIDATION_ERROR', message: msg }]
      });
      continue;
    }

    const dFilter = dedupeFilter(companyId, entityType, value);
    if (skipDuplicates && dFilter) {
      const existing = await Model.findOne(dFilter).select('_id').lean();
      if (existing) {
        skipped += 1;
        errors.push({
          row: r.__rowNumber,
          status: 'SKIPPED_DUPLICATE',
          field: null,
          message: 'Duplicate row skipped'
        });
        rowWrites.push({
          companyId,
          onboardingSessionId: session._id,
          importJobId: job._id,
          rowNumber: r.__rowNumber,
          status: IMPORT_ROW_STATUS.SKIPPED,
          source: r,
          normalizedPayload: value,
          dedupeKey: JSON.stringify(dFilter),
          rowErrors: []
        });
        continue;
      }
    }

    if (mode === IMPORT_MODE.COMMIT) {
      try {
        let insertedId = null;
        if (entityType === 'employees') {
          const doc = await Model.create({
            ...value,
            companyId,
            createdBy: reqUser.userId,
            permissions: [],
            role: value.role || 'MEDICAL_REP'
          });
          insertedId = doc._id;
          created += 1;
          insertedIds.push(doc._id);
        } else if (entityType === 'openingStock') {
          const distributor = await Distributor.findOne({
            companyId,
            name: value.distributor,
            isDeleted: { $ne: true }
          })
            .select('_id')
            .lean();
          if (!distributor) throw new ApiError(400, `Distributor not found: ${value.distributor}`);
          const product = await Product.findOne({ companyId, name: value.product, isDeleted: { $ne: true } })
            .select('_id')
            .lean();
          if (!product) throw new ApiError(400, `Product not found: ${value.product}`);

          const existingInv = await DistributorInventory.findOne({
            companyId,
            distributorId: distributor._id,
            productId: product._id
          });
          if (existingInv && existingInv.quantity > 0 && options.allowOverwrite !== true) {
            throw new ApiError(400, 'Opening stock already exists for distributor/product. Enable allowOverwrite.');
          }
          const target = existingInv || new DistributorInventory({ companyId, distributorId: distributor._id, productId: product._id });
          target.quantity = value.quantity;
          target.avgCostPerUnit = value.avgCostPerUnit;
          target.lastUpdated = new Date();
          target.updatedBy = reqUser.userId;
          if (!target.createdBy) target.createdBy = reqUser.userId;
          await target.save();
          insertedId = target._id;
          created += 1;
          insertedIds.push(target._id);
        } else if (entityType === 'openingBalances') {
          if (value.accountType === 'COMPANY_CASH') {
            const company = await Company.findById(companyId);
            if (!company) throw new ApiError(404, 'Company not found');
            if (value.side !== 'DEBIT') throw new ApiError(400, 'COMPANY_CASH supports only DEBIT side');
            company.cashOpeningBalance = value.amount;
            await company.save();
            insertedId = company._id;
            created += 1;
            insertedIds.push(company._id);
          } else if (value.accountType === 'SUPPLIER_PAYABLE') {
            const supplier = await Supplier.findOne({
              companyId,
              name: value.entityName,
              isDeleted: { $ne: true }
            });
            if (!supplier) throw new ApiError(400, `Supplier not found: ${value.entityName}`);
            const [entry] = await SupplierLedger.create([
              {
                companyId,
                supplierId: supplier._id,
                type: SUPPLIER_LEDGER_TYPE.ADJUSTMENT,
                adjustmentEffect:
                  value.side === 'DEBIT'
                    ? SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.INCREASE_PAYABLE
                    : SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.DECREASE_PAYABLE,
                amount: value.amount,
                referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.MANUAL,
                referenceId: new mongoose.Types.ObjectId(),
                notes: value.notes || 'Opening balance import',
                createdBy: reqUser.userId
              }
            ]);
            insertedId = entry._id;
            created += 1;
            insertedIds.push(entry._id);
          } else {
            const isPharmacy = value.accountType === 'PHARMACY_RECEIVABLE';
            const entityModel = isPharmacy ? Pharmacy : Distributor;
            const entity = await entityModel.findOne({
              companyId,
              name: value.entityName,
              isDeleted: { $ne: true }
            })
              .select('_id')
              .lean();
            if (!entity) throw new ApiError(400, `${isPharmacy ? 'Pharmacy' : 'Distributor'} not found: ${value.entityName}`);
            const [entry] = await Ledger.create([
              {
                companyId,
                entityType: isPharmacy ? LEDGER_ENTITY_TYPE.PHARMACY : LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
                entityId: entity._id,
                type: value.side === 'DEBIT' ? LEDGER_TYPE.DEBIT : LEDGER_TYPE.CREDIT,
                amount: value.amount,
                referenceType: LEDGER_REFERENCE_TYPE.OPENING_BALANCE,
                referenceId: new mongoose.Types.ObjectId(),
                description: value.notes || 'Opening balance import',
                date: new Date()
              }
            ]);
            insertedId = entry._id;
            created += 1;
            insertedIds.push(entry._id);
          }
        } else {
          const doc = await Model.create({ ...value, companyId, createdBy: reqUser.userId });
          insertedId = doc._id;
          created += 1;
          insertedIds.push(doc._id);
        }

        rowWrites.push({
          companyId,
          onboardingSessionId: session._id,
          importJobId: job._id,
          rowNumber: r.__rowNumber,
          status: IMPORT_ROW_STATUS.COMMITTED,
          source: r,
          normalizedPayload: value,
          commitResult: { insertedId },
          rowErrors: []
        });
      } catch (err) {
        failed += 1;
        const msg = (err?.message || 'Database error').slice(0, 500);
        errors.push({ row: r.__rowNumber, status: 'FAILED_DB', field: null, message: msg });
        rowWrites.push({
          companyId,
          onboardingSessionId: session._id,
          importJobId: job._id,
          rowNumber: r.__rowNumber,
          status: IMPORT_ROW_STATUS.FAILED,
          source: r,
          normalizedPayload: value,
          rowErrors: [{ field: null, code: 'DB_ERROR', message: msg }]
        });
      }
    } else {
      created += 1;
      rowWrites.push({
        companyId,
        onboardingSessionId: session._id,
        importJobId: job._id,
        rowNumber: r.__rowNumber,
        status: IMPORT_ROW_STATUS.VALID,
        source: r,
        normalizedPayload: value,
        rowErrors: []
      });
    }
  }

  if (rowWrites.length) {
    await ImportJobRow.insertMany(rowWrites, { ordered: false });
  }

  if (mode === IMPORT_MODE.COMMIT) {
    await ImportCommit.create({
      companyId,
      onboardingSessionId: session._id,
      importJobId: job._id,
      entityType,
      committedBy: reqUser.userId,
      insertedCount: created,
      skippedCount: skipped,
      failedCount: failed,
      insertedIds
    });
  }

  job.status = failed > 0 && created === 0 ? IMPORT_JOB_STATUS.FAILED : IMPORT_JOB_STATUS.COMPLETED;
  job.finishedAt = new Date();
  job.metrics = {
    totalRows: rows.length,
    validRows: mode === IMPORT_MODE.COMMIT ? created : created,
    invalidRows: failed,
    skippedRows: skipped,
    committedRows: mode === IMPORT_MODE.COMMIT ? created : 0
  };
  job.summary = {
    sheet,
    blankRows,
    created,
    skipped,
    failed
  };
  await job.save();

  if (entityType === 'openingStock' || entityType === 'openingBalances') {
    const sourceAmount = rowWrites
      .filter((x) => x.status === IMPORT_ROW_STATUS.COMMITTED || x.status === IMPORT_ROW_STATUS.VALID)
      .reduce((sum, x) => {
        if (entityType === 'openingStock') {
          const q = Number(x.normalizedPayload?.quantity || 0);
          const c = Number(x.normalizedPayload?.avgCostPerUnit || 0);
          return sum + q * c;
        }
        return sum + Number(x.normalizedPayload?.amount || 0);
      }, 0);
    const targetAmount = sourceAmount;
    await MigrationReconciliation.create({
      companyId,
      onboardingSessionId: session._id,
      importJobId: job._id,
      entityType,
      sourceCount: created + skipped + failed,
      targetCount: created,
      sourceAmount,
      targetAmount,
      status: failed > 0 ? 'REVIEW_REQUIRED' : 'MATCHED',
      mismatches: failed > 0 ? [{ key: 'failedRows', sourceValue: failed, targetValue: created, delta: failed }] : [],
      generatedBy: reqUser.userId
    });
  }

  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    importJobId: job._id,
    eventType: failed > 0 ? 'IMPORT_COMPLETED' : 'IMPORT_COMPLETED',
    actorUserId: reqUser.userId,
    metadata: { entityType, mode, created, skipped, failed }
  });

  return {
    jobId: job._id,
    mode,
    sheet,
    totalRows: rows.length,
    blankRows,
    created,
    skipped,
    failed,
    errors: errors.slice(0, ERRORS_INLINE_LIMIT),
    errorsTruncated: errors.length > ERRORS_INLINE_LIMIT,
    fullErrorCount: errors.length
  };
};

module.exports = { previewMasterImport, commitMasterImport, ENTITY_CONFIG };
