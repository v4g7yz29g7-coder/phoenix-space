'use strict';

/**
 * HARD_SKILLS — жёсткие правила безопасности (нельзя нарушать).
 * SOFT_SKILLS — стратегии решения задач (как действовать гибко).
 */

const HARD_SKILLS = [
  {
    id: 'no_system_files_delete',
    rule: 'Никогда не удалять системные файлы и директории (/etc, /usr, /bin, /boot, /var, /lib, /sbin, /proc, /sys).',
    action: 'STOP'
  },
  {
    id: 'no_secrets_commit',
    rule: 'Никогда не коммитить секреты: токены, API-ключи, пароли, .env, *.key, *.pem, credentials.',
    action: 'STOP'
  },
  {
    id: 'no_rm_rf_root',
    rule: 'Никогда не выполнять rm -rf / или rm -rf /* и любые рекурсивные удаления от корня.',
    action: 'STOP'
  },
  {
    id: 'no_env_modify',
    rule: 'Никогда не изменять и не удалять .env и файлы окружения без явного разрешения владельца.',
    action: 'STOP'
  },
  {
    id: 'no_pm2_without_backup',
    rule: 'Никогда не трогать pm2 (delete/restart/stop) без предварительного бэкапа конфигурации и списка процессов.',
    action: 'BACKUP_FIRST'
  },
  {
    id: 'no_db_modify',
    rule: 'Никогда не удалять и не перезаписывать *.db / *.sqlite файлы данных.',
    action: 'STOP'
  },
  {
    id: 'confirm_destructive',
    rule: 'Любая деструктивная операция выполняется только после бэкапа и подтверждения.',
    action: 'BACKUP_FIRST'
  }
];

const SOFT_SKILLS = [
  {
    id: 'try_alternative',
    strategy: 'Если решение не работает — попробуй альтернативу: другой инструмент, библиотеку, синтаксис или подход вместо упорного повторения одного и того же.',
    when: 'Первая попытка провалилась.'
  },
  {
    id: 'decompose',
    strategy: 'Декомпозируй задачу: разбей большую цель на маленькие проверяемые шаги и выполняй их последовательно.',
    when: 'Задача сложная или неоднозначная.'
  },
  {
    id: 'check_boundaries',
    strategy: 'Проверяй границы: пустые входы, null/undefined, крайние значения, размеры массивов, таймауты, права доступа.',
    when: 'Перед сдачей результата.'
  },
  {
    id: 'verify_result',
    strategy: 'Всегда верифицируй результат (node --check, тесты, curl, логи), а не полагайся на предположение об успехе.',
    when: 'После каждого изменения.'
  },
  {
    id: 'minimal_change',
    strategy: 'Делай минимальные точечные изменения вместо массовых переписываний — меньше риск сломать работающее.',
    when: 'Правка существующего кода.'
  },
  {
    id: 'read_before_write',
    strategy: 'Сначала прочитай и пойми контекст (файлы, зависимости, логи), потом меняй.',
    when: 'Перед любым изменением.'
  },
  {
    id: 'report_partial',
    strategy: 'Если задача затягивается — сообщи о частичном результате и текущем статусе, не молчи.',
    when: 'Задача долгая или застряла.'
  }
];

/**
 * @returns {Array<Object>} список жёстких правил
 */
function getHardSkills() {
  return HARD_SKILLS;
}

/**
 * @returns {Array<Object>} список мягких стратегий
 */
function getSoftSkills() {
  return SOFT_SKILLS;
}

module.exports = { getHardSkills, getSoftSkills, HARD_SKILLS, SOFT_SKILLS };

if (require.main === module) {
  console.log('HARD_SKILLS:', getHardSkills().length);
  console.log(getHardSkills().map(s => `- [HARD] ${s.id}: ${s.rule}`).join('\n'));
  console.log('\nSOFT_SKILLS:', getSoftSkills().length);
  console.log(getSoftSkills().map(s => `- [SOFT] ${s.id}: ${s.strategy}`).join('\n'));
}
