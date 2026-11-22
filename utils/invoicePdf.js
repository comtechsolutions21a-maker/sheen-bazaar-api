// ─────────────────────────────────────────────────────────────────────────────
// GST-ready PDF invoice — built with plain Node (no extra npm packages).
// Uses the built-in PDF fonts Helvetica / Helvetica-Bold, so the rupee sign is
// written as "Rs." (the ₹ glyph isn't in the standard PDF fonts).
// ─────────────────────────────────────────────────────────────────────────────

// Glyph widths (per 1000 units) for ASCII 32..126
const WIDTHS = {"Helvetica":[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],"Helvetica-Bold":[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]};

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const M = 40;          // margin

function clean(s) {
  // Keep printable Latin characters. Emoji are dropped; other scripts
  // (e.g. Devanagari) become "?" because the built-in PDF fonts can't draw them.
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/₹/g, 'Rs.')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, '')
    .replace(/[^\x20-\x7E]/g, '?').replace(/\?{2,}/g, '?')
    .replace(/\s{2,}/g, ' ').trim();
}
function esc(s) { return clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function textWidth(s, size, bold) {
  const w = WIDTHS[bold ? 'Helvetica-Bold' : 'Helvetica'];
  let t = 0;
  for (const ch of clean(s)) t += w[ch.charCodeAt(0) - 32] || 556;
  return (t * size) / 1000;
}
function fit(s, size, bold, maxW) {
  s = clean(s);
  if (textWidth(s, size, bold) <= maxW) return s;
  while (s.length > 1 && textWidth(s + '...', size, bold) > maxW) s = s.slice(0, -1);
  return s + '...';
}
function wrap(s, size, bold, maxW, maxLines = 3) {
  const words = clean(s).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (textWidth(test, size, bold) <= maxW) cur = test;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = fit(lines[maxLines - 1] + ' ...', size, bold, maxW); }
  return lines.map(l => fit(l, size, bold, maxW));
}

