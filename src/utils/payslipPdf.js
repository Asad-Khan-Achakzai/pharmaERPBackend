const PDFDocument = require('pdfkit');

const fmtMoney = (n) => {
  const x = Number(n) || 0;
  return x.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * @param {object} opts
 * @param {import('stream').Writable} opts.stream
 * @param {string} opts.companyName
 * @param {object} opts.payroll - Mongoose doc or plain object
 * @param {{ name: string, role?: string }} opts.employee
 */
function generatePayslipPdf({ stream, companyName, payroll, employee }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(stream);

  const month = payroll.month || '';
  const allowanceSum = (payroll.allowanceLines || []).reduce((s, l) => s + (l.amount || 0), 0);
  const otherDeductions = (payroll.deductionLines || []).reduce((s, l) => s + (l.amount || 0), 0);
  const commissionAmt = payroll.commission?.amount || 0;
  const attDed = payroll.attendanceDeduction || 0;

  doc.fontSize(18).text(companyName || 'Company', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(12).text('Payslip', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#333');
  doc.text(`Period: ${month}`, { align: 'center' });
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(11).text(`Employee: ${employee?.name || '—'}`);
  if (employee?.role) doc.text(`Role: ${employee.role}`);
  doc.moveDown(1);

  const section = (title) => {
    doc.fontSize(11).fillColor('#1a237e').text(title);
    doc.moveDown(0.3).fillColor('#000').fontSize(10);
  };

  section('Earnings');
  doc.text(`Basic Salary:                    PKR ${fmtMoney(payroll.baseSalary)}`);
  doc.text(`Daily Allowance:                 PKR ${fmtMoney(payroll.dailyAllowanceTotal || 0)}`);
  doc.text(`Allowances (total):              PKR ${fmtMoney(allowanceSum)}`);
  doc.text(`Commission:                      PKR ${fmtMoney(commissionAmt)}`);
  doc.moveDown(0.8);

  section('Deductions');
  doc.text(`Attendance deduction:            PKR ${fmtMoney(attDed)}`);
  doc.text(`Other deductions:                PKR ${fmtMoney(otherDeductions)}`);
  doc.moveDown(0.8);

  section('Summary');
  const gross = payroll.grossSalary ?? 0;
  const totalDed = otherDeductions + attDed;
  const net = payroll.netSalary ?? 0;
  doc.fontSize(10).text(`Gross salary:                    PKR ${fmtMoney(gross)}`);
  doc.text(`Total deductions:                PKR ${fmtMoney(totalDed)}`);
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#0d47a1').text(`Net salary:                      PKR ${fmtMoney(net)}`, {
    continued: false
  });
  doc.fillColor('#000');
  doc.moveDown(1.2);

  doc.fontSize(9).fillColor('#555');
  doc.text(`Payment status: ${payroll.status || '—'}`);
  if (payroll.paidOn) doc.text(`Paid on: ${new Date(payroll.paidOn).toLocaleDateString('en-GB')}`);
  doc.moveDown(0.5);
  doc.text('System generated payslip.', { align: 'center' });

  doc.end();
}

module.exports = { generatePayslipPdf };
