// ─────────────────────────────────────────────────────────────────────────────
// Minimal Web Push sender (no extra npm packages needed).
// Implements the two standards every browser push service uses:
//   • RFC 8291 / RFC 8188 — "aes128gcm" message encryption
//   • RFC 8292            — VAPID (identifies Sheen Bazaar as the sender)
// Works on Render's free plan: it's a normal HTTPS request (port 443).
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// New VAPID key pair (P-256). Public key = 65-byte uncompressed point.
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// RFC 8291 encryption. Returns the full request body (header + ciphertext).
// `asKeys` / `salt` can be passed in for testing; normally they're random.
function encryptPayload(payload, p256dh, authSecret, { asKeys, salt } = {}) {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  if (uaPublic.length !== 65) throw new Error('Invalid subscription key');
  if (auth.length !== 16) throw new Error('Invalid subscription auth secret');

  const ecdh = crypto.createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  salt = salt || crypto.randomBytes(16);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(auth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  // CEK / NONCE = HKDF(salt, IKM, ...)
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);

  // Single record: plaintext || 0x02 (last-record delimiter)
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // Header: salt(16) || record size(4) || keyid length(1) || keyid (as_public, 65)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

// VAPID JWT, signed ES256 with the server's private key
function vapidAuthHeader(endpoint, subject, publicKey, privateKey) {
  const pub = fromB64url(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

// Sends one notification. Resolves { ok, status, gone } — gone=true means the
// subscription expired / was revoked and should be deleted.
async function sendNotification(subscription, payload, vapid, { ttl = 86400, urgency = 'normal' } = {}) {
  const { endpoint, keys = {} } = subscription;
  const body = encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload), keys.p256dh, keys.auth);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: vapidAuthHeader(endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
      },
      body,
      signal: ctrl.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateVapidKeys, encryptPayload, vapidAuthHeader, sendNotification, b64url, fromB64url };
