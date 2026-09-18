"use strict";
// apply.js v3 — перебирает ВСЕ боевые race, берёт первый, где файл реально создан
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const RACES_DIR = path.join(ROOT, "memory", "races");
const LOG_FILE = path.join(ROOT, "memory", "apply.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}

function listBattleRaces() {
  const files = fs.readdirSync(RACES_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ f, mtime: fs.statSync(path.join(RACES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const { f, mtime } of files) {
    try {
      const race = JSON.parse(fs.readFileSync(path.join(RACES_DIR, f), "utf8"));
      if (!race.winner || !race.results || !race.task) continue;
      if (race.task.indexOf("\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u0439") === 0) continue;
      const fileMatch = race.task.match(/[a-zA-Z0-9_\-\/]+\.(js|md|json|ts)/);
      if (!fileMatch) continue;
      const winnerResult = race.results.find(r => r.box === race.winner);
      if (!winnerResult || !winnerResult.ok) continue;
      out.push({ race, winnerResult, filePath: fileMatch[0], raceMtime: mtime, raceFile: f });
    } catch (e) {}
  }
  return out;
}

function verifyFile(filePath) {
  const abs = path.join(ROOT, filePath);
  if (!fs.existsSync(abs)) return { ok: false, reason: "file_not_found", abs };
  const stat = fs.statSync(abs);
  if (stat.size === 0) return { ok: false, reason: "empty_file", abs };
  const checks = {
    exists: true,
    lines: fs.readFileSync(abs, "utf8").split("\n").length,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
  if (filePath.endsWith(".js")) {
    try { execSync("node --check " + abs, { stdio: "pipe" }); checks.syntax = true; }
    catch (e) { return { ok: false, reason: "syntax_error", error: e.message.slice(0, 200), checks }; }
  } else { checks.syntax = "n/a"; }
  return { ok: true, checks, abs, fileMtime: stat.mtimeMs };
}

function gitCommit(filePath, race) {
  try {
    // 18.09: проверяем, есть ли изменения — иначе commit падает
    execSync("cd " + ROOT + " && git add \"" + filePath + "\"", { stdio: "pipe" });
    try {
      execSync("cd " + ROOT + " && git diff --cached --quiet", { stdio: "pipe" });
      // exit 0 = нет изменений
      return { ok: false, reason: "no_changes" };
    } catch (e) {
      // exit 1 = есть изменения, коммитим
    }
    const msg = "apply(" + race.winner + "): " + filePath + " [" + race.winner_score + "/10, race " + race.race_id.slice(-8) + "]";
    execSync("cd " + ROOT + " && git commit -m \"" + msg + "\"", { stdio: "pipe" });
    return { ok: true, msg };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

function apply() {
  log("=== apply.js v3 started ===");
  const races = listBattleRaces();
  log("\u0411\u043e\u0435\u0432\u044b\u0445 race \u043d\u0430\u0439\u0434\u0435\u043d\u043e: " + races.length);

  const skipped = [];
  for (const r of races) {
    log("--- " + r.raceFile + " | winner: " + r.race.winner + " | file: " + r.filePath);
    const v = verifyFile(r.filePath);
    if (!v.ok) { skipped.push({ race: r.raceFile, reason: v.reason }); log("   \u274c " + v.reason); continue; }
    if (v.fileMtime < r.raceMtime - 120000) {
      skipped.push({ race: r.raceFile, reason: "file_too_old" });
      log("   \u26a0 file_too_old (file: " + new Date(v.fileMtime).toISOString() + ", race: " + new Date(r.raceMtime).toISOString() + ")");
      continue;
    }
    log("   \u2705 Checks: " + JSON.stringify(v.checks));
    const c = gitCommit(r.filePath, r.race);
    if (!c.ok) { log("   \u26a0 git_commit_failed: " + c.error); continue; }
    log("   \u2705 \u0412\u043d\u0435\u0434\u0440\u0435\u043d\u043e: " + r.filePath);
    return { ok: true, file: r.filePath, winner: r.race.winner, score: r.race.winner_score, race: r.raceFile, commit: c.msg };
  }

  log("\u274c \u041d\u0438 \u043e\u0434\u0438\u043d race \u043d\u0435 \u043f\u0440\u043e\u0448\u0451\u043b");
  return { ok: false, reason: "no_applicable_race", skipped };
}

if (require.main === module) { const r = apply(); console.log(JSON.stringify(r, null, 2)); }
module.exports = { apply, listBattleRaces, verifyFile };
