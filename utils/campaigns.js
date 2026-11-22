// Admin push campaigns: resolve the audience, send, and run scheduled ones.
const User = require('../models/User');
const Order = require('../models/Order');
const Campaign = require('../models/Campaign');
const PushSubscription = require('../models/PushSubscription');
const { notifyMany } = require('./notify');

const AUDIENCES = {
  all: 'Everyone (customers, sellers & guests with notifications on)',
  customers: 'All customers',
  sellers: 'All sellers',
  cart: 'People with items left in their cart',
  wishlist: 'People with a wishlist',
  inactive: 'Customers with no order in the last 30 days',
  guests: 'Visitors without an account (notifications on)',
};

async function audienceUserIds(audience) {
  switch (audience) {
    case 'all': return (await User.find({ role: { $ne: 'admin' } }).select('_id')).map((u) => u._id);
    case 'customers': return (await User.find({ role: 'customer' }).select('_id')).map((u) => u._id);
    case 'sellers': return (await User.find({ role: 'seller' }).select('_id')).map((u) => u._id);
    case 'cart': {
      const users = await User.find({ cartUpdatedAt: { $ne: null } }).select('_id cart');
      return users.filter((u) => u.cart && u.cart.size > 0).map((u) => u._id);
    }
    case 'wishlist': return (await User.find({ 'wishlist.0': { $exists: true } }).select('_id')).map((u) => u._id);
    case 'inactive': {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recent = new Set((await Order.distinct('user', { createdAt: { $gte: since } })).map(String));
      return (await User.find({ role: 'customer' }).select('_id')).map((u) => u._id).filter((id) => !recent.has(String(id)));
    }
    case 'guests': return [];
    default: return [];
  }
}

// How many people / phones a campaign would reach — shown in the admin form
async function audienceCounts() {
  const out = {};
  for (const key of Object.keys(AUDIENCES)) {
    const ids = await audienceUserIds(key);
    const includeGuests = key === 'all' || key === 'guests';
    const phones = await PushSubscription.countDocuments(includeGuests ? { $or: [{ user: { $in: ids } }, { user: null }] } : { user: { $in: ids } });
    out[key] = { label: AUDIENCES[key], people: ids.length, phones };
  }
  return out;
}

async function runCampaign(c) {
  // Claim it so two job runs can never send the same campaign twice
  const claimed = await Campaign.findOneAndUpdate({ _id: c._id, status: 'scheduled' }, { $set: { status: 'sending' } }, { new: true });
  if (!claimed) return null;
  try {
    const ids = await audienceUserIds(claimed.audience);
    const includeGuests = claimed.audience === 'all' || claimed.audience === 'guests';
    const r = await notifyMany(ids, {
      title: claimed.title, body: claimed.body, url: claimed.url || '/offers',
      image: /^https?:\/\//.test(claimed.image) ? claimed.image : '', type: 'offer', tag: `campaign-${claimed._id}`,
    }, { includeGuests });
    claimed.status = 'sent'; claimed.recipients = r.recipients; claimed.delivered = r.delivered; claimed.sentAt = new Date();
    await claimed.save();
    console.log(`[CAMPAIGN] "${claimed.title}" → ${r.recipients} people, ${r.delivered} phones`);
    return claimed;
  } catch (err) {
    claimed.status = 'failed'; claimed.error = err.message; await claimed.save();
    console.error('Campaign failed:', err.message);
    return claimed;
  }
}

async function runDueCampaigns() {
  const due = await Campaign.find({ status: 'scheduled', $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date() } }] }).limit(5);
  for (const c of due) await runCampaign(c);
}

// Checks every minute. (On Render's free plan the server sleeps when nobody
// visits; a scheduled campaign then goes out as soon as the server wakes up.)
function startCampaignJob() {
  setInterval(() => { runDueCampaigns().catch((e) => console.error('Campaign job:', e.message)); }, 60 * 1000);
  setTimeout(() => runDueCampaigns().catch(() => {}), 10 * 1000);
}

module.exports = { AUDIENCES, audienceCounts, runCampaign, runDueCampaigns, startCampaignJob };
