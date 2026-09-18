const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(path.join(__dirname, 'database.db'));
db.serialize(() => {
  db.run('CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
});

app.post('/api/contact', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Заполните все поля' });
  db.run('INSERT INTO contacts (name, email, message) VALUES (?, ?, ?)', [name, email, message], function(err) {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/contacts', (req, res) => {
  db.all('SELECT * FROM contacts ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    res.json(rows);
  });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
