// Tiny in-memory rate limiter (no extra packages). Good enough for one server
// on Render; limits reset if the server restarts.
const buckets = new Map();

// Returns { ok, retryAfter } — at most `limit` hits per `windowMs` for `key`
function hit(key, limit, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    buckets.set(key, list);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
  }
  list.push(now);
  buckets.set(key, list);
  return { ok: true, retryAfter: 0 };
}

// Clean old keys every 10 minutes so memory stays small
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of buckets) if (!list.length || now - list[list.length - 1] > 3600e3) buckets.delete(k);
}, 600e3).unref?.();

const wait = (s) => (s > 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`);

// Express middleware factory. keyFn(req) → string key (or null to skip)
function limit(name, { max, windowMs, keyFn, message }) {
  return (req, res, next) => {
    const k = keyFn ? keyFn(req) : req.ip;
    if (!k) return next();
    const r = hit(`${name}:${k}`, max, windowMs);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ message: (message || 'Too many tries. Please wait {wait} and try again.').replace('{wait}', wait(r.retryAfter)) });
    }
    next();
  };
}

module.exports = { hit, limit };
