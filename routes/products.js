const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const ResellerListing = require('../models/ResellerListing');
const auth = require('../middleware/auth');
const { generateAiAnswer } = require('../utils/aiAnswer');

const router = express.Router();

// GET /api/products?cat=Fashion&search=saree&sort=price-low&minPrice=0&maxPrice=600
router.get('/', async (req, res) => {
  try {
    const { cat, search, sort, minPrice, maxPrice } = req.query;
    const filter = { active: true };

    if (cat && cat !== 'All') filter.cat = cat;
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    let query = Product.find(filter);
    if (sort === 'price-low') query = query.sort({ price: 1 });
    if (sort === 'price-high') query = query.sort({ price: -1 });

    const products = await query.exec();
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch products', error: err.message });
  }
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
  const productIds = listings.map((l) => l.productId);
  const products = await Product.find({ id: { $in: productIds }, active: true });
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
    const product = await Product.findOne({ id: Number(req.params.id), active: true });
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
  const related = await Product.find({ cat: product.cat, id: { $ne: product.id }, active: true }).limit(6);
  res.json(related);
});

// POST /api/products/:id/review — customer leaves a review
router.post('/:id/review', auth(true), async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be 1-5' });
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    product.reviews.push({ user: req.user._id, name: req.user.name, rating: Number(rating), comment: comment || '' });
    product.reviewCount = product.reviews.length;
    product.rating = product.reviews.reduce((s, r) => s + r.rating, 0) / product.reviews.length;
    await product.save();
    res.json(product);
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

    const trimmedQuestion = question.trim();
    const newEntry = { user: req.user._id, name: req.user.name, question: trimmedQuestion };
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
    if (!['seller', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Only the seller or admin can answer questions' });
    const { answer } = req.body;
    if (!answer || !answer.trim()) return res.status(400).json({ message: 'Answer cannot be empty' });
    const product = await Product.findOne({ id: Number(req.params.id) });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'seller' && String(product.seller) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only answer questions on your own products' });
    }
    const q = product.questions[Number(req.params.qIndex)];
    if (!q) return res.status(404).json({ message: 'Question not found' });
    q.answer = answer.trim();
    q.answeredBy = req.user.role;
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
