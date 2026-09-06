const express = require('express');
const Feedback = require('../models/Feedback');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/feedback — public, approved feedbacks for homepage
router.get('/', async (req, res) => {
  const feedbacks = await Feedback.find({ approved: true }).sort({ featured: -1, createdAt: -1 }).limit(20);
  res.json(feedbacks);
});

// POST /api/feedback — logged-in user submits feedback
router.post('/', auth(true), async (req, res) => {
  const { rating, comment, type, city } = req.body;
  if (!rating) return res.status(400).json({ message: 'Rating required' });
  const reviewer = await User.findById(req.userId);
  if (!reviewer) return res.status(401).json({ message: 'Not authenticated' });
  const fb = await Feedback.create({ user: req.userId, name: reviewer.name, rating: Number(rating), comment: comment || '', type: type || 'general', city: city || '' });
  res.status(201).json(fb);
});

module.exports = router;
