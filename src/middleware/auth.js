const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'phoenix-secret-key-change-in-production';

module.exports = function(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ success: false, error: 'Нет токена' });
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Неверный токен' });
  }
};
