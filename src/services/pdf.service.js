const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const { roundPKR } = require('../utils/currency');

const invoiceDir = path.join(__dirname, '../../invoices');

const ensureDir = () => {
  if (!fs.existsSync(invoiceDir)) {
    fs.mkdirSync(invoiceDir, { recursive: true });
  }
};

const generateInvoice = async (deliveryId) => {
  ensureDir();

  const delivery = await DeliveryRecord.findById(deliveryId)
    .populate({ path: 'orderId', populate: [{ path: 'pharmacyId', select: 'name address city phone' }, { path: 'distributorId', select: 'name' }] })
    .populate('deliveredBy', 'name')
    .populate('items.productId', 'name composition');

  if (!delivery) return;

  const order = delivery.orderId;
  const filePath = path.join(invoiceDir, `${delivery.invoiceNumber}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Invoice #: ${delivery.invoiceNumber}`, { align: 'right' });
    doc.text(`Date: ${new Date(delivery.deliveredAt).toLocaleDateString()}`, { align: 'right' });
    doc.text(`Order #: ${order.orderNumber}`, { align: 'right' });
    doc.moveDown();

    // Pharmacy info
    const pharmacy = order.pharmacyId;
    doc.fontSize(12).text('Bill To:');
    doc.fontSize(10).text(pharmacy.name);
    if (pharmacy.address) doc.text(pharmacy.address);
    if (pharmacy.city) doc.text(pharmacy.city);
    if (pharmacy.phone) doc.text(`Phone: ${pharmacy.phone}`);
    doc.moveDown();

    // Table header
    const tableTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Product', 50, tableTop, { width: 180 });
    doc.text('Qty', 230, tableTop, { width: 50, align: 'right' });
    doc.text('Price', 280, tableTop, { width: 80, align: 'right' });
    doc.text('Profit/Unit', 360, tableTop, { width: 80, align: 'right' });
    doc.text('Total', 440, tableTop, { width: 80, align: 'right' });

    doc.moveTo(50, tableTop + 15).lineTo(520, tableTop + 15).stroke();
    doc.font('Helvetica');

    let y = tableTop + 22;
    for (const item of delivery.items) {
      const name = item.productId?.name || 'Unknown';
      doc.text(name, 50, y, { width: 180 });
      doc.text(String(item.quantity), 230, y, { width: 50, align: 'right' });
      doc.text(roundPKR(item.finalSellingPrice).toFixed(2), 280, y, { width: 80, align: 'right' });
      doc.text(roundPKR(item.profitPerUnit).toFixed(2), 360, y, { width: 80, align: 'right' });
      doc.text(roundPKR(item.finalSellingPrice * item.quantity).toFixed(2), 440, y, { width: 80, align: 'right' });
      y += 18;
    }

    doc.moveTo(50, y).lineTo(520, y).stroke();
    y += 10;

    doc.font('Helvetica-Bold');
    doc.text('Total Amount:', 360, y, { width: 80, align: 'right' });
    doc.text(`PKR ${roundPKR(delivery.totalAmount).toFixed(2)}`, 440, y, { width: 80, align: 'right' });
    y += 15;
    doc.text('Total Cost:', 360, y, { width: 80, align: 'right' });
    doc.text(`PKR ${roundPKR(delivery.totalCost).toFixed(2)}`, 440, y, { width: 80, align: 'right' });
    y += 15;
    doc.text('Profit:', 360, y, { width: 80, align: 'right' });
    doc.text(`PKR ${roundPKR(delivery.totalProfit).toFixed(2)}`, 440, y, { width: 80, align: 'right' });

    doc.end();

    stream.on('finish', async () => {
      delivery.pdfUrl = `/invoices/${delivery.invoiceNumber}.pdf`;
      await delivery.save();
      resolve(filePath);
    });

    stream.on('error', reject);
  });
};

module.exports = { generateInvoice };
