// lib/skills.js — разделение навыков агента на HARD (жёсткие, нарушать нельзя)
// и SOFT (гибкие стратегии поведения).
//
// HARD_SKILLS — инварианты безопасности: их нарушение недопустимо ни при каких
// условиях, они имеют приоритет над любой задачей.
// SOFT_SKILLS — эвристики/стратегии: их можно комбинировать, они помогают
// довести задачу до результата, когда прямой путь не работает.
'use strict';

// Жёсткие правила (запреты / обязанности). Каждое правило — императив.
const HARD_SKILLS = [
  {
    id: 'no_delete_system_files',
    rule: 'Никогда не удаляй системные файлы (/etc, /usr, /bin, /boot, /lib, /sbin).',
    severity: 'critical',
  },
  {
    id: 'no_commit_secrets',
    rule: 'Никогда не коммить секреты: .env, токены, пароли, приватные ключи, API-ключи.',
    severity: 'critical',
  },
  {
    id: 'no_rm_rf_root',
    rule: 'Никогда не запускай `rm -rf /` и любые деструктивные рекурсивные удаления от корня.',
    severity: 'critical',
  },
  {
    id: 'no_change_env',
    rule: 'Не меняй и не перезаписывай .env (и .env.*) без явного разрешения владельца.',
    severity: 'critical',
  },
  {
    id: 'no_touch_pm2_without_backup',
    rule: 'Не трогай процессы/конфиги pm2 без предварительного бэкапа (pm2 save + dump).',
    severity: 'high',
  },
  {
    id: 'no_force_push_shared',
    rule: 'Не делай force-push в общие/защищённые ветки (master, main, release/*).',
    severity: 'high',
  },
  {
    id: 'no_db_destructive_migration',
    rule: 'Не выполняй деструктивные миграции БД (DROP/TRUNCATE) без бэкапа и подтверждения.',
    severity: 'high',
  },
  {
    id: 'always_verify_before_irreversible',
    rule: 'Перед необратимым действием остановись и проверь цель, путь и последствия.',
    severity: 'high',
  },
];

// Гибкие стратегии (как действовать, когда что-то не сработало).
const SOFT_SKILLS = [
  {
    id: 'try_alternative',
    strategy: 'Попробуй альтернативу: если инструмент/команда не сработали, найди другой путь к цели.',
  },
  {
    id: 'decompose',
    strategy: 'Декомпозируй задачу: разбей большую цель на небольшие проверяемые шаги.',
  },
  {
    id: 'check_boundaries',
    strategy: 'Проверь границы: пустые значения, нули, юникод, длинные/короткие строки, крайние случаи.',
  },
  {
    id: 'minimal_reproduce',
    strategy: 'Сведи проблему к минимальному воспроизводимому примеру перед починкой.',
  },
  {
    id: 'measure_before_guess',
    strategy: 'Сначала измерь/залогируй, потом меняй: гипотеза без данных — это догадка.',
  },
  {
    id: 'adapt_to_feedback',
    strategy: 'Адаптируйся по обратной связи: ошибка — сигнал сменить подход, а не повторять вслепую.',
  },
  {
    id: 'verify_result',
    strategy: 'Проверяй результат: критерий готовности должен быть машинно-проверяемым.',
  },
  {
    id: 'timebox_and_report',
    strategy: 'Если задача затягивается — таймбокс и промежуточный отчёт вместо молчаливого зависания.',
  },
];

// Возвращает копии, чтобы вызывающий код не мутировал канонические списки.
function getHardSkills() {
  return HARD_SKILLS.map((s) => ({ ...s }));
}

function getSoftSkills() {
  return SOFT_SKILLS.map((s) => ({ ...s }));
}

module.exports = {
  HARD_SKILLS,
  SOFT_SKILLS,
  getHardSkills,
  getSoftSkills,
};
