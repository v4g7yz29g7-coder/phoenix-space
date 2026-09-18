const { exec } = require('child_process');

function coder() {
  return new Promise((resolve) => {
    exec('echo "Авто-создано агентом Coder" > ~/phoenix/logs/coder_output.txt', (err, stdout, stderr) => {
      if (err) resolve('Coder: ошибка — ' + (stderr || err.message));
      else resolve('Coder: файл создан');
    });
  });
}

function guardian() {
  return new Promise((resolve) => {
    exec('grep -R "IO.inspect" ~/phoenix --include="*.js" --include="*.ex" --include="*.exs" --exclude="gardener.js"', (err, stdout) => {
      if (stdout) resolve('Guardian: обнаружены проблемы:\n' + stdout);
      else resolve('Guardian: архитектура чиста');
    });
  });
}

function reporter(text) {
  return new Promise((resolve) => {
    const log = '~/phoenix/logs/agents_report.log';
    exec(`mkdir -p ~/phoenix/logs && echo "${text}" >> ${log}`, (err) => {
      if (err) resolve('Reporter: ошибка записи');
      else resolve('Reporter: отчёт записан');
    });
  });
}

module.exports = { coder, guardian, reporter };
