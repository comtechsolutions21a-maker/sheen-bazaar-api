const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const ResellerListing = require('../models/ResellerListing');
const Order = require('../models/Order');
const auth = require('../middleware/auth');
const { generateAiAnswer } = require('../utils/aiAnswer');

const router = express.Router();

// Fields product LIST pages never use. Leaving them out keeps the shop page
// fast now that reviews can carry photos.
const LIST_FIELDS_EXCLUDED = '-reviews -questions -qna -stockAlerts';

// Escape user text before putting it in a regex — otherwise typing "(" or "*"
// in the search box crashed the request with a 500 error.
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/products?cat=Fashion&search=saree&sort=price-low&minPrice=0&maxPrice=600
//   &brand=Nike,Puma&minRating=4&inStock=1&flash=1
// sort: price-low | price-high | rating | popular | discount | newest (default)
router.get('/', async (req, res) => {
  try {
    const { cat, search, sort, minPrice, maxPrice, brand, minRating, inStock, flash } = req.query;
    const filter = { active: true };

    if (cat && cat !== 'All') filter.cat = cat;
    if (search && String(search).trim()) {
      // Every word must match somewhere: name, brand, category, tags or description
      const words = String(search).trim().split(/\s+/).slice(0, 6).map(escapeRegex);
      filter.$and = words.map(w => ({
        $or: [
          { name: { $regex: w, $options: 'i' } },
          { brand: { $regex: w, $options: 'i' } },
          { cat: { $regex: w, $options: 'i' } },
          { tags: { $regex: w, $options: 'i' } },
          { desc: { $regex: w, $options: 'i' } },
        ],
      }));
    }
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }
    if (brand) {
      const brands = String(brand).split(',').map(b => b.trim()).filter(Boolean);
      if (brands.length) filter.brand = { $in: brands.map(b => new RegExp(`^${escapeRegex(b)}$`, 'i')) };
    }
    if (minRating) filter.rating = { $gte: Number(minRating) };
    if (inStock === '1') filter.stock = { $gt: 0 };
    if (flash === '1') { filter.flashPrice = { $gt: 0 }; filter.flashEndsAt = { $gt: new Date() }; }

    let query = Product.find(filter).select(LIST_FIELDS_EXCLUDED);
    if (sort === 'price-low') query = query.sort({ price: 1 });
    else if (sort === 'price-high') query = query.sort({ price: -1 });
    else if (sort === 'rating') query = query.sort({ rating: -1, reviewCount: -1 });
    else if (sort === 'popular') query = query.sort({ reviewCount: -1, rating: -1 });
    // Default: newest-first, so freshly added listings show up on the Home page.
    else query = query.sort({ createdAt: -1 });

    let products = (await query.exec()).map(p => p.toJSON());
    if (sort === 'discount') {
      const off = (p) => (p.old > p.price ? (p.old - p.price) / p.old : 0);
      products.sort((a, b) => off(b) - off(a));
    }
    // Price sorts should follow the price shoppers actually see (flash price)
    if (sort === 'price-low') products.sort((a, b) => a.price - b.price);
    if (sort === 'price-high') products.sort((a, b) => b.price - a.price);
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch products', error: err.message });
  }
});

