const User = require('../models/User');
const { buildCartResponse } = require('../routes/cart');
const { sendMail, templates, isRealEmail } = require('./mailer');

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

      if (!isRealEmail(user.email)) continue;
      const result = await sendMail({ to: user.email, ...templates.abandonedCart(user, cart) });
      if (!result.sent && !result.simulated) continue; // try again next round

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
