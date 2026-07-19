const nodemailer = require('nodemailer');

let transporter;
let checkedEnv = false;

// Lazily builds a transporter from SMTP_* env vars. Returns null if they
// aren't set, so the app can still run (and log instead of send) in local/dev
// setups that haven't configured mail credentials yet.
function getTransporter() {
  if (checkedEnv) return transporter;
  checkedEnv = true;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Sends an email if SMTP is configured; otherwise prints it to the server
// console so the notification is still visible during development.
async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();

  if (!t) {
    console.log(`\n📧 [email not configured — set SMTP_* in .env to send for real]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return { sent: false, simulated: true };
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    return { sent: true, simulated: false };
  } catch (err) {
    console.error('Failed to send email:', err.message);
    return { sent: false, simulated: false, error: err.message };
  }
}

module.exports = { sendMail };