// GET /api/products/suggest?q=sar — quick suggestions while typing in the search box
router.get('/suggest', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ products: [], categories: [], brands: [] });
    const rx = new RegExp(escapeRegex(q), 'i');
    const starts = new RegExp(`^${escapeRegex(q)}`, 'i');
    const [products, categories, brands] = await Promise.all([
      Product.find({ active: true, $or: [{ name: rx }, { brand: rx }, { tags: rx }] })
        .select('id name icon image images price old flashPrice flashEndsAt cat brand')
        .sort({ reviewCount: -1 }).limit(20),
      Product.distinct('cat', { active: true, cat: rx }),
      Product.distinct('brand', { active: true, brand: rx }),
    ]);
    // Names that START with what was typed come first
    const sorted = products.map(p => p.toJSON()).sort((a, b) => (starts.test(b.name) ? 1 : 0) - (starts.test(a.name) ? 1 : 0)).slice(0, 6)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, image: p.images?.[0] || p.image || '', price: p.price, cat: p.cat }));
    res.json({ products: sorted, categories: categories.slice(0, 3), brands: brands.filter(Boolean).slice(0, 3) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/brands?cat=Fashion — brand list for the filter panel
router.get('/brands', async (req, res) => {
  const filter = { active: true };
  if (req.query.cat && req.query.cat !== 'All') filter.cat = req.query.cat;
  const brands = (await Product.distinct('brand', filter)).filter(b => b && b.trim()).sort((a, b) => a.localeCompare(b));
  res.json(brands);
});

// GET /api/products/categories
router.get('/categories', async (req, res) => {
  const cats = await Product.distinct('cat');
  res.json(cats);
});

// GET /api/products/reseller/:resellerId — a reseller's public storefront:
// their active listings, priced at whatever they set, joined with product info.
router.get('/reseller/:resellerId', async (req, res) => {
  const reseller = await User.findOne({ _id: req.params.resellerId, role: 'reseller' });
  if (!reseller) return res.status(404).json({ message: 'Reseller not found' });

  const listings = await ResellerListing.find({ reseller: reseller._id, active: true });
  // Guard against any listing with a missing/invalid productId (e.g. from
  // older data) — passing a non-numeric value into a Number-typed $in query
  // throws an uncaught assertion in Mongoose that crashes the whole server,
  // not just this request, so we filter defensively before querying.
  const productIds = listings.map((l) => l.productId).filter((id) => Number.isFinite(id));
  const products = await Product.find({ id: { $in: productIds }, active: true }).select(LIST_FIELDS_EXCLUDED);
  const productMap = new Map(products.map((p) => [p.id, p]));

  const items = listings
    .map((l) => {
      const product = productMap.get(l.productId);
      if (!product) return null;
      return { product, resellPrice: l.resellPrice };
    })
    .filter(Boolean);

  res.json({ reseller: { id: reseller._id, name: reseller.name, businessName: reseller.businessName }, items });
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    // stockAlerts holds other shoppers' email addresses — never send it out.
    const product = await Product.findOne({ id: Number(req.params.id), active: true }).select('-stockAlerts');
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product', error: err.message });
  }
});

// GET /api/products/:id/related
router.get('/:id/related', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id), active: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const related = await Product.find({ cat: product.cat, id: { $ne: product.id }, active: true }).select(LIST_FIELDS_EXCLUDED).limit(6);
  res.json(related);
});

