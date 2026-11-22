// Sends phone/browser notifications to a user's subscribed devices.
// Keys are created automatically the first time and saved in Settings,
// so there's nothing to configure on Render.
const Settings = require('../models/Settings');
const PushSubscription = require('../models/PushSubscription');
const { generateVapidKeys, sendNotification } = require('./webpush');

let cached = null;
async function getVapid() {
  if (cached) return cached;
  const settings = await Settings.get();
  if (!settings.vapidPublicKey || !settings.vapidPrivateKey) {
    const keys = generateVapidKeys();
    settings.vapidPublicKey = keys.publicKey;
    settings.vapidPrivateKey = keys.privateKey;
    await settings.save();
  }
  cached = {
    publicKey: settings.vapidPublicKey,
    privateKey: settings.vapidPrivateKey,
    subject: `mailto:${process.env.SUPPORT_EMAIL || 'support@sheenbazaar.online'}`,
  };
  return cached;
}

// payload: { title, body, url, tag }
async function pushToUser(userId, payload) {
  try {
    const subs = await PushSubscription.find({ user: userId });
    if (!subs.length) return { sent: 0 };
    const vapid = await getVapid();
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        const r = await sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, vapid);
        if (r.ok) sent++;
        else if (r.gone) await PushSubscription.deleteOne({ _id: s._id }); // device unsubscribed
        else console.error(`Push failed (${r.status}) for user ${userId}`);
      } catch (err) {
        console.error('Push error:', err.message);
      }
    }));
    return { sent };
  } catch (err) {
    console.error('pushToUser failed:', err.message);
    return { sent: 0 };
  }
}

function pushLater(userId, payload) {
  setImmediate(() => { pushToUser(userId, payload).catch(() => {}); });
}

module.exports = { getVapid, pushToUser, pushLater };
