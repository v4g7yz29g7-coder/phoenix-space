// ============================================================================
//  ФЕНИКС — Конфигурация PM2 для продакшна
//  Запуск: pm2 start ecosystem.config.js --env production
//  Логи:   pm2 logs phoenix
// ============================================================================
module.exports = {
  apps: [{
    name: 'phoenix',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,               // SQLite — 1 инстанс достаточно для простой структуры
    exec_mode: 'fork',
    autorestart: true,
    watch: false,               // В продакшне не следим за изменениями

    // Переменные для процесса
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },

    // Логи
    log_file: './logs/pm2.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    merge_logs: true,
    time: true,                 // Добавлять время в логи
    max_restarts: 10,           // Максимум рестартов за 60 сек
    min_uptime: '10s',
    restart_delay: 3000,        // Пауза между рестартами

    // Метрики и защита
    max_memory_restart: '500M', // Авто-рестарт при >500MB памяти
    kill_timeout: 5000,
    listen_timeout: 5000
  }]
};
