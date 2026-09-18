const db = require('../config/db');
const Seed = {
  getAll() {
    return db.prepare('SELECT * FROM seeds ORDER BY created_at DESC').all();
  },
  create(message) {
    const stmt = db.prepare('INSERT INTO seeds (message) VALUES (?)');
    return stmt.run(message);
  }
};
module.exports = Seed;
