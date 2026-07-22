const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const DeliveryRecord = require('../models/DeliveryRecord');
const { roundPKR } = require('../utils/currency');
const { getTimeZone, toBusinessTime } = require('../utils/businessTime');
const env = require('../config/env');
const { companyPhoneList, resolveCompanyLogoFile } = require('../utils/companyContact');

const invoiceDir = path.join(__dirname, '../../invoices');

const ensureDir = () => {
  if (!fs.existsSync(invoiceDir)) {
    fs.mkdirSync(invoiceDir, { recursive: true });
  }
};

const money = (n) => roundPKR(Number(n) || 0).toFixed(2);

const up = (s) => (s == null || s === '' ? '' : String(s).toUpperCase());

/** Compact numeric-ish code from Mongo ObjectId (invoice-style REF column). */
const oidCode = (id) => {
  if (!id) return '';
  const hex = String(id).replace(/[^a-fA-F0-9]/g, '').slice(-6);
  const num = parseInt(hex || '0', 16);
  return String((num % 90000) + 1000).slice(0, 6);
};

const strokeRect = (doc, x, y, w, h) => {
  doc.save();
  doc.lineWidth(0.5).strokeColor('#000000');
  doc.rect(x, y, w, h).stroke();
  doc.restore();
};

const fillRect = (doc, x, y, w, h, fill) => {
  doc.save();
  doc.fillColor(fill).rect(x, y, w, h).fill();
  doc.fillColor('#000000');
  doc.restore();
};

/**
 * Trade-style delivery invoice (grid layout).
 */
