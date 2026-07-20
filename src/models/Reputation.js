const db = require('../config/db');

db.exec(`
  CREATE TABLE IF NOT EXISTS did_reputation (
    did TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    practices_completed INTEGER DEFAULT 0,
    artifacts_count INTEGER DEFAULT 0,
    complaints_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'newcomer',
    stake_points INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_did TEXT NOT NULL,
    target_did TEXT NOT NULL,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const Reputation = {
  getByDID(did) {
    return db.prepare('SELECT * FROM did_reputation WHERE did = ?').get(did);
  },
  createDID(did) {
    db.prepare('INSERT OR IGNORE INTO did_reputation (did) VALUES (?)').run(did);
  },
  incrementPractices(did) {
    db.prepare('UPDATE did_reputation SET practices_completed = practices_completed + 1 WHERE did = ?').run(did);
    this.checkUpgrade(did);
  },
  incrementArtifacts(did) {
    db.prepare('UPDATE did_reputation SET artifacts_count = artifacts_count + 1 WHERE did = ?').run(did);
    this.checkUpgrade(did);
  },
  checkUpgrade(did) {
    const rep = this.getByDID(did);
    if (!rep) return;
    if (rep.complaints_count >= 3) {
      db.prepare('UPDATE did_reputation SET status = ? WHERE did = ?').run('banned', did);
    } else if (rep.practices_completed >= 10 && rep.artifacts_count > 0) {
      db.prepare('UPDATE did_reputation SET status = ? WHERE did = ?').run('architect', did);
    } else if (rep.practices_completed >= 3) {
      db.prepare('UPDATE did_reputation SET status = ? WHERE did = ?').run('practitioner', did);
    }
  },
  addComplaint(reporterDid, targetDid, reason) {
    // Проверяем, не жаловался ли уже этот reporter на target за последние 24 часа
    const recent = db.prepare('SELECT id FROM reports WHERE reporter_did = ? AND target_did = ? AND timestamp > datetime("now", "-1 day")').get(reporterDid, targetDid);
    if (recent) return false;

    db.prepare('INSERT INTO reports (reporter_did, target_did, reason) VALUES (?, ?, ?)').run(reporterDid, targetDid, reason);
    db.prepare('UPDATE did_reputation SET complaints_count = complaints_count + 1 WHERE did = ?').run(targetDid);
    this.checkUpgrade(targetDid);
    return true;
  },
  banDID(did) {
    db.prepare('UPDATE did_reputation SET status = ? WHERE did = ?').run('banned', did);
  },
  isNewcomer(did) {
    const rep = this.getByDID(did);
    if (!rep) return true;
    // DID старше 24 часов?
    const age = (Date.now() - new Date(rep.created_at).getTime()) / (1000 * 60 * 60);
    return age < 24;
  }
};

module.exports = Reputation;
