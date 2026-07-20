const db = require('../config/db');

// Создаём таблицу, если её нет
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    author TEXT DEFAULT 'Аноним',
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const Artifact = {
  getAll() {
    return db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC').all();
  },
  create(id, author, type, title, description, filePath) {
    const stmt = db.prepare('INSERT INTO artifacts (id, author, type, title, description, file_path) VALUES (?, ?, ?, ?, ?, ?)');
    return stmt.run(id, author, type, title, description, filePath);
  },
  getById(id) {
    return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  }
};

module.exports = Artifact;
