// ─────────────────────────────────────────────────────────────────────────────
// Sheen Bazaar — central no-reply mailer
//
// Every email the site sends goes through sendMail() here, so they all share:
//   • the same "From: Sheen Bazaar <no-reply@…>" sender (SMTP_FROM)
//   • Reply-To pointing at your real support inbox (SUPPORT_EMAIL), so if a
//     customer does hit "Reply" it reaches a person instead of bouncing
//   • the same branded pink Sheen Bazaar layout + plain-text fallback
//   • "auto-generated" headers so mail apps don't send out-of-office loops
//
// How it sends (first one that's configured wins):
//   1. BREVO_API_KEY  → Brevo's HTTPS API   (free 300 emails/day)
//   2. RESEND_API_KEY → Resend's HTTPS API  (free 3,000 emails/month)
//   3. SMTP_*         → any SMTP server (domain email, Zoho, Gmail…)
// ⚠️ Render's FREE plan blocks SMTP ports 25/465/587, so on free Render use
// option 1 or 2 — they go over normal HTTPS (port 443), which isn't blocked.
// If nothing is set, emails are printed to the server log instead.
// ─────────────────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

let transporter;
let checkedEnv = false;

const BRAND = '#E91E8C';
const BRAND_DARK = '#B5006E';
const INK = '#1A0A12';
const MUTED = '#8A7A87';

function siteUrl() {
  return (process.env.CLIENT_ORIGIN || 'https://sheenbazaar.online').split(',')[0].trim().replace(/\/$/, '');
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || (process.env.SMTP_USER ? `Sheen Bazaar <${process.env.SMTP_USER}>` : 'Sheen Bazaar <no-reply@sheenbazaar.online>');
}

// "Sheen Bazaar <no-reply@x.com>" → { name: 'Sheen Bazaar', email: 'no-reply@x.com' }
function parseAddress(a) {
  const m = String(a).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || 'Sheen Bazaar', email: m[2].trim() } : { name: 'Sheen Bazaar', email: String(a).trim() };
}

function provider() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (getTransporter()) return 'smtp';
  return null;
}

async function postJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.message || d.error?.message || d.name || `HTTP ${r.status}`);
    }
    return true;
  } finally { clearTimeout(timer); }
}

function getTransporter() {
  if (checkedEnv) return transporter;
  checkedEnv = true;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return transporter;
  }

  const port = Number(SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000, // don't hang a request for minutes if the port is blocked
    greetingTimeout: 10000,
    pool: true,          // reuse one connection for bulk mails (broadcasts)
    maxConnections: 3,
    maxMessages: 100,
  });
  return transporter;
}

function isConfigured() {
  return !!provider();
}

