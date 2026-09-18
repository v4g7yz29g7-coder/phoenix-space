const db = require('../config/db');
db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT,
  path TEXT,
  ip TEXT,
  userId TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

exports.auditLogger = (req, res, next) => {
  const stmt = db.prepare('INSERT INTO audit_logs (method, path, ip, userId) VALUES (?, ?, ?, ?)');
  stmt.run(req.method, req.originalUrl, req.ip, req.headers['x-user-id'] || 'anonymous');
  next();
};
