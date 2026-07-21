const express = require('express');
const router = express.Router();
const gardenController = require('../controllers/gardenController');
const blockchainController = require('../controllers/blockchainController');
const Content = require('../models/Content');
const path = require('path');

// Сад
router.get('/seeds', gardenController.getAllSeeds);
router.post('/seeds', gardenController.createSeed);

// Блокчейн
router.post('/blockchain/register', blockchainController.registerOnChain);
router.get('/blockchain/artifact/:id', blockchainController.getArtifactFromChain);
router.get('/blockchain/artifacts', blockchainController.getAllFromChain);

// DID
router.post('/did/generate', (req, res) => {
  try {
    const { createDID } = require('../utils/did');
    const did = createDID();
    res.json({ success: true, data: { did: did.did, address: did.address, mnemonic: did.mnemonic } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Профиль
const profileController = require('../controllers/profileController');
router.get('/profile/:did', profileController.getProfile);
router.get('/profile', (req, res) => {
  if (req.query.did) return profileController.getProfile(req, res);
  res.status(400).json({ success: false, error: 'Укажите DID' });
});

// Загрузка аватара и обновление профиля
const multer = require('multer');
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/avatars'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });
router.post('/profile/update', uploadAvatar.single('avatar'), profileController.updateProfile);

// Контент Залов с языковой поддержкой (включая healing)
router.get('/contents/:hall', (req, res) => {
  try {
    const lang = req.query.lang || 'ru';
    let items = Content.getAllByLang(req.params.hall, lang);
    if (items.length === 0 && lang !== 'ru') {
      items = Content.getAllByLang(req.params.hall, 'ru');
    }
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Мастерская (загрузка артефактов)
const workshopUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'public', 'uploads');
      require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
      cb(null, uniqueName);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});
const workshopController = require('../controllers/workshopController');
router.get('/artifacts', workshopController.getAllArtifacts);
router.post('/artifacts', workshopUpload.single('file'), workshopController.createArtifact);

// Админка
const ADMIN_KEY = 'phoenix-architect-2024';
function checkAdmin(req, res, next) {
  if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
  res.status(403).json({ error: 'Доступ запрещён' });
}
router.post('/admin/contents', checkAdmin, (req, res) => {
  const { hall, title, body, order, lang } = req.body;
  try {
    const result = Content.create(hall, title, body, order || 0, lang || 'ru');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.put('/admin/contents/:id', checkAdmin, (req, res) => {
  const { title, body } = req.body;
  try {
    Content.update(req.params.id, title, body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.delete('/admin/contents/:id', checkAdmin, (req, res) => {
  try {
    Content.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

// Витрина задач (Bounties)
router.get('/bounties', (req, res) => {
  try {
    const db = require('../config/db');
    const bounties = db.prepare('SELECT * FROM bounties ORDER BY created_at DESC').all();
    res.json({ success: true, data: bounties });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
