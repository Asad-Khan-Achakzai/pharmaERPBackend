const Joi = require('joi');

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).required(),
  phone: Joi.string().trim().allow('', null),
  email: Joi.string().trim().email().allow('', null),
  address: Joi.string().trim().allow('', null),
  openingBalance: Joi.number().default(0),
  notes: Joi.string().trim().allow('', null),
  isActive: Joi.boolean()
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1),
  phone: Joi.string().trim().allow('', null),
  email: Joi.string().trim().email().allow('', null),
  address: Joi.string().trim().allow('', null),
  openingBalance: Joi.number(),
  notes: Joi.string().trim().allow('', null),
  isActive: Joi.boolean()
});

/** Manual PURCHASE / liability (unchanged shape) */
const ledgerEntrySchema = Joi.object({
  amount: Joi.number().positive().required(),
  date: Joi.date().optional(),
  notes: Joi.string().trim().allow('', null)
});

/** Supplier PAYMENT — method required for audit / voucher */
const paymentRecordSchema = Joi.object({
  amount: Joi.number().positive().required(),
  date: Joi.date().optional(),
  notes: Joi.string().trim().allow('', null),
  paymentMethod: Joi.string().valid('CASH', 'BANK', 'CHEQUE', 'OTHER').required(),
  referenceNumber: Joi.string().trim().allow('', null),
  attachmentUrl: Joi.string().trim().allow('', null),
  verificationStatus: Joi.string().valid('VERIFIED', 'UNVERIFIED').optional(),
  /** Optional application of this payment to posted supplier invoices (Phase 4) */
  paymentAllocations: Joi.array()
    .items(
      Joi.object({
        supplierInvoiceId: Joi.string().trim().required(),
        amount: Joi.number().positive().required()
      })
    )
    .optional()
});

/** At least one field — correct mistaken payment details */
const paymentUpdateSchema = Joi.object({
  amount: Joi.number().positive(),
  date: Joi.date().optional(),
  notes: Joi.string().trim().allow('', null),
  paymentMethod: Joi.string().valid('CASH', 'BANK', 'CHEQUE', 'OTHER'),
  referenceNumber: Joi.string().trim().allow('', null),
  attachmentUrl: Joi.string().trim().allow('', null),
  verificationStatus: Joi.string().valid('VERIFIED', 'UNVERIFIED')
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

const paymentReverseSchema = Joi.object({
  reversalReason: Joi.string().trim().max(500).allow('', null)
});

module.exports = {
  createSchema,
  updateSchema,
  ledgerEntrySchema,
  paymentRecordSchema,
  paymentUpdateSchema,
  paymentReverseSchema
};
