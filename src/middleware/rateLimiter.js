const rateLimit = require('express-rate-limit');

// ============================================================
//  ЛИМИТЕРЫ ЗАПРОСОВ — адаптированы под среду запуска
//  В продакшене лимиты жёстче, т.к. защищаемся от брута/спама
// ============================================================

const isProduction = process.env.NODE_ENV === 'production';

// Общий лимит: 
//   dev  — 1000 запросов / 15 мин (свободно для отладки)
//   prod — 300  запросов / 15 мин (жёстче, но щедро для нормальных юзеров)
exports.generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 300 : 1000,
  standardHeaders: true,        // Возвращать заголовки RateLimit-* 
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Слишком много запросов. Пожалуйста, подождите немного.'
  }
});

// Лимит для авторизации (login/register) — защита от брутфорса
exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 20 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Слишком много попыток авторизации. Подождите 15 минут.'
  }
});

// Лимит для "посадки семян" (Сада) — тяжёлая операция
exports.seedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 30 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Слишком много семян. Отдохните, сад не торопится.'
  }
});

// Лимит для API-эндпоинтов с чувствительными данными
exports.apiLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 минута
  max: isProduction ? 60 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Слишком много запросов к API. Подождите минуту.'
  }
});
