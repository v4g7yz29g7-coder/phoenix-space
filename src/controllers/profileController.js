const db = require('../config/db');

exports.getProfile = (req, res) => {
  try {
    const did = req.params.did || req.query.did;
    if (!did) return res.status(400).json({ success: false, error: 'DID обязателен' });

    const rep = db.prepare('SELECT * FROM did_reputation WHERE did = ?').get(did);
    if (!rep) return res.status(404).json({ success: false, error: 'Профиль не найден' });

    const artifacts = db.prepare('SELECT * FROM artifacts WHERE author = ? ORDER BY created_at DESC').all(did);
    res.json({ success: true, data: { ...rep, artifacts: artifacts || [] } });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.updateProfile = (req, res) => {
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
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
