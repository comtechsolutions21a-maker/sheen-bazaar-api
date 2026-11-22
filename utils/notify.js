// One place to notify a customer: saves it in their in-app inbox AND sends a
// phone notification (if they turned them on). The unread count goes with the
// push so the app icon can show a number badge.
const UserNotification = require('../models/UserNotification');
const PushSubscription = require('../models/PushSubscription');
const { getVapid } = require('./push');
const { sendNotification } = require('./webpush');

async function deliver(subs, payload) {
  if (!subs.length) return 0;
  const vapid = await getVapid();
  let ok = 0;
  // Send in small batches so a big campaign doesn't open thousands of connections at once
  for (let i = 0; i < subs.length; i += 25) {
    await Promise.all(subs.slice(i, i + 25).map(async (s) => {
      try {
        const r = await sendNotification({ endpoint: s.endpoint, keys: s.keys }, typeof payload === 'function' ? payload(s) : payload, vapid);
        if (r.ok) ok++;
        else if (r.gone) await PushSubscription.deleteOne({ _id: s._id });
      } catch (err) { console.error('push error:', err.message); }
    }));
  }
  return ok;
}

// data: { title, body, url, type, image, tag }
async function notifyUser(userId, data, { inbox = true, push = true } = {}) {
  try {
    if (!userId) return { delivered: 0 };
    if (inbox) await UserNotification.create({ user: userId, title: data.title, body: data.body || '', url: data.url || '/', type: data.type || 'system', image: data.image || '' });
    if (!push) return { delivered: 0 };
    const [subs, unread] = await Promise.all([
      PushSubscription.find({ user: userId }),
      UserNotification.countDocuments({ user: userId, read: false }),
    ]);
    const delivered = await deliver(subs, { title: data.title, body: data.body, url: data.url || '/', tag: data.tag, image: data.image || undefined, badge: unread });
    return { delivered };
  } catch (err) {
    console.error('notifyUser failed:', err.message);
    return { delivered: 0 };
  }
}

function notifyLater(userId, data, opts) {
  setImmediate(() => { notifyUser(userId, data, opts).catch(() => {}); });
}

// Many users at once (campaigns, price drops). Guests (no account) get the push only.
async function notifyMany(userIds, data, { includeGuests = false } = {}) {
  const ids = [...new Set((userIds || []).map(String))];
  if (ids.length) {
    const docs = ids.map((u) => ({ user: u, title: data.title, body: data.body || '', url: data.url || '/', type: data.type || 'offer', image: data.image || '' }));
    for (let i = 0; i < docs.length; i += 500) await UserNotification.insertMany(docs.slice(i, i + 500), { ordered: false }).catch(() => {});
  }
  const filter = includeGuests ? { $or: [{ user: { $in: ids } }, { user: null }] } : { user: { $in: ids } };
  const subs = await PushSubscription.find(filter);
  const delivered = await deliver(subs, { title: data.title, body: data.body, url: data.url || '/', tag: data.tag, image: data.image || undefined });
  return { recipients: ids.length + (includeGuests ? subs.filter((s) => !s.user).length : 0), delivered };
}

module.exports = { notifyUser, notifyLater, notifyMany, deliver };
