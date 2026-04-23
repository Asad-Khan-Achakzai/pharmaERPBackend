const PDFDocument = require('pdfkit');
const { roundPKR } = require('./currency');

const fmtMoney = (n) => {
  const x = Number(n) || 0;
  return x.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * @param {object} opts
 * @param {import('stream').Writable} opts.stream
 * @param {{ name?: string; address?: string; city?: string; phone?: string; email?: string }} opts.company
 * @param {{ name?: string; address?: string; phone?: string; email?: string }} opts.supplier
 * @param {object} opts.ledger - SupplierLedger plain object (type PAYMENT)
 */
function generateSupplierPaymentPdf({ stream, company, supplier, ledger }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(stream);

  const voucherId = ledger.voucherNumber || String(ledger._id);
  const payDate = ledger.date ? new Date(ledger.date) : new Date();
  const method = ledger.paymentMethod || 'OTHER';

  doc.fontSize(18).text(company?.name || 'Company', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(12).text('Supplier payment voucher', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#555');
  if (company?.address) doc.text(company.address, { align: 'center' });
  const cityLine = [company?.city, company?.phone].filter(Boolean).join(' · ');
  if (cityLine) doc.text(cityLine, { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(1);

  doc.fontSize(10).text(`Voucher ID: ${voucherId}`);
  doc.text(`Payment date: ${payDate.toLocaleDateString('en-GB')}`);
  doc.moveDown(0.8);

  doc.fontSize(11).fillColor('#1a237e').text('Pay to (supplier)');
  doc.moveDown(0.3).fillColor('#000').fontSize(10);
  doc.text(supplier?.name || '—');
  if (supplier?.address) doc.text(supplier.address);
  if (supplier?.phone) doc.text(`Phone: ${supplier.phone}`);
  if (supplier?.email) doc.text(`Email: ${supplier.email}`);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#1a237e').text('Payment details');
  doc.moveDown(0.3).fillColor('#000').fontSize(10);
  doc.text(`Amount paid: PKR ${fmtMoney(roundPKR(ledger.amount))}`);
  doc.text(`Payment method: ${method}`);
  if (ledger.referenceNumber) doc.text(`Reference: ${ledger.referenceNumber}`);
  if (ledger.notes) doc.moveDown(0.3).text(`Notes: ${ledger.notes}`);
  if (ledger.verificationStatus) doc.moveDown(0.3).text(`Status: ${ledger.verificationStatus}`);
  doc.moveDown(1.2);

  doc.fontSize(9).fillColor('#555').text('This document is a record of a supplier payment. It does not change inventory or profit calculations.', {
    align: 'center'
  });
  doc.moveDown(0.5);
  doc.text('System generated PDF.', { align: 'center' });

  doc.end();
}

module.exports = { generateSupplierPaymentPdf };
