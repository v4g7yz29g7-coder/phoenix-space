const db = require('../config/db');

db.exec(`
  CREATE TABLE IF NOT EXISTS offline_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_did TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,
    sender_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivered INTEGER DEFAULT 0
  )
`);

const Message = {
  store(recipientDid, encryptedData, senderName) {
    return db.prepare('INSERT INTO offline_messages (recipient_did, encrypted_data, sender_name) VALUES (?, ?, ?)').run(recipientDid, encryptedData, senderName);
  },
  getPending(recipientDid) {
    return db.prepare('SELECT * FROM offline_messages WHERE recipient_did = ? AND delivered = 0 ORDER BY timestamp ASC').all(recipientDid);
  },
  markDelivered(messageId) {
    db.prepare('UPDATE offline_messages SET delivered = 1 WHERE id = ?').run(messageId);
  },
  deleteOld() {
    db.prepare('DELETE FROM offline_messages WHERE timestamp < datetime("now", "-7 days")').run();
  }
};

// Периодическая очистка старых сообщений (каждые 60 минут)
setInterval(() => {
  Message.deleteOld();
}, 60 * 60 * 1000);

module.exports = Message;
