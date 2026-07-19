const jwt = require('jsonwebtoken');

function auth(required = true) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      if (required) return res.status(401).json({ message: 'Not authenticated' });
      return next();
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.id;
      next();
    } catch (err) {
      if (required) return res.status(401).json({ message: 'Invalid or expired token' });
      next();
    }
  };
}

module.exports = auth;