// POST /api/products/:id/review — customer leaves (or updates) a review.
// Body: { rating 1-5, comment, images: [dataURL, …] up to 3 }.
// One review per customer per product — posting again replaces their old one.
const MAX_REVIEW_PHOTOS = 3;
const MAX_PHOTO_BYTES = 600 * 1024; // the app compresses photos to ~150 KB before upload
router.post('/:id/review', auth(true), require('../utils/rateLimit').limit('review', { max: 10, windowMs: 3600e3, keyFn: (req) => req.userId }), async (req, res) => {
  try {
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim().slice(0, 2000);
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be 1-5' });

    const images = (Array.isArray(req.body.images) ? req.body.images : [])
      .filter(x => typeof x === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(x))
      .slice(0, MAX_REVIEW_PHOTOS);
    if (images.some(x => x.length > MAX_PHOTO_BYTES * 1.37)) {
      return res.status(400).json({ message: 'One of the photos is too large. Please choose a smaller photo.' });
    }

    const reviewer = await User.findById(req.userId);
    if (!reviewer) return res.status(401).json({ message: 'Not authenticated' });
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const verified = !!(await Order.exists({ user: req.userId, status: 'delivered', 'items.productId': product.id }));
    const review = { user: req.userId, name: reviewer.name, rating, comment, images, verified, at: new Date() };

    const existing = product.reviews.findIndex(r => r.user && String(r.user) === String(req.userId));
    if (existing >= 0) product.reviews.splice(existing, 1);
    product.reviews.unshift(review); // newest first

    product.reviewCount = product.reviews.length;
    product.rating = Math.round((product.reviews.reduce((s, r) => s + r.rating, 0) / product.reviews.length) * 10) / 10;
    await product.save();
    const out = product.toJSON(); delete out.stockAlerts;
    res.json(out);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/products/:id/review — remove your own review
router.delete('/:id/review', auth(true), async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  product.reviews = product.reviews.filter(r => !(r.user && String(r.user) === String(req.userId)));
  product.reviewCount = product.reviews.length;
  product.rating = product.reviews.length
    ? Math.round((product.reviews.reduce((s, r) => s + r.rating, 0) / product.reviews.length) * 10) / 10
    : 0;
  await product.save();
  const out = product.toJSON(); delete out.stockAlerts;
  res.json(out);
});

// POST /api/products/:id/notify-stock — subscribe to a back-in-stock email
router.post('/:id/notify-stock', auth(false), async (req, res) => {
  try {
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (product.stock > 0) return res.status(400).json({ message: 'This product is already in stock' });

    let email = req.body.email;
    let userId = null;
    if (req.userId) {
      const user = await User.findById(req.userId);
      if (user) { email = user.email; userId = user._id; }
    }
    if (!email || !email.includes('@')) return res.status(400).json({ message: 'A valid email is required' });

    const already = product.stockAlerts.some((a) => a.email.toLowerCase() === email.toLowerCase());
    if (already) return res.json({ subscribed: true, message: "You're already on the list for this product" });

    product.stockAlerts.push({ email: email.toLowerCase(), user: userId });
    await product.save();
    res.json({ subscribed: true, message: "We'll email you the moment it's back!" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── PRODUCT Q&A ───
// POST /api/products/:id/question — customer asks a question
router.post('/:id/question', auth(true), async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ message: 'Question cannot be empty' });
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const asker = await User.findById(req.userId);
    if (!asker) return res.status(401).json({ message: 'Not authenticated' });
    const trimmedQuestion = question.trim();
    const newEntry = { user: req.userId, name: asker.name, question: trimmedQuestion };
    product.questions.unshift(newEntry);

    // Try to answer instantly using AI, grounded in this product's own listed details.
    // If no API key is configured or the call fails, the question is simply left
    // unanswered for the seller/admin to reply to manually — nothing breaks either way.
    const aiAnswer = await generateAiAnswer(product, trimmedQuestion);
    if (aiAnswer) {
      product.questions[0].answer = aiAnswer;
      product.questions[0].answeredBy = 'ai';
      product.questions[0].answeredAt = new Date();
    }

    await product.save();
    res.status(201).json(product.questions);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/products/:id/question/:qIndex — seller or admin answers a question
router.patch('/:id/question/:qIndex', auth(true), async (req, res) => {
  try {
    const answerer = await User.findById(req.userId);
    if (!answerer) return res.status(401).json({ message: 'Not authenticated' });
    if (!['seller', 'admin'].includes(answerer.role)) return res.status(403).json({ message: 'Only the seller or admin can answer questions' });
    const { answer } = req.body;
    if (!answer || !answer.trim()) return res.status(400).json({ message: 'Answer cannot be empty' });
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (answerer.role === 'seller' && String(product.seller) !== String(req.userId)) {
      return res.status(403).json({ message: 'You can only answer questions on your own products' });
    }
    const q = product.questions[Number(req.params.qIndex)];
    if (!q) return res.status(404).json({ message: 'Question not found' });
    q.answer = answer.trim();
    q.answeredBy = answerer.role;
    q.answeredAt = new Date();
    await product.save();
    res.json(product.questions);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/products/:id/question/:qIndex/helpful — mark a Q&A as helpful
router.patch('/:id/question/:qIndex/helpful', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const q = product.questions[Number(req.params.qIndex)];
  if (!q) return res.status(404).json({ message: 'Question not found' });
  q.helpfulCount = (q.helpfulCount || 0) + 1;
  await product.save();
  res.json({ helpfulCount: q.helpfulCount });
});

module.exports = router;
