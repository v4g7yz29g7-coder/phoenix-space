const db = require('../config/db');

const Content = {
  getAll(hall) {
    return db.prepare('SELECT * FROM contents WHERE hall = ? ORDER BY "order" ASC').all(hall);
  },
  getAllByLang(hall, lang) {
    return db.prepare('SELECT * FROM contents WHERE hall = ? AND lang = ? ORDER BY "order" ASC').all(hall, lang);
  },
  create(hall, title, body, order, lang = 'ru') {
    const stmt = db.prepare('INSERT INTO contents (hall, title, body, "order", lang) VALUES (?, ?, ?, ?, ?)');
    return stmt.run(hall, title, body, order, lang);
  },
  update(id, title, body) {
    const stmt = db.prepare('UPDATE contents SET title = ?, body = ? WHERE id = ?');
    return stmt.run(title, body, id);
  },
  delete(id) {
    const stmt = db.prepare('DELETE FROM contents WHERE id = ?');
    return stmt.run(id);
  }
};
module.exports = Content;
