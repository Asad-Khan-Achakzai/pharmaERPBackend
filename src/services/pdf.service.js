const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const CreditNote = require('../models/CreditNote');
const OrderAmendment = require('../models/OrderAmendment');
const { roundPKR } = require('../utils/currency');
const { getTimeZone, toBusinessTime } = require('../utils/businessTime');
const env = require('../config/env');
const { companyPhoneList, resolveCompanyLogoFile } = require('../utils/companyContact');

const invoiceDir = path.join(__dirname, '../../invoices');
const receiptDir = path.join(__dirname, '../../order-receipts');
const creditNoteDir = path.join(__dirname, '../../credit-notes');

const ensureDir = (dir = invoiceDir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

const formatOrderStatusLabel = (status) => {
  if (!status) return '';
  return String(status)
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
};

/** Prefer employee code for invoice meta lines; fall back to display name. */
const employeeCodeOrName = (user) => {
  if (!user) return '';
  const code = user.employeeCode != null ? String(user.employeeCode).trim() : '';
  if (code) return code;
  const name = user.name != null ? String(user.name).trim() : '';
  return name;
};

const safePdfFileToken = (value) =>
  String(value || 'document')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);

/**
 * Shared trade-style layout used by delivery Invoice and Order Receipt.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {object} opts.company
 * @param {object} opts.pharmacy
 * @param {object|null} opts.distributor
 * @param {object|null} opts.medicalRep
 * @param {object|null} [opts.deliveryMan]
 * @param {object|null} opts.doctor
 * @param {string} [opts.notes]
 * @param {string} [opts.userLine]
 * @param {import('luxon').DateTime} opts.docWallTime
 * @param {string} opts.title - e.g. INVOICE | ORDER RECEIPT
 * @param {string} [opts.subtitle] - e.g. Sales Order
 * @param {string} opts.docNumberLabel - e.g. INVOICE NO | ORDER NO
 * @param {string} opts.docNumber
 * @param {string} [opts.statusLabel]
 * @param {string} [opts.notice]
 * @param {string} [opts.warrantyNoun] - "invoice" | "order"
 * @param {boolean} [opts.includeAdvanceTax=true]
 * @param {object|null} [opts.taxSnapshot] - frozen invoice tax; preferred over env
 * @param {number|null} [opts.invoiceGrandTotal]
 * @param {Array} opts.rows
 * @param {number} opts.sumNetVal
 * @param {number} opts.sumPackDisc
 * @param {number} opts.pharmacyNet - goods net
 * @returns {Promise<string>} filePath
 */
