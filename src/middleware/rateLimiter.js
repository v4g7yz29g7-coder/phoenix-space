const rateLimit = require('express-rate-limit');

// Общий лимит: 1000 запросов в 15 минут (для разработки)
exports.generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { success: false, error: 'Слишком много запросов, попробуй позже.' }
});

// Лимит для "посадки семян" (Сада) — 100 за 15 минут
exports.seedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Слишком много семян, отдохни.' }
});
