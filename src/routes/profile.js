const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../config/db');

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
      require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 }
});

router.post('/update', avatarUpload.single('avatar'), (req, res) => {
  try {
    const { did, display_name } = req.body;
    if (!did) return res.status(400).json({ success: false, error: 'DID обязателен' });

    if (req.file) {
      const avatarPath = '/uploads/avatars/' + req.file.filename;
      db.prepare('UPDATE did_reputation SET avatar = ? WHERE did = ?').run(avatarPath, did);
    }
    if (display_name !== undefined) {
      db.prepare('UPDATE did_reputation SET display_name = ? WHERE did = ?').run(display_name, did);
    }

    const updated = db.prepare('SELECT * FROM did_reputation WHERE did = ?').get(did);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