const writeTradeStyleDocument = (opts) => {
  const {
    filePath,
    company,
    pharmacy,
    distributor,
    medicalRep,
    deliveryMan,
    doctor,
    notes,
    userLine = '',
    docWallTime,
    title,
    subtitle,
    docNumberLabel,
    docNumber,
    statusLabel,
    notice,
    warrantyNoun = 'invoice',
    includeAdvanceTax = true,
    taxSnapshot = null,
    invoiceGrandTotal = null,
    rows,
    sumNetVal,
    sumPackDisc,
    pharmacyNet
  } = opts;

  const snapLines = Array.isArray(taxSnapshot?.lines) ? taxSnapshot.lines : [];
  const useSnapshotTax = includeAdvanceTax && snapLines.length > 0;
  const advancePct = !useSnapshotTax && includeAdvanceTax
    ? Number(env.INVOICE_ADVANCE_TAX_236H_PERCENT) || 0
    : 0;
  const advanceTax = !useSnapshotTax && advancePct > 0
    ? roundPKR((pharmacyNet * advancePct) / 100)
    : 0;
  const snapshotTaxTotal = useSnapshotTax
    ? roundPKR(taxSnapshot?.amounts?.taxTotal ?? snapLines.reduce((s, l) => s + (l.taxAmount || 0), 0))
    : 0;
  const netAfterAdvance = useSnapshotTax
    ? roundPKR(
        invoiceGrandTotal != null
          ? invoiceGrandTotal
          : taxSnapshot?.amounts?.invoiceGrandTotal ?? pharmacyNet + snapshotTaxTotal
      )
    : roundPKR(pharmacyNet + advanceTax);

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
    if (userLine) {
      doc.font('Helvetica').fontSize(8).text(userLine, innerLeft + innerW * 0.52, y, {
        width: innerW * 0.48,
        align: 'right'
      });
    }
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

    const titleBoxW = subtitle ? 160 : 120;
    const titleBoxH = subtitle ? 32 : 22;
    const titleBoxX = innerLeft + (innerW - titleBoxW) / 2;
    strokeRect(doc, titleBoxX, y, titleBoxW, titleBoxH);
    doc.font('Helvetica-Bold').fontSize(11).text(title, titleBoxX, y + (subtitle ? 5 : 6), {
      width: titleBoxW,
      align: 'center'
    });
    if (subtitle) {
      doc.font('Helvetica').fontSize(7).text(up(subtitle), titleBoxX, y + 18, {
        width: titleBoxW,
        align: 'center'
      });
    }
    y += titleBoxH + 12;

    if (notice) {
      const noticeH = 28;
      fillRect(doc, innerLeft, y, innerW, noticeH, '#fff8e1');
      strokeRect(doc, innerLeft, y, innerW, noticeH);
      doc.font('Helvetica-Bold').fontSize(7.5).text(notice, innerLeft + 8, y + 8, {
        width: innerW - 16,
        align: 'center'
      });
      y += noticeH + 10;
    }

    const pharmacyCode = oidCode(pharmacy?._id);
    const pharmacyAddr = [pharmacy?.address, pharmacy?.city].filter(Boolean).join(', ');
    const lic = pharmacy?.licenseNumber && String(pharmacy.licenseNumber).trim();
    const pNtn = pharmacy?.ntn && String(pharmacy.ntn).trim();
    const leftColLines = [
      `${docNumberLabel}: ${docNumber}`,
      `CODE: ${pharmacyCode}`,
      `NAME: ${up(pharmacy?.name)}`,
      `ADDRESS: ${up(pharmacyAddr || pharmacy?.name || '')}`,
      'INCLUED SUMMARY: N'
    ];
    if (lic) leftColLines.push(`LICENSE: ${up(lic)}`);
    if (pNtn) leftColLines.push(`PHARMACY NTN: ${up(pNtn)}`);
    if (statusLabel) leftColLines.push(`STATUS: ${up(statusLabel)}`);

    const rightColLines = [
      `DATE: ${docWallTime.toFormat('dd/MM/yyyy')}`,
      `TIME: ${docWallTime.toFormat('HH:mm:ss')}`,
      `S/MAN.CODE: ${up(employeeCodeOrName(medicalRep))}`,
      `D/MAN.CODE: ${up(employeeCodeOrName(deliveryMan))}`,
      (() => {
        const ntnDisplay =
          company.ntnNo && String(company.ntnNo).trim() ? up(String(company.ntnNo).trim()) : '';
        return ntnDisplay ? `NTN_NO: ${ntnDisplay}` : 'NTN_NO:';
      })(),
      'NIC:'
    ];

    const lineStep = 11;
    const metaPad = 16;
    const metaH = Math.max(78, metaPad + Math.max(leftColLines.length, rightColLines.length) * lineStep);
    strokeRect(doc, innerLeft, y, innerW, metaH);
    doc.moveTo(innerLeft + innerW / 2, y).lineTo(innerLeft + innerW / 2, y + metaH).stroke();

    const mx = innerLeft + 8;
    const my = y + 8;
    doc.font('Helvetica-Bold').fontSize(8).text('Customer', mx - 2, y - 10);

    const halfW = innerW / 2 - 16;
    leftColLines.forEach((text, idx) => {
      const isStatus = statusLabel && text.startsWith('STATUS:');
      doc.font(isStatus ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      doc.text(text, mx, my + idx * lineStep, { width: halfW });
    });

    const rx = innerLeft + innerW / 2 + 8;
    doc.font('Helvetica').fontSize(8);
    rightColLines.forEach((text, idx) => {
      doc.text(text, rx, my + idx * lineStep, { width: halfW });
    });

    y += metaH + 10;

    doc.font('Helvetica').fontSize(8);
    doc.text(`${docNumberLabel} ${docNumber}`, innerLeft, y);
    doc.text(up(pharmacy?.name), innerLeft, y, { width: innerW, align: 'center' });
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
    doc.text('S.TAX VALUE', tblLeft + c.stax + narrowPad / 2, hy, {
      width: staxColW - narrowPad,
      align: 'center'
    });
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
      doc.text(String(r.bon), tblLeft + c.bon + narrowPad / 2, yy + 4, {
        width: bonColW - narrowPad,
        align: 'center'
      });
      doc.text(money(r.tpRate), tblLeft + c.tp + 2, yy + 4, { width: 34, align: 'right' });
      doc.text(money(r.netVal), tblLeft + c.pval + 2, yy + 4, { width: 44, align: 'right' });
      doc.text(money(r.packDisc), tblLeft + c.pdisc + 2, yy + 4, { width: 42, align: 'right' });
      doc.text(money(r.stax), tblLeft + c.stax + narrowPad / 2, yy + 4, {
        width: staxColW - narrowPad,
        align: 'center'
      });
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

    const paintTotalsRow = (label, yy, zebra) => {
      drawRowBand(yy, rowH, zebra);
      doc.font('Helvetica-Bold').fontSize(6.5);
      doc.text(label, tblLeft + c.code + 2, yy + 4, {
        width: c.desc - c.code - 4,
        align: 'left',
        lineBreak: false
      });
      doc.text(money(sumNetVal), tblLeft + c.pval + 2, yy + 4, {
        width: c.pdisc - c.pval - 4,
        align: 'right',
        lineBreak: false
      });
      doc.text(money(sumPackDisc), tblLeft + c.pdisc + 2, yy + 4, {
        width: c.stax - c.pdisc - 4,
        align: 'right',
        lineBreak: false
      });
      doc.text(money(0), tblLeft + c.stax + narrowPad / 2, yy + 4, {
        width: staxColW - narrowPad,
        align: 'center',
        lineBreak: false
      });
      doc.text(money(pharmacyNet), tblLeft + c.net + 2, yy + 4, {
        width: tblW - c.net - 4,
        align: 'right',
        lineBreak: false
      });
    };

    const totalsRow = () => {
      if (y + rowH > pageBottom) {
        doc.addPage();
        y = margin;
      }
      paintTotalsRow('TOTAL', y, false);
      y += rowH;

      if (y + rowH > pageBottom) {
        doc.addPage();
        y = margin;
      }
      paintTotalsRow('G/Total', y, true);
      y += rowH + 6;
    };

    totalsRow();

    doc.font('Helvetica').fontSize(8);
    doc.text(`Items: ${rows.length}`, innerLeft, y);
    y += 12;

    const refParts = [];
    if (doctor?.name) refParts.push(up(doctor.name));
    if (notes) refParts.push(up(notes));
    if (refParts.length) {
      doc.text(`REFFRENCE: ${refParts.join(' · ')}`, innerLeft, y, { width: innerW });
      y += 14;
    }

    if (includeAdvanceTax && useSnapshotTax) {
      doc.font('Helvetica').fontSize(8);
      for (const tl of snapLines) {
        const pct =
          tl.ratePercent != null && Number.isFinite(Number(tl.ratePercent))
            ? Number(tl.ratePercent).toFixed(2)
            : '';
        const section = tl.taxSection ? ` Section ${tl.taxSection}` : '';
        const name = tl.taxTypeName || tl.taxTypeCode || 'Tax';
        const taxLabel =
          pct !== ''
            ? `${name}${section} @ ${pct}%`
            : tl.taxDescription || `${name}${section}`;
        doc.text(taxLabel, innerLeft, y, { width: innerW * 0.72 });
        doc.text(money(tl.taxAmount || 0), innerLeft, y, { width: innerW, align: 'right' });
        y += 12;
      }
      y += 2;
    } else if (includeAdvanceTax && advancePct > 0) {
      const pctPrint = advancePct.toFixed(2);
      const taxLabel = `Advance Tax Under Section (236H)=${pctPrint}%`;
      doc.font('Helvetica').fontSize(8);
      doc.text(taxLabel, innerLeft, y, { width: innerW * 0.72 });
      doc.text(money(advanceTax), innerLeft, y, { width: innerW, align: 'right' });
      y += 14;
    }

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('NET.TOTAL', innerLeft, y, { width: innerW * 0.72 });
    doc.text(money(includeAdvanceTax ? netAfterAdvance : pharmacyNet), innerLeft, y, {
      width: innerW,
      align: 'right'
    });
    y += 18;

    const loc = up([company.name, company.city].filter(Boolean).join(' '));
    doc.font('Helvetica-Bold').fontSize(8).text('WARRANTY :-', innerLeft, y);
    y += 10;
    doc.font('Helvetica').fontSize(7.5).text(
      `We carrying on business at ${loc}. We do hereby give this warranty that the drugs & medicine of this ${warrantyNoun}, as sold by us do not contravene in any way the provision of section 23 of the Drug Act. 1976.`,
      innerLeft,
      y,
      { width: innerW, align: 'justify' }
    );

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

/**
 * Trade-style delivery invoice (grid layout).
 */
const generateInvoice = async (deliveryId) => {
  ensureDir(invoiceDir);

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

  const pharmacyNet = roundPKR(delivery.pharmacyNetPayable ?? delivery.totalAmount ?? 0);

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

  const delivered = delivery.deliveredBy;
  const userCode = delivered?.employeeCode || (delivered?._id ? String(delivered._id).slice(-4) : '');
  const userLine = delivered ? `USER : ${userCode} = ${up(delivered.name)}` : '';

  await writeTradeStyleDocument({
    filePath,
    company,
    pharmacy,
    distributor,
    medicalRep: order.medicalRepId,
    deliveryMan: delivery.deliveredBy,
    doctor: order.doctorId,
    notes: order.notes,
    userLine,
    docWallTime: deliveredWall,
    title: 'INVOICE',
    docNumberLabel: 'INVOICE NO',
    docNumber: delivery.invoiceNumber,
    warrantyNoun: 'invoice',
    includeAdvanceTax: true,
    taxSnapshot: delivery.taxSnapshot || null,
    invoiceGrandTotal:
      delivery.invoiceGrandTotal != null ? roundPKR(delivery.invoiceGrandTotal) : null,
    rows,
    sumNetVal,
    sumPackDisc,
    pharmacyNet
  });

  delivery.pdfUrl = `/invoices/${delivery.invoiceNumber}.pdf`;
  await delivery.save();
  return filePath;
};

/**
 * Order Receipt (Sales Order) — same trade layout as invoice, for pending/undelivered orders.
 * Uses orderNumber (no new sequence). Not a tax invoice.
 */
const generateOrderReceipt = async (orderId) => {
  ensureDir(receiptDir);

  const order = await Order.findById(orderId)
    .populate({ path: 'companyId', select: '+logoBase64 +logoMime' })
    .populate('pharmacyId')
    .populate('distributorId')
    .populate('doctorId', 'name')
    .populate('medicalRepId', 'name employeeCode')
    .populate('items.productId', 'name composition tp');

  if (!order) {
    throw new Error('Order not found');
  }

  const company = order.companyId;
  const pharmacy = order.pharmacyId;
  const distributor = order.distributorId;
  const tz = getTimeZone(company);
  const orderWall = toBusinessTime(order.orderDate || order.createdAt, tz);

  const pharmacyNet = roundPKR(
    order.amountAfterPharmacyDiscount ?? order.totalAmount ?? order.totalOrderedAmount ?? 0
  );

  let sumPackDisc = 0;
  const rows = [];
  for (const line of order.items || []) {
    const pid = line.productId;
    const prod = pid && typeof pid === 'object' ? pid : null;
    const oid = prod?._id ?? pid;
    const paidQty = Number(line.quantity) || 0;
    const bonQty = Number(line.bonusQuantity) || 0;
    const tpRate = line.tpAtTime != null ? Number(line.tpAtTime) : Number(prod?.tp ?? 0);
    const netVal =
      line.grossAmount != null ? roundPKR(line.grossAmount) : roundPKR(paidQty * tpRate);
    const lineNet =
      line.netAfterPharmacy != null ? roundPKR(line.netAfterPharmacy) : roundPKR(netVal);
    const packDisc =
      line.pharmacyDiscountAmount != null
        ? roundPKR(line.pharmacyDiscountAmount)
        : roundPKR(netVal - lineNet);
    sumPackDisc += packDisc;

    const descParts = [prod?.name || line.productName, prod?.composition].filter(Boolean);
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
      net: lineNet
    });
  }
  sumPackDisc = roundPKR(sumPackDisc);
  const sumNetVal = roundPKR(rows.reduce((s, r) => s + r.netVal, 0));

  const fileToken = safePdfFileToken(order.orderNumber || order._id);
  const filePath = path.join(receiptDir, `${fileToken}.pdf`);

  const rep = order.medicalRepId;
  const userCode = rep?.employeeCode || (rep?._id ? String(rep._id).slice(-4) : '');
  const userLine = rep ? `USER : ${userCode} = ${up(rep.name)}` : '';

  const statusLabel = formatOrderStatusLabel(order.status);

  await writeTradeStyleDocument({
    filePath,
    company,
    pharmacy,
    distributor,
    medicalRep: order.medicalRepId,
    deliveryMan: null,
    doctor: order.doctorId,
    notes: order.notes,
    userLine,
    docWallTime: orderWall,
    title: 'ORDER RECEIPT',
    subtitle: 'Sales Order',
    docNumberLabel: 'ORDER NO',
    docNumber: order.orderNumber || String(order._id),
    statusLabel,
    warrantyNoun: 'order',
    includeAdvanceTax: false,
    rows,
    sumNetVal,
    sumPackDisc,
    pharmacyNet
  });

  return filePath;
};