// Accounts made from a phone number / X login get a placeholder address like
// 9876543210@phone.sheenbazaar.com — those inboxes don't exist, so skip them
// instead of sending mail that bounces (bounces hurt your sender reputation).
function isRealEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  return !/@(phone|twitter|x|facebook)\.sheenbazaar\.com$/.test(e);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Turns plain text typed by an admin into safe HTML paragraphs.
function textToHtml(s) {
  return escapeHtml(s).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(title|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<\/td>\s*<td[^>]*>/gi, '  ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function button(label, href) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0"><tr><td style="border-radius:50px;background:linear-gradient(135deg,${BRAND},${BRAND_DARK});background-color:${BRAND}">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;color:#fff;font-weight:700;font-size:15px;text-decoration:none;border-radius:50px">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

// The shared branded wrapper every email uses.
function layout({ title, preheader = '', body }) {
  const year = new Date().getFullYear();
  const support = process.env.SUPPORT_EMAIL;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#FFF6F2;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:${INK}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FFF6F2;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 6px 24px rgba(185,0,110,0.08)">
      <tr><td style="background:linear-gradient(135deg,${INK},#6B0F45);background-color:${INK};padding:22px 28px">
        <a href="${siteUrl()}" style="color:#fff;text-decoration:none;font-size:22px;font-weight:800;letter-spacing:.3px">🛍️ Sheen Bazaar</a>
      </td></tr>
      <tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.6">
        <h1 style="margin:0 0 16px;font-size:21px;color:${INK}">${escapeHtml(title)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:18px 28px 26px;border-top:1px solid #F3E6EC;font-size:12px;color:${MUTED};line-height:1.6">
        This is an automated message from Sheen Bazaar — please don't reply to this email.
        ${support ? `Need help? Write to <a href="mailto:${escapeHtml(support)}" style="color:${BRAND}">${escapeHtml(support)}</a> or visit our <a href="${siteUrl()}/help" style="color:${BRAND}">Help Center</a>.` : `Need help? Visit our <a href="${siteUrl()}/help" style="color:${BRAND}">Help Center</a>.`}
        <br>© ${year} Sheen Bazaar
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// Sends one email. Never throws — returns { sent, simulated, error }.
async function sendMail({ to, subject, text, html, replyTo }) {
  if (!isRealEmail(to)) return { sent: false, skipped: true };

  const plain = text || htmlToText(html);
  const via = provider();

  if (!via) {
    console.log(`\n📧 [email not configured — set BREVO_API_KEY (or RESEND_API_KEY / SMTP_*) to send for real]\nTo: ${to}\nSubject: ${subject}\n${plain}\n`);
    return { sent: false, simulated: true };
  }

  const from = fromAddress();
  const reply = replyTo || process.env.SUPPORT_EMAIL || '';
  const headers = { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' };

  try {
    if (via === 'brevo') {
      await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': process.env.BREVO_API_KEY }, {
        sender: parseAddress(from),
        to: [{ email: to }],
        subject, htmlContent: html || `<pre>${escapeHtml(plain)}</pre>`, textContent: plain,
        ...(reply ? { replyTo: { email: reply } } : {}),
        headers,
      });
    } else if (via === 'resend') {
      await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, {
        from, to: [to], subject, html, text: plain,
        ...(reply ? { reply_to: reply } : {}),
        headers,
      });
    } else {
      await getTransporter().sendMail({ from, to, subject, text: plain, html, replyTo: reply || undefined, headers });
    }
    return { sent: true, simulated: false };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timed out' : err.message;
    const hint = via === 'smtp' && /timed? ?out|ETIMEDOUT|ECONNREFUSED/i.test(msg)
      ? ' (Render free plan blocks SMTP — use BREVO_API_KEY instead)' : '';
    console.error(`Failed to send email via ${via}:`, msg + hint);
    return { sent: false, simulated: false, error: msg + hint };
  }
}

// Fire-and-forget helper: never blocks or breaks the request that triggered it.
function sendLater(mail) {
  setImmediate(() => { sendMail(mail).catch(() => {}); });
}

// ─── Templates ───────────────────────────────────────────────────────────────
const orderNo = (order) => String(order._id).slice(-6).toUpperCase();
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function itemsTable(items) {
  const rows = items.map(i => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #F3E6EC">${escapeHtml(i.name)} <span style="color:${MUTED}">× ${i.qty}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #F3E6EC;text-align:right;white-space:nowrap">${rupees((i.price || 0) * (i.qty || 1))}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;margin:6px 0 4px">${rows}</table>`;
}

const STATUS_COPY = {
  confirmed:         { emoji: '✅', title: 'Your order is confirmed', line: 'The seller has confirmed your order and is getting it ready.' },
  packed:            { emoji: '📦', title: 'Your order is packed', line: 'Your items are packed and will be handed to the courier soon.' },
  shipped:           { emoji: '🚚', title: 'Your order has shipped', line: 'Your order is on its way.' },
  out_for_delivery:  { emoji: '🛵', title: 'Out for delivery today', line: 'Your order is out for delivery — please keep your phone handy.' },
  delivered:         { emoji: '🎉', title: 'Your order was delivered', line: 'Your order has been delivered. We hope you love it!' },
  cancelled:         { emoji: '❌', title: 'Your order was cancelled', line: 'Your order has been cancelled. If you paid online, the refund goes back to your original payment method.' },
  return_requested:  { emoji: '↩️', title: 'Return request received', line: 'We\'ve received your return request. The seller will review it shortly.' },
  returned:          { emoji: '✔️', title: 'Your return was approved', line: 'Your return has been approved. If you paid online, the refund goes back to your original payment method.' },
  return_rejected:   { emoji: 'ℹ️', title: 'Update on your return request', line: 'The seller was unable to accept the return for this order. Contact support if you need help.' },
};

const templates = {
  welcome(user) {
    const first = escapeHtml((user.name || 'there').split(' ')[0]);
    const isSeller = user.role === 'seller' || user.role === 'reseller';
    const body = `<p>Hi ${first},</p>
      <p>Welcome to <strong>Sheen Bazaar</strong>! Your account is ready.</p>
      ${isSeller
        ? `<p>Your ${user.role} account has been created. Finish your verification in the dashboard so you can start selling.</p>${button('Open my dashboard', `${siteUrl()}/${user.role}`)}`
        : `<p>Discover fashion, electronics and everyday essentials with fast delivery and daily deals.</p>${button('Start shopping', `${siteUrl()}/products`)}`}
      <p style="color:${MUTED};font-size:13px">Your referral code: <strong>${escapeHtml(user.referralCode || '—')}</strong> — share it with friends.</p>`;
    return { subject: 'Welcome to Sheen Bazaar 🛍️', html: layout({ title: 'Welcome aboard!', preheader: 'Your Sheen Bazaar account is ready.', body }) };
  },

  otp(code) {
    const body = `<p>Your one-time login code is:</p>
      <div style="font-size:38px;font-weight:900;letter-spacing:10px;color:${BRAND};text-align:center;padding:18px;background:#FFF6F2;border-radius:12px;margin:14px 0">${escapeHtml(code)}</div>
      <p style="color:${MUTED};font-size:13px">This code expires in 5 minutes. Never share it with anyone — Sheen Bazaar staff will never ask for it.</p>
      <p style="color:${MUTED};font-size:13px">Didn't request this? You can safely ignore this email.</p>`;
    return { subject: `${code} is your Sheen Bazaar login code`, html: layout({ title: 'Your login code', preheader: `Your code is ${code}`, body }) };
  },

  orderPlaced(order, user) {
    const first = escapeHtml((user?.name || 'there').split(' ')[0]);
    const a = order.address || {};
    const addr = [a.fullName, a.addressLine, a.city, a.state, a.pincode].filter(Boolean).map(escapeHtml).join(', ');
    const payLine = order.paymentMethod === 'COD'
      ? `Pay <strong>${rupees(order.total)}</strong> in cash when your order arrives.`
      : `Payment: <strong>${escapeHtml(order.paymentMethod)}</strong> — ${order.paymentStatus === 'paid' ? '<span style="color:#16a34a">Paid</span>' : 'Pending'}`;
    const body = `<p>Hi ${first}, thanks for shopping with us! We've received your order <strong>#${orderNo(order)}</strong>.</p>
      ${itemsTable(order.items || [])}
      <table role="presentation" width="100%" style="font-size:14px;margin-top:6px">
        ${order.deliveryFee ? `<tr><td style="color:${MUTED}">Delivery</td><td style="text-align:right">${rupees(order.deliveryFee)}</td></tr>` : ''}
        ${order.discount ? `<tr><td style="color:${MUTED}">Discount</td><td style="text-align:right;color:#16a34a">−${rupees(order.discount)}</td></tr>` : ''}
        <tr><td style="font-weight:800;padding-top:6px">Total</td><td style="text-align:right;font-weight:800;padding-top:6px">${rupees(order.total)}</td></tr>
      </table>
      <p style="margin-top:16px">${payLine}</p>
      ${addr ? `<p style="color:${MUTED};font-size:13px">Delivering to: ${addr}</p>` : ''}
      ${button('Track my order', `${siteUrl()}/orders/${order._id}`)}`;
    return { subject: `Order #${orderNo(order)} placed — Sheen Bazaar`, html: layout({ title: 'Order placed successfully 🎉', preheader: `Order #${orderNo(order)} • ${rupees(order.total)}`, body }) };
  },

  orderStatus(order, user, status) {
    const c = STATUS_COPY[status];
    if (!c) return null;
    const first = escapeHtml((user?.name || 'there').split(' ')[0]);
    const s = order.shipping || {};
    const tracking = status === 'shipped' && (s.courierPartner || s.trackingNumber)
      ? `<p style="background:#FFF6F2;border-radius:10px;padding:12px 14px;font-size:14px">Courier: <strong>${escapeHtml(s.courierPartner || '—')}</strong>${s.trackingNumber ? `<br>Tracking no.: <strong>${escapeHtml(s.trackingNumber)}</strong>` : ''}</p>` : '';
    const body = `<p>Hi ${first},</p>
      <p>${c.line}</p>
      <p style="color:${MUTED};font-size:13px">Order <strong>#${orderNo(order)}</strong> • ${rupees(order.total)}</p>
      ${tracking}
      ${status === 'delivered' ? `<p>Enjoying your purchase? Leaving a review helps other shoppers.</p>` : ''}
      ${button(status === 'delivered' ? 'View order & review' : 'Track my order', `${siteUrl()}/orders/${order._id}`)}`;
    return { subject: `${c.emoji} ${c.title} — #${orderNo(order)}`, html: layout({ title: `${c.title} ${c.emoji}`, preheader: c.line, body }) };
  },

  sellerNewOrder(order, seller, myItems, myTotal) {
    const name = escapeHtml(seller.businessName || seller.name || 'Seller');
    const items = myItems.map(i => ({ ...i, price: i.basePrice ?? i.price }));
    const body = `<p>Hi ${name},</p>
      <p>You've received a new order <strong>#${orderNo(order)}</strong>:</p>
      ${itemsTable(items)}
      <p style="font-weight:800">Your total: ${rupees(myTotal)}</p>
      <p>Please confirm and pack it as soon as possible.</p>
      ${button('Open seller dashboard', `${siteUrl()}/seller`)}`;
    return { subject: `🛒 New order #${orderNo(order)} on Sheen Bazaar`, html: layout({ title: 'You have a new order', preheader: `${myItems.length} item(s) • ${rupees(myTotal)}`, body }) };
  },

  backInStock(product) {
    const link = `${siteUrl()}/products/${product.id}`;
    const body = `<p>Good news — <strong>${escapeHtml(product.name)}</strong> is back in stock!</p>
      <p>Grab it before it sells out again.</p>${button('Shop now', link)}`;
    return { subject: `Back in stock: ${product.name}`, html: layout({ title: 'It\'s back! 🎉', preheader: `${product.name} is available again`, body }) };
  },

  abandonedCart(user, cart) {
    const first = escapeHtml((user.name || 'there').split(' ')[0]);
    const items = cart.items.slice(0, 5).map(i => ({ name: i.product?.name || 'Item', qty: i.qty, price: i.price ?? i.product?.price ?? 0 }));
    const more = cart.items.length > 5 ? `<p style="color:${MUTED};font-size:13px">…and ${cart.items.length - 5} more</p>` : '';
    const body = `<p>Hi ${first}, you left ${cart.count} item(s) in your cart:</p>
      ${itemsTable(items)}${more}
      <p style="font-weight:800">Total: ${rupees(cart.total)}</p>
      ${button('Complete my order', `${siteUrl()}/cart`)}`;
    return { subject: `You left something in your cart, ${(user.name || '').split(' ')[0] || 'friend'}!`, html: layout({ title: 'Still thinking it over?', preheader: `${cart.count} item(s) waiting • ${rupees(cart.total)}`, body }) };
  },

  // Admin → "Email user" / "Broadcast" — message is plain text typed by admin.
  adminMessage(user, subject, message) {
    const first = escapeHtml((user?.name || 'there').split(' ')[0]);
    const body = `<p>Hi ${first},</p>${textToHtml(message)}`;
    return { subject, html: layout({ title: subject, preheader: String(message).slice(0, 90), body }) };
  },

  test() {
    const body = `<p>If you're reading this, your Sheen Bazaar no-reply email is working. ✅</p>
      <p style="color:${MUTED};font-size:13px">Sent from: ${escapeHtml(fromAddress())}<br>Replies go to: ${escapeHtml(process.env.SUPPORT_EMAIL || '(SUPPORT_EMAIL not set)')}</p>`;
    return { subject: 'Sheen Bazaar test email ✅', html: layout({ title: 'Email is working!', preheader: 'Test email from your store', body }) };
  },
};

// Convenience senders used by routes ─────────────────────────────────────────
async function notifyOrderStatus(order, status) {
  try {
    const User = require('../models/User');
    const user = await User.findById(order.user).select('name email');
    if (!user) return;
    const mail = templates.orderStatus(order, user, status || order.status);
    if (mail) sendLater({ to: user.email, ...mail });
  } catch (err) {
    console.error('notifyOrderStatus failed:', err.message);
  }
}

module.exports = {
  sendMail, sendLater, templates, notifyOrderStatus,
  isConfigured, isRealEmail, fromAddress, escapeHtml, provider,
};
