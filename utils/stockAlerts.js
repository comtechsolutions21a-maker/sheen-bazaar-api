const { sendMail } = require('./mailer');

const SITE_URL = process.env.CLIENT_ORIGIN?.split(',')[0] || 'https://sheenbazaar.online';

// Call this right after saving a product whose stock just went from 0 to
// something positive. Emails everyone on its waitlist and clears it — fire
// and forget, since a failed notification email shouldn't block the stock
// update itself.
async function notifyBackInStock(product) {
  if (!product.stockAlerts || product.stockAlerts.length === 0) return;

  const subscribers = [...product.stockAlerts];
  product.stockAlerts = [];
  await product.save();

  const link = `${SITE_URL}/products/${product.id}`;
  for (const sub of subscribers) {
    sendMail({
      to: sub.email,
      subject: `Back in stock: ${product.name}`,
      text: `Good news — ${product.name} is back in stock on Sheen Bazaar!\n\nGrab it before it sells out again: ${link}`,
      html: `<p>Good news — <strong>${product.name}</strong> is back in stock on Sheen Bazaar!</p><p><a href="${link}">Grab it before it sells out again →</a></p>`,
    }).catch((err) => console.error('Back-in-stock email failed:', err.message));
  }
}

module.exports = { notifyBackInStock };