/**
 * Credit Note PDF — customer-facing financial document.
 * Reads commercial lines/totals from linked OrderAmendment (no re-pricing).
 */
const generateCreditNote = async (creditNoteId) => {
  ensureDir(creditNoteDir);

  const creditNote = await CreditNote.findById(creditNoteId).populate('issuedBy', 'name employeeCode');

  if (!creditNote) {
    throw new Error('Credit note not found');
  }

  const amendment = await OrderAmendment.findById(creditNote.amendmentId)
    .populate({
      path: 'orderId',
      populate: [
        { path: 'companyId', select: '+logoBase64 +logoMime' },
        { path: 'pharmacyId' },
        { path: 'distributorId' },
        { path: 'doctorId', select: 'name' },
        { path: 'medicalRepId', select: 'name employeeCode' }
      ]
    })
    .populate('amendedBy', 'name employeeCode')
    .populate('items.productId', 'name composition');

  if (!amendment) {
    throw new Error('Linked amendment not found');
  }

  const order = amendment.orderId;
  const company = order?.companyId;
  if (!company) {
    throw new Error('Company not found for credit note');
  }

  const pharmacy = order?.pharmacyId;
  const distributor = order?.distributorId;
  const tz = getTimeZone(company);
  const issuedWall = toBusinessTime(creditNote.issuedAt || amendment.amendedAt, tz);

  const pharmacyNet = roundPKR(amendment.totalAmount || 0);
  const invoiceList = (amendment.invoiceNumbers || creditNote.invoiceNumbers || []).filter(Boolean);
  const againstInv = invoiceList.length ? invoiceList.join(', ') : '—';
  const notice = `Does not replace original invoice(s). Against: ${againstInv} · Amendment: ${
    amendment.amendmentNumber || '—'
  } · Allocation: Bonus-First (bonus packs reduced before paid; financial credit applies to paid packs only)`;
  const notesExtra = [
    order?.notes,
    amendment.reason ? `Amendment reason: ${amendment.reason}` : null,
    'Qty column = paid packs credited · BON = bonus packs reversed (inventory). Credit amount is based on paid packs only.'
  ]
    .filter(Boolean)
    .join('\n');

  let sumPackDisc = 0;
  const rows = [];
  for (const line of amendment.items || []) {
    const pid = line.productId;
    const prod = pid && typeof pid === 'object' ? pid : null;
    const oid = prod?._id ?? pid;
    const deltaQty = Number(line.deltaQty) || 0;
    const hasSplit = line.paidDelta != null || line.bonusDelta != null;
    const paidDelta = hasSplit ? Number(line.paidDelta) || 0 : deltaQty;
    const bonusDelta = hasSplit ? Number(line.bonusDelta) || 0 : 0;
    const credit = roundPKR(line.lineCreditAmount || 0);
    const unit =
      paidDelta > 0 && credit > 0
        ? roundPKR(credit / paidDelta)
        : roundPKR(line.finalSellingPrice || 0);
    const policy = line.allocationPolicy || 'BONUS_FIRST';
    const descParts = [
      prod?.name || line.productName,
      prod?.composition,
      `(${line.previousQty} → ${line.newQty}, −${deltaQty} physical)`,
      `paid −${paidDelta} · bonus −${bonusDelta}`,
      policy === 'BONUS_FIRST' ? 'Bonus-First' : policy
    ].filter(Boolean);

    rows.push({
      code: oidCode(oid),
      description: descParts.join(' ').trim() || '—',
      batch: '',
      qty: paidDelta,
      bon: bonusDelta,
      tpRate: unit,
      netVal: credit,
      packDisc: 0,
      stax: 0,
      whTax: '',
      net: credit
    });
  }
  sumPackDisc = 0;
  const sumNetVal = roundPKR(rows.reduce((s, r) => s + r.netVal, 0));

  const fileToken = safePdfFileToken(creditNote.creditNoteNumber);
  const filePath = path.join(creditNoteDir, `${fileToken}.pdf`);

  const issuer = creditNote.issuedBy || amendment.amendedBy;
  const userCode = issuer?.employeeCode || (issuer?._id ? String(issuer._id).slice(-4) : '');
  const userLine = issuer ? `USER : ${userCode} = ${up(issuer.name)}` : '';

  await writeTradeStyleDocument({
    filePath,
    company,
    pharmacy,
    distributor,
    medicalRep: order?.medicalRepId,
    deliveryMan: null,
    doctor: order?.doctorId,
    notes: notesExtra || order?.notes,
    userLine,
    docWallTime: issuedWall,
    title: 'CREDIT NOTE',
    subtitle: 'Accounts receivable adjustment',
    docNumberLabel: 'CREDIT NOTE NO',
    docNumber: creditNote.creditNoteNumber,
    notice,
    warrantyNoun: 'credit note',
    includeAdvanceTax: false,
    rows,
    sumNetVal,
    sumPackDisc,
    pharmacyNet
  });

  creditNote.pdfUrl = `/credit-notes/${fileToken}.pdf`;
  await creditNote.save();
  return filePath;
};

const invoicePdfPath = (invoiceNumber) => path.join(invoiceDir, `${invoiceNumber}.pdf`);

const orderReceiptPdfPath = (orderNumber) =>
  path.join(receiptDir, `${safePdfFileToken(orderNumber)}.pdf`);

const creditNotePdfPath = (creditNoteNumber) =>
  path.join(creditNoteDir, `${safePdfFileToken(creditNoteNumber)}.pdf`);

module.exports = {
  generateInvoice,
  generateOrderReceipt,
  generateCreditNote,
  invoicePdfPath,
  orderReceiptPdfPath,
  creditNotePdfPath
};
