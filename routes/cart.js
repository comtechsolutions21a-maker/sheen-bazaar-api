const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth(true));

// Cart keys are either "<productId>" (bought directly from the supplier) or
// "<productId>:r:<resellerId>" (bought through a reseller's listing, at
// their price). Keeping this in the key -- rather than a separate field --
// means the existing Map<string, qty> cart storage didn't need to change shape.
function parseKey(key) {
  const [productId, tag, resellerId] = key.split(':');
  return { productId: Number(productId), resellerId: tag === 'r' ? resellerId : null };
}
function makeKey(productId, resellerId) {
  return resellerId ? `${productId}:r:${resellerId}` : String(productId);
}

async function buildCartResponse(user) {
  const cartObj = Object.fromEntries(user.cart || []);
  const keys = Object.keys(cartObj);
  const parsed = keys.map((k) => ({ key: k, qty: cartObj[k], ...parseKey(k) }));

  const productIds = [...new Set(parsed.map((p) => p.productId))];
  const products = await Product.find({ id: { $in: productIds } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  const resellerIds = [...new Set(parsed.filter((p) => p.resellerId).map((p) => p.resellerId))];
  const listings = resellerIds.length
    ? await ResellerListing.find({ reseller: { $in: resellerIds }, productId: { $in: productIds } })
    : [];
  const listingMap = new Map(listings.map((l) => [`${l.reseller}:${l.productId}`, l]));

  const items = parsed
    .map((p) => {
      const product = productMap.get(p.productId);
      if (!product) return null;
      let price = product.price;
      let reseller = null;
      if (p.resellerId) {
        const listing = listingMap.get(`${p.resellerId}:${p.productId}`);
        if (!listing || !listing.active) return null; // listing was removed/deactivated
        price = listing.resellPrice;
        reseller = p.resellerId;
      }
      return { product, qty: p.qty, price, reseller, lineTotal: p.qty * price, key: p.key };
    })
    .filter(Boolean);

  const itemsTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const count = items.reduce((sum, i) => sum + i.qty, 0);
  const deliveryFee = itemsTotal >= 499 || itemsTotal === 0 ? 0 : 49;

  return { items, itemsTotal, count, deliveryFee, total: itemsTotal + deliveryFee };
}

// GET /api/cart
router.get('/', async (req, res) => {
  const user = await User.findById(req.userId);
  res.json(await buildCartResponse(user));
});

// POST /api/cart  { productId, delta, resellerId? }  -- delta can be positive or negative.
// Pass resellerId to add the item at that reseller's listed price instead of
// buying directly from the supplier.
router.post('/', async (req, res) => {
  const { productId, delta, resellerId } = req.body;
  if (!productId || !delta) return res.status(400).json({ message: 'productId and delta are required' });

  if (resellerId) {
    const listing = await ResellerListing.findOne({ reseller: resellerId, productId: Number(productId), active: true });
    if (!listing) return res.status(404).json({ message: 'That reseller listing is no longer available' });
  }

  const user = await User.findById(req.userId);
  const key = makeKey(productId, resellerId);
  const current = user.cart.get(key) || 0;
  const next = current + Number(delta);

  if (next <= 0) user.cart.delete(key);
  else user.cart.set(key, next);

  await user.save();
  res.json(await buildCartResponse(user));
});

// DELETE /api/cart/:productId  (optionally ?resellerId= for a reseller-priced line)
router.delete('/:productId', async (req, res) => {
  const user = await User.findById(req.userId);
  user.cart.delete(makeKey(req.params.productId, req.query.resellerId));
  await user.save();
  res.json(await buildCartResponse(user));
});

// DELETE /api/cart  -- clear entire cart
router.delete('/', async (req, res) => {
  const user = await User.findById(req.userId);
  user.cart = new Map();
  await user.save();
  res.json(await buildCartResponse(user));
});

module.exports = router;
