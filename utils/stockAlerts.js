const { sendLater, templates } = require('./mailer');


// Call this right after saving a product whose stock just went from 0 to
// something positive. Emails everyone on its waitlist and clears it — fire
// and forget, since a failed notification email shouldn't block the stock
// update itself.
async function notifyBackInStock(product) {
  if (!product.stockAlerts || product.stockAlerts.length === 0) return;

  const subscribers = [...product.stockAlerts];
  product.stockAlerts = [];
  await product.save();

  const mail = templates.backInStock(product);
  for (const sub of subscribers) sendLater({ to: sub.email, ...mail });
}

module.exports = { notifyBackInStock };
