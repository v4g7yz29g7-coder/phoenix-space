'use strict';
// gh_agent.js — синхронизация с GitHub + отчёт для инвентаризации
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STATUS_FILE = path.join(ROOT, 'memory', 'gh_status.json');

function run(cmd) {
  try {
    return execSync(`cd ${ROOT} && ${cmd}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function status() {
  const remote = run('git remote -v');
  const branch = run('git rev-parse --abbrev-ref HEAD');
  const lastCommit = run('git log -1 --format="%H|%s|%ai"');
  const last20 = run('git log --oneline -20');
  const branches = run('git branch -a');
  const uncommitted = run('git status --short');
  const ahead = run(`git rev-list --count origin/${branch}..${branch}`);
  const behind = run(`git rev-list --count ${branch}..origin/${branch}`);

  const report = {
    ts: new Date().toISOString(),
    remote: remote || 'NO_REMOTE',
    branch: branch || 'unknown',
    last_commit: lastCommit || 'none',
    last_20_commits: (last20 || '').split('\n').filter(Boolean),
    branches: (branches || '').split('\n').filter(Boolean),
    uncommitted_files: (uncommitted || '').split('\n').filter(Boolean).length,
    ahead_of_remote: parseInt(ahead) || 0,
    behind_remote: parseInt(behind) || 0,
    sync_status: parseInt(ahead) > 0 ? 'NEED_PUSH' : 'IN_SYNC',
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(report, null, 2));
  return report;
}

function push() {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  if (!branch) return { ok: false, error: 'no_branch' };
  try {
    execSync(`cd ${ROOT} && git push origin ${branch}`, { stdio: 'pipe' });
    return { ok: true, branch };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'push') {
    console.log(JSON.stringify(push(), null, 2));
  } else {
    console.log(JSON.stringify(status(), null, 2));
  }
}

module.exports = { status, push };