const generateInvoice = async (deliveryId) => {
  ensureDir();

  const delivery = await DeliveryRecord.findById(deliveryId)
    .populate({ path: 'companyId', select: '+logoBase64 +logoMime' })
    .populate({
      path: 'orderId',
      populate: [
        { path: 'pharmacyId' },
        { path: 'distributorId' },
        { path: 'doctorId', select: 'name' },
        { path: 'medicalRepId', select: 'name employeeCode' }
      ]
    })
    .populate('deliveredBy', 'name employeeCode')
    .populate('items.productId', 'name composition tp');

  if (!delivery) {
    throw new Error('Delivery not found');
  }

  const order = delivery.orderId;
  const company = delivery.companyId;
  const pharmacy = order.pharmacyId;
  const distributor = order.distributorId;
  const tz = getTimeZone(company);
  const deliveredWall = toBusinessTime(delivery.deliveredAt, tz);

  const orderItemByProduct = {};
  for (const oi of order.items || []) {
    orderItemByProduct[String(oi.productId)] = oi;
  }

  const advancePct = Number(env.INVOICE_ADVANCE_TAX_236H_PERCENT) || 0;
  const pharmacyNet = roundPKR(delivery.pharmacyNetPayable ?? delivery.totalAmount ?? 0);
  const advanceTax = advancePct > 0 ? roundPKR((pharmacyNet * advancePct) / 100) : 0;
  const netAfterAdvance = roundPKR(pharmacyNet + advanceTax);

    let sumPackDisc = 0;
    const rows = [];
    for (const line of delivery.items) {
      const pid = line.productId;
      const prod = pid && typeof pid === 'object' ? pid : null;
      const oid = prod?._id ?? pid;
      const physicalQty = Number(line.quantity) || 0;
      const oi = orderItemByProduct[String(prod?._id ?? pid)] || {};
      const tpRate = oi.tpAtTime != null ? Number(oi.tpAtTime) : Number(prod?.tp ?? 0);

      const storedPaid = line.paidQuantity != null ? Number(line.paidQuantity) : null;
      const storedBon = line.bonusQuantity != null ? Number(line.bonusQuantity) : null;

      /**
       * QTY = paid packs, BON = free packs.
       * Prefer delivery snapshots. Do not infer paid from tpLineTotal / TP —
       * tpLineTotal is frozen as TP × physical (paid + bonus).
       */
      let paidQty;
      let bonQty;
      const storedSumOk =
        storedPaid != null &&
        storedBon != null &&
        storedPaid >= 0 &&
        storedBon >= 0 &&
        storedPaid + storedBon === physicalQty;
      if (storedSumOk) {
        paidQty = storedPaid;
        bonQty = storedBon;
      } else if (storedPaid != null && storedPaid >= 0 && storedPaid <= physicalQty) {
        paidQty = storedPaid;
        bonQty = physicalQty - paidQty;
      } else if (storedBon != null && storedBon >= 0 && storedBon <= physicalQty) {
        bonQty = storedBon;
        paidQty = physicalQty - bonQty;
      } else {
        const orderPaid = Number(oi.quantity) || 0;
        const orderBon = Number(oi.bonusQuantity) || 0;
        const orderPhysical = orderPaid + orderBon;
        if (orderPhysical > 0 && physicalQty === orderPhysical) {
          paidQty = orderPaid;
          bonQty = orderBon;
        } else if (orderPhysical > 0) {
          const ratio = physicalQty / orderPhysical;
          paidQty = Math.min(physicalQty, Math.max(0, Math.round(orderPaid * ratio)));
          bonQty = physicalQty - paidQty;
        } else {
          paidQty = physicalQty;
          bonQty = 0;
        }
      }

      /** NET VALUE = paid × TP.RATE (bonus packs are free). */
      const netVal = roundPKR(paidQty * tpRate);
      /** NET DISC = billed TP minus pharmacy net (excludes free-goods TP). */
      const packDisc = roundPKR(netVal - Number(line.linePharmacyNet ?? 0));
      sumPackDisc += packDisc;

      const descParts = [prod?.name, prod?.composition].filter(Boolean);
      rows.push({
        code: oidCode(oid),
        description: descParts.join(' ').trim() || '—',
        batch: '',
        qty: paidQty,
        bon: bonQty,
        tpRate,
        netVal,
        packDisc,
        stax: 0,
        whTax: '',
        net: line.linePharmacyNet ?? 0
      });
    }
    sumPackDisc = roundPKR(sumPackDisc);
    const sumNetVal = roundPKR(rows.reduce((s, r) => s + r.netVal, 0));

    const filePath = path.join(invoiceDir, `${delivery.invoiceNumber}.pdf`);

    return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const pageW = doc.page.width;
    const margin = 28;
    const innerLeft = margin;
    const innerW = pageW - margin * 2;
    let y = margin;

    const companyAddrLine = [company.address, company.city, company.state].filter(Boolean).join(', ');
    const phones = companyPhoneList(company);
    const companyPhone = phones.length ? `PHONE / FAX #: ${phones.join(', ')}` : '';
    const companyEmail = company.email ? `EMAIL ID: ${company.email}` : '';
    const logoSrc = resolveCompanyLogoFile(company);

    const delivered = delivery.deliveredBy;
    const userCode = delivered?.employeeCode || (delivered?._id ? String(delivered._id).slice(-4) : '');
    const userLine = delivered ? `USER : ${userCode} = ${up(delivered.name)}` : '';

    const logoSize = 48;
    const logoGap = 10;
    let textLeft = innerLeft;
    let logoDrawn = false;
    if (logoSrc) {
      try {
        doc.image(logoSrc, innerLeft, y, { fit: [logoSize, logoSize] });
        textLeft = innerLeft + logoSize + logoGap;
        logoDrawn = true;
      } catch {
        /* skip broken logo */
      }
    }

    const nameW = logoDrawn ? innerW - (logoSize + logoGap) - innerW * 0.42 : innerW * 0.55;
    doc.font('Times-Bold').fontSize(15).text(up(company.name), textLeft, y, { width: nameW });
    doc.font('Helvetica').fontSize(8).text(userLine, innerLeft + innerW * 0.52, y, {
      width: innerW * 0.48,
      align: 'right'
    });
    y += (logoDrawn ? logoSize : 22) + 4;

    const contactW = innerW * 0.72;
    doc.font('Helvetica').fontSize(8);
    if (companyAddrLine) {
      doc.text(`ADDRESS: ${up(companyAddrLine)}`, innerLeft, y, { width: contactW });
      y = doc.y + 2;
    }
    if (companyPhone) {
      doc.text(companyPhone, innerLeft, y, { width: contactW });
      y = doc.y + 2;
    }
    if (companyEmail) {
      doc.text(companyEmail, innerLeft, y, { width: contactW });
      y = doc.y + 2;
    }
    y += 12;

    const titleBoxW = 120;
    const titleBoxX = innerLeft + (innerW - titleBoxW) / 2;
    strokeRect(doc, titleBoxX, y, titleBoxW, 22);
    doc.font('Helvetica-Bold').fontSize(11).text('INVOICE', titleBoxX, y + 6, { width: titleBoxW, align: 'center' });
    y += 34;

    const metaH = 78;
    strokeRect(doc, innerLeft, y, innerW, metaH);
    doc.moveTo(innerLeft + innerW / 2, y).lineTo(innerLeft + innerW / 2, y + metaH).stroke();

    const mx = innerLeft + 8;
    const my = y + 8;
    doc.font('Helvetica-Bold').fontSize(8).text('Customer', mx - 2, y - 10);

    const pharmacyCode = oidCode(pharmacy._id);
    const pharmacyAddr = [pharmacy.address, pharmacy.city].filter(Boolean).join(', ');
    doc.font('Helvetica').fontSize(8);
    doc.text(`INVOICE NO: ${delivery.invoiceNumber}`, mx, my);
    doc.text(`CODE: ${pharmacyCode}`, mx, my + 11);
    doc.text(`NAME: ${up(pharmacy.name)}`, mx, my + 22);
    doc.text(`ADDRESS: ${up(pharmacyAddr || pharmacy.name)}`, mx, my + 33, { width: innerW / 2 - 16 });
    doc.text('INCLUED SUMMARY: N', mx, my + 49);

    const rx = innerLeft + innerW / 2 + 8;
    doc.text(`DATE: ${deliveredWall.toFormat('dd/MM/yyyy')}`, rx, my);
    doc.text(`TIME: ${deliveredWall.toFormat('HH:mm:ss')}`, rx, my + 11);
    const rep = order.medicalRepId;
    const repLabel = rep ? `${rep.employeeCode ? `${rep.employeeCode} ` : ''}${rep.name}`.trim() : '';
    doc.text(`S/MAN.CODE: ${up(repLabel)}`, rx, my + 22, { width: innerW / 2 - 16 });
    const distLabel = distributor ? `${distributor.name}${distributor.city ? ` ${distributor.city}` : ''}`.trim() : '';
    doc.text(`D/MAN.CODE: ${up(distLabel)}`, rx, my + 33, { width: innerW / 2 - 16 });
    const ntnDisplay = company.ntnNo && String(company.ntnNo).trim() ? up(String(company.ntnNo).trim()) : '';
    doc.text(ntnDisplay ? `NTN_NO: ${ntnDisplay}` : 'NTN_NO:', rx, my + 49, { width: innerW / 2 - 16 });
    doc.text('NIC:', rx, my + 60);

    y += metaH + 10;

    doc.font('Helvetica').fontSize(8);
    doc.text(`INVOICE NO ${delivery.invoiceNumber}`, innerLeft, y);
    doc.text(up(pharmacy.name), innerLeft, y, { width: innerW, align: 'center' });
    doc.text('PAGE NO 1', innerLeft, y, { width: innerW, align: 'right' });
    y += 14;

    const tblLeft = innerLeft;
    const tblW = innerW;
    const hdrH = 18;

    const c = {
      code: 0,
      desc: 38,
      batch: 158,
      qty: 196,
      bon: 222,
      tp: 246,
      pval: 284,
      pdisc: 332,
      stax: 378,
      wh: 418,
      net: 452
    };

    const bonColW = c.tp - c.bon;
    const staxColW = c.wh - c.stax;
    const whColW = c.net - c.wh;
    const narrowPad = 3;

    fillRect(doc, tblLeft, y, tblW, hdrH, '#dddddd');
    strokeRect(doc, tblLeft, y, tblW, hdrH);
    doc.save();
    doc.lineWidth(0.5).strokeColor('#000000');
    const hdrBottom = y + hdrH;
    doc.moveTo(tblLeft + c.desc, y).lineTo(tblLeft + c.desc, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.batch, y).lineTo(tblLeft + c.batch, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.qty, y).lineTo(tblLeft + c.qty, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.bon, y).lineTo(tblLeft + c.bon, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.tp, y).lineTo(tblLeft + c.tp, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.pval, y).lineTo(tblLeft + c.pval, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.pdisc, y).lineTo(tblLeft + c.pdisc, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.stax, y).lineTo(tblLeft + c.stax, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.wh, y).lineTo(tblLeft + c.wh, hdrBottom).stroke();
    doc.moveTo(tblLeft + c.net, y).lineTo(tblLeft + c.net, hdrBottom).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(6.5);
    const hy = y + 5;
    doc.text('CODE', tblLeft + c.code + 2, hy, { width: 34 });
    doc.text('DESCRIPTION', tblLeft + c.desc + 2, hy, { width: 116 });
    doc.text('BATCH', tblLeft + c.batch + 2, hy, { width: 34 });
    doc.text('QTY', tblLeft + c.qty + 2, hy, { width: 22, align: 'right' });
    doc.text('BON', tblLeft + c.bon + narrowPad / 2, hy, { width: bonColW - narrowPad, align: 'center' });
    const rateLabel = company.invoicePriceMode === 'NET' ? 'NP. RATE' : 'TP. RATE';
    doc.text(rateLabel, tblLeft + c.tp + 2, hy, { width: 34, align: 'right' });
    doc.text('NET VALUE', tblLeft + c.pval + 2, hy, { width: 44, align: 'right' });
    doc.text('NET DISC', tblLeft + c.pdisc + 2, hy, { width: 42, align: 'right' });
    doc.text('S.TAX VALUE', tblLeft + c.stax + narrowPad / 2, hy, { width: staxColW - narrowPad, align: 'center' });
    doc.text('W.H TAX', tblLeft + c.wh + narrowPad / 2, hy, { width: whColW - narrowPad, align: 'center' });
    doc.text('NET/TOTAL', tblLeft + c.net + 2, hy, { width: tblW - c.net - 6, align: 'right' });
    y += hdrH;

    const rowH = 20;
    doc.font('Helvetica').fontSize(6.8);

    const drawRowBand = (yy, rh, fillBg) => {
      if (fillBg) fillRect(doc, tblLeft, yy, tblW, rh, '#f5f5f5');
      strokeRect(doc, tblLeft, yy, tblW, rh);
      doc.save();
      doc.lineWidth(0.5).strokeColor('#000000');
      doc.moveTo(tblLeft + c.desc, yy).lineTo(tblLeft + c.desc, yy + rh).stroke();
      doc.moveTo(tblLeft + c.batch, yy).lineTo(tblLeft + c.batch, yy + rh).stroke();
      doc.moveTo(tblLeft + c.qty, yy).lineTo(tblLeft + c.qty, yy + rh).stroke();
      doc.moveTo(tblLeft + c.bon, yy).lineTo(tblLeft + c.bon, yy + rh).stroke();
      doc.moveTo(tblLeft + c.tp, yy).lineTo(tblLeft + c.tp, yy + rh).stroke();
      doc.moveTo(tblLeft + c.pval, yy).lineTo(tblLeft + c.pval, yy + rh).stroke();
      doc.moveTo(tblLeft + c.pdisc, yy).lineTo(tblLeft + c.pdisc, yy + rh).stroke();
      doc.moveTo(tblLeft + c.stax, yy).lineTo(tblLeft + c.stax, yy + rh).stroke();
      doc.moveTo(tblLeft + c.wh, yy).lineTo(tblLeft + c.wh, yy + rh).stroke();
      doc.moveTo(tblLeft + c.net, yy).lineTo(tblLeft + c.net, yy + rh).stroke();
      doc.restore();
    };

    const pageBottom = doc.page.height - 42;

    const paintDataRow = (r, yy, zebra) => {
      drawRowBand(yy, rowH, zebra);
      doc.font('Helvetica').fontSize(6.8);
      doc.text(up(r.code), tblLeft + c.code + 2, yy + 4, { width: 34 });
      doc.text(up(r.description), tblLeft + c.desc + 2, yy + 3, { width: 116, lineGap: 0 });
      doc.text(up(r.batch), tblLeft + c.batch + 2, yy + 4, { width: 34 });
      doc.text(String(r.qty), tblLeft + c.qty + 2, yy + 4, { width: 22, align: 'right' });
      doc.text(String(r.bon), tblLeft + c.bon + narrowPad / 2, yy + 4, { width: bonColW - narrowPad, align: 'center' });
      doc.text(money(r.tpRate), tblLeft + c.tp + 2, yy + 4, { width: 34, align: 'right' });
      doc.text(money(r.netVal), tblLeft + c.pval + 2, yy + 4, { width: 44, align: 'right' });
      doc.text(money(r.packDisc), tblLeft + c.pdisc + 2, yy + 4, { width: 42, align: 'right' });
      doc.text(money(r.stax), tblLeft + c.stax + narrowPad / 2, yy + 4, { width: staxColW - narrowPad, align: 'center' });
      doc.text(r.whTax === '' ? '' : String(r.whTax), tblLeft + c.wh + narrowPad / 2, yy + 4, {
        width: whColW - narrowPad,
        align: 'center'
      });
      doc.text(money(r.net), tblLeft + c.net + 2, yy + 4, { width: tblW - c.net - 6, align: 'right' });
    };

    rows.forEach((r, i) => {
      if (y + rowH > pageBottom) {
        doc.addPage();
        y = margin;
      }
      paintDataRow(r, y, i % 2 === 1);
      y += rowH;
    });

    const totalsRow = () => {
      if (y + rowH > pageBottom) {
        doc.addPage();
        y = margin;
      }
      drawRowBand(y, rowH, false);
      doc.font('Helvetica-Bold').fontSize(7);
      doc.text('TOTAL', tblLeft + c.code + 2, y + 5, { width: 150 });
      doc.text(money(sumNetVal), tblLeft + c.pval + 2, y + 5, { width: 44, align: 'right' });
      doc.text(money(sumPackDisc), tblLeft + c.pdisc + 2, y + 5, { width: 42, align: 'right' });
      doc.text(money(0), tblLeft + c.stax + narrowPad / 2, y + 5, { width: staxColW - narrowPad, align: 'center' });
      doc.text(money(pharmacyNet), tblLeft + c.net + 2, y + 5, { width: tblW - c.net - 6, align: 'right' });
      y += rowH;

      if (y + rowH > pageBottom) {
        doc.addPage();
        y = margin;
      }
      drawRowBand(y, rowH, true);
      doc.font('Helvetica-Bold').fontSize(7);
      doc.text('GRAND TOTAL', tblLeft + c.code + 2, y + 5, { width: 150 });
      doc.text(money(sumNetVal), tblLeft + c.pval + 2, y + 5, { width: 44, align: 'right' });
      doc.text(money(sumPackDisc), tblLeft + c.pdisc + 2, y + 5, { width: 42, align: 'right' });
      doc.text(money(0), tblLeft + c.stax + narrowPad / 2, y + 5, { width: staxColW - narrowPad, align: 'center' });
      doc.text(money(pharmacyNet), tblLeft + c.net + 2, y + 5, { width: tblW - c.net - 6, align: 'right' });
      y += rowH + 6;
    };

    totalsRow();

    doc.font('Helvetica').fontSize(8);
    doc.text(String(rows.length), innerLeft, y);
    y += 12;

    const refParts = [];
    if (order.doctorId?.name) refParts.push(up(order.doctorId.name));
    if (order.notes) refParts.push(up(order.notes));
    if (refParts.length) {
      doc.text(`REFFRENCE: ${refParts.join(' · ')}`, innerLeft, y, { width: innerW });
      y += 14;
    }

    const pctPrint = advancePct.toFixed(2);
    const taxLabel = `Advance Tax Under Section (236H)=${pctPrint}%`;
    doc.font('Helvetica').fontSize(8);
    doc.text(taxLabel, innerLeft, y, { width: innerW * 0.72 });
    doc.text(money(advanceTax), innerLeft, y, { width: innerW, align: 'right' });
    y += 14;

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('NET.TOTAL', innerLeft, y, { width: innerW * 0.72 });
    doc.text(money(netAfterAdvance), innerLeft, y, { width: innerW, align: 'right' });
    y += 18;

    const loc = up([company.name, company.city].filter(Boolean).join(' '));
    doc.font('Helvetica-Bold').fontSize(8).text('WARRANTY :-', innerLeft, y);
    y += 10;
    doc.font('Helvetica').fontSize(7.5).text(
      `We carrying on business at ${loc}. We do hereby give this warranty that the drugs & medicine of this invoice, as sold by us do not contravene in any way the provision of section 23 of the Drug Act. 1976.`,
      innerLeft,
      y,
      { width: innerW, align: 'justify' }
    );
    y += 28;

    doc.end();

    stream.on('finish', async () => {
      delivery.pdfUrl = `/invoices/${delivery.invoiceNumber}.pdf`;
      await delivery.save();
      resolve(filePath);
    });

    stream.on('error', reject);
  });
};

const invoicePdfPath = (invoiceNumber) => path.join(invoiceDir, `${invoiceNumber}.pdf`);

module.exports = { generateInvoice, invoicePdfPath };
