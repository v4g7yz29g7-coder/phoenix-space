const express = require('express');
const { authLimiter } = require('../middleware/rateLimiter');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();

// Секрет для JWT (в реальном проекте – в .env)
// Продакшн: секрет обязателен из .env
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан в .env! Продакшн-безопасность нарушена.');
  console.error('   Сгенерируйте: openssl rand -hex 32 и запишите в .env');
  process.exit(1);
}

// Регистрация (с лимитом попыток)
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Все поля обязательны' });
    }
    const existing = User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Пользователь с таким email уже существует' });
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const result = User.create(username, email, passwordHash);
    // Сразу выдаём токен
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, token, user: { id: result.lastInsertRowid, username, email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Вход (с лимитом попыток)
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email и пароль обязательны' });
    }
    const user = User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Неверные учетные данные' });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Неверные учетные данные' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