const money = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Indian-system amount in words: 1,23,456.50 → "One Lakh Twenty Three Thousand ..."
function amountInWords(amount) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : ''));
  const three = (n) => (n >= 100 ? a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n));
  let rupees = Math.floor(amount); const paise = Math.round((amount - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(three(crore) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thousand) parts.push(two(thousand) + ' Thousand');
  if (rupees) parts.push(three(rupees));
  let out = (parts.join(' ') || 'Zero') + ' Rupees';
  if (paise) out += ' and ' + two(paise) + ' Paise';
  return out + ' Only';
}

// Tiny drawing helper that collects PDF operators per page
class Canvas {
  constructor() { this.pages = [[]]; }
  get ops() { return this.pages[this.pages.length - 1]; }
  newPage() { this.pages.push([]); }
  rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(' '); }
  rect(x, y, w, h, fill) { this.ops.push(`${this.rgb(fill)} rg ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  line(x1, y1, x2, y2, color = '#E5D5DD', width = 0.7) { this.ops.push(`${this.rgb(color)} RG ${width} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`); }
  text(s, x, y, { size = 10, bold = false, color = '#1A0A12', align = 'left' } = {}) {
    let tx = x;
    if (align === 'right') tx = x - textWidth(s, size, bold);
    if (align === 'center') tx = x - textWidth(s, size, bold) / 2;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${this.rgb(color)} rg ${tx.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
  }
}

function buildPdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalogId = add(null); const pagesId = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function invoiceNumber(order) {
  const d = new Date(order.createdAt || Date.now());
  return `SB-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-${String(order._id).slice(-6).toUpperCase()}`;
}

// order: Order document; settings: Settings document (site name, GST etc.)
function generateInvoicePdf(order, settings = {}) {
  const c = new Canvas();
  const gstOn = !!settings.gstEnabled;
  const gstRate = Number(settings.gstPercent) || 18;
  const site = settings.siteName || 'Sheen Bazaar';
  const a = order.address || {};
  const BRAND = '#E91E8C';

  // Header band
  c.rect(0, 0, PAGE_W, 86, '#1A0A12');
  c.rect(0, 86, PAGE_W, 4, BRAND);
  c.text(site, M, 42, { size: 22, bold: true, color: '#FFFFFF' });
  const sub = [settings.supportEmail, settings.supportPhone].filter(Boolean).join('  |  ') || 'sheenbazaar.online';
  c.text(sub, M, 62, { size: 9, color: '#F3C6DD' });
  c.text(gstOn ? 'TAX INVOICE' : 'INVOICE', PAGE_W - M, 42, { size: 18, bold: true, color: '#FFFFFF', align: 'right' });
  c.text(order.paymentStatus === 'paid' ? 'PAID' : (order.paymentMethod === 'COD' ? 'CASH ON DELIVERY' : 'PAYMENT PENDING'), PAGE_W - M, 62, { size: 9, bold: true, color: order.paymentStatus === 'paid' ? '#86EFAC' : '#FDE68A', align: 'right' });

  // Meta + addresses
  let y = 118;
  const col2 = PAGE_W / 2 + 10;
  c.text('SOLD BY', M, y, { size: 8, bold: true, color: '#8A7A87' });
  c.text('BILL / SHIP TO', col2, y, { size: 8, bold: true, color: '#8A7A87' });
  y += 15;
  c.text(site, M, y, { size: 11, bold: true });
  c.text(fit(a.fullName || '-', 11, true, PAGE_W / 2 - M - 10), col2, y, { size: 11, bold: true });
  y += 14;
  const sellerLines = [
    ...wrap(settings.address || '', 9, false, PAGE_W / 2 - M - 20, 2),
    gstOn && settings.gstin ? `GSTIN: ${settings.gstin}` : '',
  ].filter(Boolean);
  const buyerLines = [
    ...wrap([a.addressLine, a.city, a.state].filter(Boolean).join(', '), 9, false, PAGE_W / 2 - M - 10, 3),
    a.pincode ? `PIN: ${a.pincode}` : '', a.phone ? `Phone: ${a.phone}` : '',
  ].filter(Boolean);
  const n = Math.max(sellerLines.length, buyerLines.length);
  for (let i = 0; i < n; i++) {
    if (sellerLines[i]) c.text(sellerLines[i], M, y, { size: 9, color: '#4A2040' });
    if (buyerLines[i]) c.text(buyerLines[i], col2, y, { size: 9, color: '#4A2040' });
    y += 12;
  }

  y += 10;
  c.rect(M, y, PAGE_W - 2 * M, 44, '#FFF6F2');
  const meta = [
    ['Invoice No.', invoiceNumber(order)],
    ['Invoice Date', new Date(order.createdAt || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })],
    ['Order ID', '#' + String(order._id).slice(-8).toUpperCase()],
    ['Payment', clean(order.paymentMethod || '-')],
  ];
  const mw = (PAGE_W - 2 * M) / 4;
  meta.forEach(([k, v], i) => {
    c.text(k, M + 10 + i * mw, y + 17, { size: 7.5, bold: true, color: '#8A7A87' });
    c.text(fit(v, 10, true, mw - 14), M + 10 + i * mw, y + 32, { size: 10, bold: true });
  });
  y += 64;

  // Items table
  const X = { no: M + 8, item: M + 32, qty: PAGE_W - M - 190, rate: PAGE_W - M - 100, amt: PAGE_W - M - 8 };
  const header = () => {
    c.rect(M, y, PAGE_W - 2 * M, 24, BRAND);
    c.text('#', X.no, y + 16, { size: 9, bold: true, color: '#FFFFFF' });
    c.text('Item', X.item, y + 16, { size: 9, bold: true, color: '#FFFFFF' });
    c.text('Qty', X.qty, y + 16, { size: 9, bold: true, color: '#FFFFFF', align: 'right' });
    c.text('Rate', X.rate, y + 16, { size: 9, bold: true, color: '#FFFFFF', align: 'right' });
    c.text('Amount', X.amt, y + 16, { size: 9, bold: true, color: '#FFFFFF', align: 'right' });
    y += 24;
  };
  header();
  (order.items || []).forEach((it, i) => {
    const name = it.name + (it.variant ? ` (${it.variant})` : '');
    const lines = wrap(name, 9.5, false, X.qty - X.item - 50, 2);
    const h = 10 + lines.length * 12;
    if (y + h > PAGE_H - 200) { c.newPage(); y = M; header(); }
    if (i % 2 === 1) c.rect(M, y, PAGE_W - 2 * M, h, '#FCF7FA');
    c.text(String(i + 1), X.no, y + 15, { size: 9.5, color: '#8A7A87' });
    lines.forEach((l, j) => c.text(l, X.item, y + 15 + j * 12, { size: 9.5 }));
    c.text(String(it.qty), X.qty, y + 15, { size: 9.5, align: 'right' });
    c.text(money(it.price), X.rate, y + 15, { size: 9.5, align: 'right' });
    c.text(money(it.price * it.qty), X.amt, y + 15, { size: 9.5, bold: true, align: 'right' });
    y += h;
    c.line(M, y, PAGE_W - M, y);
  });

  // Totals
  if (y > PAGE_H - 230) { c.newPage(); y = M; }
  y += 16;
  const tx = PAGE_W - M - 8; const lx = PAGE_W - M - 220;
  const row = (label, value, opts = {}) => {
    c.text(label, lx, y, { size: opts.size || 9.5, bold: !!opts.bold, color: opts.color || '#4A2040' });
    c.text(value, tx, y, { size: opts.size || 9.5, bold: !!opts.bold, color: opts.color || '#1A0A12', align: 'right' });
    y += opts.gap || 15;
  };
  row('Items total', money(order.itemsTotal));
  row('Delivery', order.deliveryFee ? money(order.deliveryFee) : 'FREE');
  if (order.discount) row(`Discount${order.couponCode ? ` (${order.couponCode})` : ''}`, '- ' + money(order.discount), { color: '#15803D' });
  if (gstOn) {
    const base = order.total / (1 + gstRate / 100);
    const gst = order.total - base;
    row(`Taxable value`, money(base));
    row(`CGST @ ${(gstRate / 2).toFixed(1)}%`, money(gst / 2));
    row(`SGST @ ${(gstRate / 2).toFixed(1)}%`, money(gst / 2));
  }
  y += 2;
  c.rect(lx - 10, y - 4, tx - lx + 18, 30, '#1A0A12');
  c.text('Grand Total', lx, y + 15, { size: 11, bold: true, color: '#FFFFFF' });
  c.text(money(order.total), tx, y + 15, { size: 12, bold: true, color: '#FFFFFF', align: 'right' });
  y += 44;
  c.text('Amount in words:', M, y, { size: 8.5, bold: true, color: '#8A7A87' });
  wrap(amountInWords(order.total), 9, false, PAGE_W - 2 * M - 90, 2).forEach((l, i) => c.text(l, M + 80, y + i * 12, { size: 9 }));
  y += 30;
  if (gstOn) c.text('Prices are inclusive of GST.', M, y, { size: 8.5, color: '#8A7A87' });

  // Footer on every page
  c.pages.forEach((ops, i) => {
    c.pages[i] = ops;
    const cur = c.pages.length; void cur;
  });
  c.pages.forEach((_, i) => {
    const saved = c.pages; c.pages = [saved[i]];
    c.line(M, PAGE_H - 56, PAGE_W - M, PAGE_H - 56);
    c.text(gstOn ? 'This is a computer-generated tax invoice and does not require a signature.' : 'This is a computer-generated invoice and does not require a signature.', PAGE_W / 2, PAGE_H - 40, { size: 8, color: '#8A7A87', align: 'center' });
    c.text(`Thank you for shopping with ${site}!   Page ${i + 1} of ${saved.length}`, PAGE_W / 2, PAGE_H - 28, { size: 8, color: BRAND, align: 'center', bold: true });
    saved[i] = c.pages[0]; c.pages = saved;
  });

  return buildPdf(c.pages);
}

module.exports = { generateInvoicePdf, invoiceNumber, amountInWords };
