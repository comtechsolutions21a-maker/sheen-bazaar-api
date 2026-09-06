const express = require('express');
const ChatThread = require('../models/ChatMessage');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth(true));

// GET /api/chat/mine — customer's own chat thread (creates if doesn't exist)
router.get('/mine', async (req, res) => {
  let thread = await ChatThread.findOne({ user: req.userId });
  if (!thread) thread = await ChatThread.create({ user: req.userId, messages: [] });
  thread.unreadByCustomer = false;
  await thread.save();
  res.json(thread);
});

// POST /api/chat/mine — customer sends a message
router.post('/mine', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ message: 'Message cannot be empty' });
  let thread = await ChatThread.findOne({ user: req.userId });
  if (!thread) thread = await ChatThread.create({ user: req.userId, messages: [] });
  thread.messages.push({ from: 'customer', text: text.trim() });
  thread.status = 'open';
  thread.lastMessageAt = new Date();
  thread.unreadByAdmin = true;
  await thread.save();
  res.status(201).json(thread);
});

module.exports = router;
