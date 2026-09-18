'use strict';

/**
 * HARD_SKILLS — незыблемые правила безопасности.
 * Нарушение = потенциальная потеря данных / утечка секретов / падение сервиса.
 */
const HARD_SKILLS = Object.freeze([
  {
    id: 'NO_SYSTEM_FILE_DELETE',
    rule: 'Не удалять системные файлы и каталоги (/etc, /usr, /bin, /var, /lib, /boot).',
    severity: 'critical',
  },
  {
    id: 'NO_SECRETS_COMMIT',
    rule: 'Не коммитить секреты: .env, ключи, токены, пароли, приватные сертификаты.',
    severity: 'critical',
  },
  {
    id: 'NO_RM_RF_ROOT',
    rule: 'Никогда не запускать rm -rf / (или с путями, затрагивающими корень/систему).',
    severity: 'critical',
  },
  {
    id: 'NO_ENV_MUTATION',
    rule: 'Не изменять/не перезаписывать .env — только читать или создавать шаблоны (.env.example).',
    severity: 'high',
  },
  {
    id: 'NO_PM2_WITHOUT_BACKUP',
    rule: 'Не трогать pm2 (stop/delete/restart) без предварительного бэкапа процессов (pm2 save + dump).',
    severity: 'high',
  },
  {
    id: 'NO_DB_FILE_TOUCH',
    rule: 'Не модифицировать *.db и другие файлы данных напрямую — только через приложение/миграции.',
    severity: 'high',
  },
  {
    id: 'VERIFY_BEFORE_DESTRUCTIVE',
    rule: 'Перед любой деструктивной операцией — dry-run/бэкап/подтверждение и явная проверка пути.',
    severity: 'medium',
  },
]);

/**
 * SOFT_SKILLS — стратегии решения задач.
 * Не жёсткие запреты, а эвристики для эффективного достижения результата.
 */
const SOFT_SKILLS = Object.freeze([
  {
    id: 'TRY_ALTERNATIVE',
    strategy: 'Если способ не сработал — попробуй альтернативу (другой инструмент, версия, источник).',
  },
  {
    id: 'DECOMPOSE',
    strategy: 'Декомпозируй сложную задачу на маленькие проверяемые шаги.',
  },
  {
    id: 'CHECK_BOUNDARIES',
    strategy: 'Проверяй границы: пустые входы, крайние значения, отсутствующие файлы, права доступа.',
  },
  {
    id: 'VERIFY_AFTER_ACTION',
    strategy: 'После каждого действия проверяй результат (node --check, curl, ls, exit code).',
  },
  {
    id: 'MINIMIZE_STEPS',
    strategy: 'Минимизируй число шагов: объединяй независимые команды, читай одним запросом.',
  },
  {
    id: 'GRACEFUL_FALLBACK',
    strategy: 'Предусматривай fallback: если основной путь падает — деградируй безопасно, не теряя данные.',
  },
]);

/**
 * @returns {Array<object>} список жёстких правил
 */
function getHardSkills() {
  return HARD_SKILLS.map((s) => ({ ...s }));
}

/**
 * @returns {Array<object>} список мягких стратегий
 */
function getSoftSkills() {
  return SOFT_SKILLS.map((s) => ({ ...s }));
}

module.exports = { HARD_SKILLS, SOFT_SKILLS, getHardSkills, getSoftSkills };
