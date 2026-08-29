const jwt = require('jsonwebtoken');

// Продакшн-безопасность: секрет ОБЯЗАТЕЛЕН из .env
// Без него сервер не запускается — не допускает деплой с дефолтным ключом
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан в .env! Продакшн-безопасность нарушена.');
  console.error('   Сгенерируйте: openssl rand -hex 32 и запишите в .env');
  process.exit(1);
}

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
