/**
 * Pharmacy account statement PDF — trade/invoice-style layout (aligned with delivery invoice).
 * Read-only; uses workspace snapshot + ledger export pack.
 */
const PDFDocument = require('pdfkit');
const { DateTime } = require('luxon');
const ledgerService = require('./ledger.service');
const pharmacyWorkspaceService = require('./pharmacyWorkspace.service');
const businessTime = require('../utils/businessTime');
const ApiError = require('../utils/ApiError');

const REF_LABEL = {
  DELIVERY: 'SALES INVOICE',
  COLLECTION: 'PAYMENT RECEIVED',
  RETURN: 'SALES RETURN',
  ORDER: 'ORDER',
  PAYMENT: 'PAYMENT',
  SETTLEMENT: 'SETTLEMENT',
  RETURN_CLEARING_ADJ: 'CLEARING ADJ',
  ADJUSTMENT: 'ADJUSTMENT',
  OPENING: 'OPENING BALANCE'
};

const up = (s) => (s == null || s === '' ? '' : String(s).toUpperCase());

const fmtMoney = (n) =>
  `PKR ${(Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtTs = (d, zone) => {
  if (!d) return '—';
  return DateTime.fromJSDate(new Date(d)).setZone(zone || 'UTC').toFormat('dd/MM/yyyy HH:mm');
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

const refLabel = (t) => REF_LABEL[t] || up(t);

const buildPdfBuffer = async ({
  companyId,
  pharmacyId,
  query,
  timeZone,
  generatedByName
}) => {
  const zone = businessTime.requireCompanyIanaZone(timeZone);
  const workspace = await pharmacyWorkspaceService.pharmacyFinancialWorkspace(companyId, pharmacyId, query, zone);
  if (!workspace) throw new ApiError(404, 'Pharmacy not found');
  const ledgerPack = await ledgerService.fetchPharmacyLedgerChronological(companyId, pharmacyId, query, zone, 5000);
  const glob = await ledgerService.getBalance(companyId, pharmacyId);

  const co = workspace.company;
  const ph = workspace.pharmacy;
  const kpis = workspace.kpis || {};
  const fin = workspace.financial || {};
  const k = kpis;

  const nowLine = DateTime.now().setZone(zone).toFormat('dd/MM/yyyy HH:mm');
  const periodFrom = query.from || '—';
  const periodTo = query.to || '—';

  const lastAct =
    k.lastActivityDate != null ? fmtTs(k.lastActivityDate, zone) : '—';
  const creditLim =
    k.creditLimit != null || fin.creditLimit != null ? fmtMoney(k.creditLimit ?? fin.creditLimit) : '—';
  const availCred =
    k.availableCredit != null || fin.availableCredit != null ? fmtMoney(k.availableCredit ?? fin.availableCredit) : '—';
  const avgPay = k.averagePaymentDays != null ? String(k.averagePaymentDays) : '—';

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 36, size: 'A4', info: { Title: 'Pharmacy account statement' } });

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const margin = 28;
    const innerLeft = margin;
    const innerW = pageW - margin * 2;
    let y = margin;
    const pageBottom = doc.page.height - 40;

    const newPageIfNeeded = (needH) => {
      if (y + needH <= pageBottom) return;
      doc.addPage();
      y = margin;
    };

    const companyAddrLine = [co?.address, co?.city, co?.state].filter(Boolean).join(', ');
    const companyPhone = co?.phone ? `PHONE / FAX #: ${co.phone}` : '';
    const companyEmail = co?.email ? `EMAIL ID: ${co.email}` : '';

    doc.font('Times-Bold').fontSize(15).text(up(co?.name || 'COMPANY'), innerLeft, y, { width: innerW * 0.62 });
    doc.font('Helvetica').fontSize(8).text(`GENERATED: ${nowLine}`, innerLeft + innerW * 0.5, y, {
      width: innerW * 0.48,
      align: 'right'
    });
    y += 22;

    doc.font('Helvetica').fontSize(8);
    if (companyAddrLine) doc.text(up(companyAddrLine), innerLeft, y, { width: innerW * 0.72 });
    y += 11;
    if (companyPhone) {
      doc.text(companyPhone, innerLeft, y);
      y += 11;
    }
    if (companyEmail) {
      doc.text(companyEmail, innerLeft, y);
      y += 11;
    }
    y += 6;

    const titleBoxW = 168;
    const titleBoxX = innerLeft + (innerW - titleBoxW) / 2;
    strokeRect(doc, titleBoxX, y, titleBoxW, 22);
    doc.font('Helvetica-Bold').fontSize(11).text('ACCOUNT STATEMENT', titleBoxX, y + 6, { width: titleBoxW, align: 'center' });
    y += 30;

    const metaH = 102;
    newPageIfNeeded(metaH + 24);
    strokeRect(doc, innerLeft, y, innerW, metaH);
    doc.moveTo(innerLeft + innerW / 2, y).lineTo(innerLeft + innerW / 2, y + metaH).stroke();

    const mx = innerLeft + 8;
    const my = y + 8;
    doc.font('Helvetica-Bold').fontSize(8).text('CUSTOMER / PHARMACY', mx - 2, y - 10);

    const pharmacyAddr = [ph.address, ph.city].filter(Boolean).join(', ');
    doc.font('Helvetica').fontSize(8);
    doc.text(`ACCOUNT CODE: ${up(ph.accountCode || '')}`, mx, my);
    doc.text(`NAME: ${up(ph.name)}`, mx, my + 11);
    doc.text(`ADDRESS: ${up(pharmacyAddr || ph.name)}`, mx, my + 22, { width: innerW / 2 - 16 });
    const terr = ph.territory?.name ? `${ph.territory.name}${ph.territory.code ? ` (${ph.territory.code})` : ''}` : '';
    doc.text(terr ? `TERRITORY: ${up(terr)}` : 'TERRITORY: —', mx, my + 44, { width: innerW / 2 - 16 });
    doc.text(ph.assignedRep?.name ? `PRIMARY REP: ${up(ph.assignedRep.name)}` : 'PRIMARY REP: —', mx, my + 55, {
      width: innerW / 2 - 16
    });

    const rx = innerLeft + innerW / 2 + 8;
    doc.text(`STATEMENT PERIOD: ${periodFrom} → ${periodTo}`, rx, my);
    doc.text(`GLOBAL OUTSTANDING: ${fmtMoney(glob.outstanding)}`, rx, my + 11);
    doc.text(`NET LEDGER (DR−CR): ${fmtMoney(workspace.netOutstanding)}`, rx, my + 22);
    doc.text(generatedByName ? `PREPARED BY: ${up(generatedByName)}` : 'PREPARED BY: —', rx, my + 33, {
      width: innerW / 2 - 16
    });
    doc.text(`LAST COLLECTION: ${fin.lastCollectionDate ? fmtTs(fin.lastCollectionDate, zone) : '—'}`, rx, my + 44);
    doc.text(`LAST ORDER: ${fin.lastOrderNumber ? up(fin.lastOrderNumber) : '—'}`, rx, my + 55, { width: innerW / 2 - 16 });

    y += metaH + 12;

    /** Key figures box (KPIs) */
    const kpiH = 88;
    newPageIfNeeded(kpiH + 16);
    doc.font('Helvetica-Bold').fontSize(8).text('KEY FIGURES (LIVE — NOT FILTERED BY STATEMENT TABLE)', innerLeft, y - 10);
    strokeRect(doc, innerLeft, y, innerW, kpiH);
    const kpiMid = innerLeft + innerW / 2;
    doc.moveTo(kpiMid, y).lineTo(kpiMid, y + kpiH).stroke();
    let ky = y + 8;
    const kLH = 11;
    const kPadOuter = 8;
    const kValInsetFromHalfEdge = 12;
    const kpairLeft = (label, value) => {
      const lx = innerLeft + kPadOuter;
      const valueRight = kpiMid - kValInsetFromHalfEdge;
      const valueW = 92;
      doc.font('Helvetica').fontSize(7.5);
      doc.text(`${label}:`, lx, ky, { width: Math.max(40, valueRight - valueW - lx - 4) });
      doc.font('Helvetica-Bold').fontSize(7.5).text(value, valueRight - valueW, ky, { width: valueW, align: 'right' });
      ky += kLH;
    };
    const kpairRight = (label, value) => {
      const lx = kpiMid + kPadOuter;
      const valueRight = innerLeft + innerW - kValInsetFromHalfEdge;
      const valueW = 94;
      doc.font('Helvetica').fontSize(7.5);
      doc.text(`${label}:`, lx, ky, { width: Math.max(40, valueRight - valueW - lx - 4) });
      doc.font('Helvetica-Bold').fontSize(7.5).text(value, valueRight - valueW, ky, { width: valueW, align: 'right' });
      ky += kLH;
    };
    kpairLeft('CURRENT BALANCE (RECEIVABLE)', fmtMoney(k.currentBalance));
    kpairLeft('OVERDUE (31+ DAYS)', fmtMoney(k.overdueBalance));
    kpairLeft('CREDIT LIMIT', creditLim);
    kpairLeft('AVAILABLE CREDIT', availCred);
    ky = y + 8;
    kpairRight('THIS MONTH SALES (DELIVERIES)', fmtMoney(k.monthSales));
    kpairRight('THIS MONTH COLLECTIONS', fmtMoney(k.monthCollections));
    kpairRight('AVG PAYMENT DAYS', avgPay);
    kpairRight('LAST COLLECTION AMOUNT', k.lastCollectionAmount != null ? fmtMoney(k.lastCollectionAmount) : '—');
    kpairRight('LAST ACTIVITY', lastAct);
    y += kpiH + 14;

    /** Aging table */
    const agingRows = (workspace.aging?.display || []).length;
    const agingH = 18 + Math.max(agingRows, 1) * 16 + 8;
    newPageIfNeeded(agingH + 20);
    doc.font('Helvetica-Bold').fontSize(8).text('RECEIVABLE AGING (OPEN DELIVERY BALANCES)', innerLeft, y - 10);
    strokeRect(doc, innerLeft, y, innerW, agingH);
    const agHdr = 18;
    fillRect(doc, innerLeft, y, innerW, agHdr, '#dddddd');
    strokeRect(doc, innerLeft, y, innerW, agHdr);
    doc.font('Helvetica-Bold').fontSize(7).text('BUCKET', innerLeft + 6, y + 5, { width: innerW * 0.62 });
    doc.text('AMOUNT (PKR)', innerLeft + innerW * 0.62, y + 5, { width: innerW * 0.35 - 6, align: 'right' });
    let ay = y + agHdr;
    doc.font('Helvetica').fontSize(7.5);
    for (const row of workspace.aging?.display || []) {
      strokeRect(doc, innerLeft, ay, innerW, 16);
      doc.text(up(row.label), innerLeft + 6, ay + 4, { width: innerW * 0.62 });
      doc.text(fmtMoney(row.amount), innerLeft + innerW * 0.62, ay + 4, { width: innerW * 0.35 - 6, align: 'right' });
      ay += 16;
    }
    y = ay + 12;

    /** Ledger totals by type */
    const byType = workspace.ledgerSummaryByType || [];
    if (byType.length) {
      const tH = 18 + byType.length * 16 + 8;
      newPageIfNeeded(tH + 16);
      doc.font('Helvetica-Bold').fontSize(8).text('TOTALS BY TYPE (GLOBAL LEDGER)', innerLeft, y - 10);
      strokeRect(doc, innerLeft, y, innerW, tH);
      const thh = 18;
      fillRect(doc, innerLeft, y, innerW, thh, '#dddddd');
      strokeRect(doc, innerLeft, y, innerW, thh);
      doc.font('Helvetica-Bold').fontSize(6.5);
      const cw = innerW / 4;
      doc.text('TYPE', innerLeft + 4, y + 5, { width: cw - 8 });
      doc.text('DEBIT', innerLeft + cw, y + 5, { width: cw - 8, align: 'right' });
      doc.text('CREDIT', innerLeft + 2 * cw, y + 5, { width: cw - 8, align: 'right' });
      doc.text('NET', innerLeft + 3 * cw, y + 5, { width: cw - 8, align: 'right' });
      let ty = y + thh;
      for (const r of byType) {
        strokeRect(doc, innerLeft, ty, innerW, 16);
        doc.font('Helvetica').fontSize(7);
        doc.text(refLabel(r.referenceType), innerLeft + 4, ty + 4, { width: cw - 8 });
        doc.text(fmtMoney(r.debit), innerLeft + cw, ty + 4, { width: cw - 8, align: 'right' });
        doc.text(fmtMoney(r.credit), innerLeft + 2 * cw, ty + 4, { width: cw - 8, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(7);
        doc.text(fmtMoney(r.net), innerLeft + 3 * cw, ty + 4, { width: cw - 8, align: 'right' });
        ty += 16;
      }
      y = ty + 12;
    }

    /** Filtered export summary (box height includes wrapped methodology note) */
    const noteRaw = up(workspace.methodologyNote || '');
    doc.font('Helvetica').fontSize(6.8);
    const noteTextW = innerW - 12;
    const noteH = noteRaw.trim() ? doc.heightOfString(noteRaw, { width: noteTextW, lineGap: 2 }) : 0;
    const bodyBeforeNoteH = 8 + 12 + 12 + 12 + 14;
    const sumH = bodyBeforeNoteH + (noteH > 0 ? noteH + 8 : 0);
    newPageIfNeeded(sumH + 36);
    doc.font('Helvetica-Bold').fontSize(8).text('STATEMENT ACTIVITY (FILTERED — TABLE BELOW)', innerLeft, y - 10);
    strokeRect(doc, innerLeft, y, innerW, sumH);
    doc.font('Helvetica').fontSize(7.5);
    let sy = y + 8;
    doc.text(`OPENING BALANCE (WITHIN EXPORT): ${fmtMoney(ledgerPack.openingBalance)}`, innerLeft + 6, sy);
    sy += 12;
    doc.text(`TOTAL DEBIT (EXPORT): ${fmtMoney(ledgerPack.totals.debit)}`, innerLeft + 6, sy);
    sy += 12;
    doc.text(`TOTAL CREDIT (EXPORT): ${fmtMoney(ledgerPack.totals.credit)}`, innerLeft + 6, sy);
    sy += 12;
    doc.font('Helvetica-Bold').fontSize(7.5);
    doc.text(`CLOSING BALANCE (AFTER LAST LINE): ${fmtMoney(ledgerPack.closingBalance)}`, innerLeft + 6, sy);
    sy += 14;
    if (noteRaw.trim()) {
      doc.font('Helvetica').fontSize(6.8).fillColor('#333');
      doc.text(noteRaw, innerLeft + 6, sy, { width: noteTextW, lineGap: 2 });
      doc.fillColor('#000');
    }
    y += sumH + 20;

    /** Activity grid — invoice-style header */
    doc.font('Helvetica-Bold').fontSize(8).text('DETAIL LINES', innerLeft, y - 10);
    y += 4;

    const colW = {
      date: 46,
      doc: 42,
      type: 52,
      debit: 50,
      credit: 50,
      bal: 54
    };
    const usableW = innerW;
    const descW = usableW - colW.date - colW.doc - colW.type - colW.debit - colW.credit - colW.bal;
    const widths = [colW.date, colW.doc, colW.type, descW, colW.debit, colW.credit, colW.bal];
    const headers = ['DATE', 'DOC #', 'TYPE', 'DESCRIPTION', 'DEBIT', 'CREDIT', 'BALANCE'];
    const hdrRow = 18;
    const dataRow = 17;
    const fontSizeRow = 6.8;

    const measureRow = (cells) => {
      doc.fontSize(fontSizeRow);
      let hMax = 12;
      cells.forEach((c, i) => {
        const h = doc.heightOfString(String(c || ''), { width: widths[i], lineGap: 0.35 });
        hMax = Math.max(hMax, h + 4);
      });
      return Math.min(hMax, 36);
    };

    const drawHeaderRow = () => {
      fillRect(doc, innerLeft, y, innerW, hdrRow, '#dddddd');
      strokeRect(doc, innerLeft, y, innerW, hdrRow);
      doc.save();
      doc.lineWidth(0.5).strokeColor('#000000');
      let cx = innerLeft;
      for (let i = 0; i < widths.length; i++) {
        cx += widths[i];
        if (i < widths.length - 1) doc.moveTo(cx, y).lineTo(cx, y + hdrRow).stroke();
      }
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(6.5);
      let hx = innerLeft;
      headers.forEach((h, i) => {
        const align = i >= 4 ? 'right' : 'left';
        doc.text(h, hx + 2, y + 5, { width: widths[i] - 4, align });
        hx += widths[i];
      });
      y += hdrRow;
    };

    const drawDataRow = (cells, zebra) => {
      const rh = measureRow(cells);
      newPageIfNeeded(rh + 4);
      if (y + rh > pageBottom - 20) {
        doc.addPage();
        y = margin;
        drawHeaderRow();
      }
      fillRect(doc, innerLeft, y, innerW, rh, zebra ? '#f5f5f5' : '#ffffff');
      strokeRect(doc, innerLeft, y, innerW, rh);
      doc.save();
      doc.lineWidth(0.5).strokeColor('#000000');
      let cx = innerLeft;
      for (let i = 0; i < widths.length; i++) {
        cx += widths[i];
        if (i < widths.length - 1) doc.moveTo(cx, y).lineTo(cx, y + rh).stroke();
      }
      doc.restore();
      doc.font('Helvetica').fontSize(fontSizeRow).fillColor('#111');
      let dx = innerLeft;
      cells.forEach((c, i) => {
        const align = i >= 4 ? 'right' : 'left';
        doc.text(String(c || ''), dx + 2, y + 3, {
          width: widths[i] - 4,
          lineGap: 0.35,
          ellipsis: i === 3,
          align
        });
        dx += widths[i];
      });
      doc.fillColor('#000');
      y += rh;
    };

    drawHeaderRow();

    let lineIdx = 0;
    for (const line of ledgerPack.lines) {
      const docNum = line.enrich?.invoiceNumber || line.enrich?.collectionRef || line.enrich?.orderNumber || '—';
      const typ = refLabel(line.referenceType);
      const desc = String(line.description || line.enrich?.primaryLabel || '—').trim();
      const debit = line.type === 'DEBIT' ? fmtMoney(line.amount) : '';
      const credit = line.type === 'CREDIT' ? fmtMoney(line.amount) : '';
      const bal = line.runningBalance != null ? fmtMoney(line.runningBalance) : '';
      const cells = [fmtTs(line.date, zone), String(docNum), typ, desc, debit, credit, bal];
      drawDataRow(cells, lineIdx % 2 === 1);
      lineIdx += 1;
    }

    y += 10;
    newPageIfNeeded(56);
    doc.font('Helvetica').fontSize(8);
    doc.text('SIGNATURE: _____________________________    DATE: ______________', innerLeft, y, { width: innerW });
    y += 12;
    doc.text('REMARKS: ________________________________________________________________', innerLeft, y, { width: innerW });
    y += 14;
    doc.font('Helvetica').fontSize(6.8).fillColor('#444');
    doc.text(
      `EXPORT CAP 5,000 LINES. GENERATED ${businessTime.utcNowIso()}. KEY FIGURES AND AGING REFLECT LIVE DATA; TABLE RESPECTS FILTERS.`,
      innerLeft,
      y,
      { width: innerW, align: 'justify' }
    );
    doc.fillColor('#000');
    doc.end();
  });
};

module.exports = { buildPdfBuffer, REF_LABEL };
