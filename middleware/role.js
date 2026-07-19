// Restricts a route to users whose role is in `roles`. Must run after auth(true),
// since it relies on req.userId already being set — it loads the user to check role.
const User = require('../models/User');

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      if (!req.userId) return res.status(401).json({ message: 'Not authenticated' });
      const user = await User.findById(req.userId);
      if (!user) return res.status(401).json({ message: 'Not authenticated' });
      if (!roles.includes(user.role)) {
        return res.status(403).json({ message: `Requires one of these roles: ${roles.join(', ')}` });
      }
      req.user = user;
      next();
    } catch (err) {
      res.status(500).json({ message: 'Authorization check failed', error: err.message });
    }
  };
}

module.exports = requireRole;
