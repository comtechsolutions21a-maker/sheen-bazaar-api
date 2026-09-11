const User = require('../models/User');
const { buildCartResponse } = require('../routes/cart');
const { sendMail } = require('./mailer');

const SITE_URL = process.env.CLIENT_ORIGIN?.split(',')[0] || 'https://sheenbazaar.online';

const REMIND_AFTER_MS = 2 * 60 * 60 * 1000; // remind once a cart has sat untouched for 2 hours
const DONT_REPEAT_WITHIN_MS = 24 * 60 * 60 * 1000; // never email the same person more than once a day

// Finds users with a non-empty cart that's gone quiet, and hasn't already
// gotten a reminder recently, and emails each one a summary + link to /cart.
async function sendAbandonedCartReminders() {
  const staleCutoff = new Date(Date.now() - REMIND_AFTER_MS);
  const repeatCutoff = new Date(Date.now() - DONT_REPEAT_WITHIN_MS);

  const candidates = await User.find({
    cartUpdatedAt: { $ne: null, $lte: staleCutoff },
    $or: [{ lastAbandonedCartEmailAt: null }, { lastAbandonedCartEmailAt: { $lte: repeatCutoff } }],
  });

  for (const user of candidates) {
    try {
      if (!user.cart || user.cart.size === 0) continue; // shouldn't happen, but be defensive
      const cart = await buildCartResponse(user);
      if (!cart.items.length) continue;

      const itemLines = cart.items.slice(0, 5).map((i) => `- ${i.product.name} x${i.qty}`).join('\n');
      const moreCount = cart.items.length > 5 ? cart.items.length - 5 : 0;

      await sendMail({
        to: user.email,
        subject: `You left something in your cart, ${user.name.split(' ')[0]}!`,
        text: `You still have ${cart.count} item(s) waiting in your Sheen Bazaar cart:\n\n${itemLines}${moreCount ? `\n...and ${moreCount} more` : ''}\n\nTotal: ₹${cart.total}\n\nComplete your order: ${SITE_URL}/cart`,
        html: `<p>You still have <strong>${cart.count} item(s)</strong> waiting in your Sheen Bazaar cart.</p><p>Total: <strong>₹${cart.total}</strong></p><p><a href="${SITE_URL}/cart">Complete your order →</a></p>`,
      });

      user.lastAbandonedCartEmailAt = new Date();
      await user.save();
    } catch (err) {
      console.error(`Abandoned cart email failed for ${user.email}:`, err.message);
    }
  }
}

// Starts the recurring check. Runs every 30 minutes; the query itself only
// ever matches carts that are actually stale, so frequent checks are cheap
// and just mean reminders go out promptly once a cart qualifies.
function startAbandonedCartJob() {
  const THIRTY_MIN = 30 * 60 * 1000;
  setInterval(() => {
    sendAbandonedCartReminders().catch((err) => console.error('Abandoned cart job failed:', err.message));
  }, THIRTY_MIN);
}

module.exports = { startAbandonedCartJob, sendAbandonedCartReminders };
