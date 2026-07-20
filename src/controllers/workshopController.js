const { v4: uuidv4 } = require('uuid');
const Artifact = require('../models/Artifact');
const Reputation = require('../models/Reputation');
const { escapeHtml } = require('../utils/sanitize');

exports.getAllArtifacts = (req, res) => {
  try {
    const artifacts = Artifact.getAll();
    res.json({ success: true, data: artifacts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createArtifact = (req, res) => {
  try {
    const { author, type, title, description } = req.body;
    
    if (!title || !type) {
      return res.status(400).json({ success: false, error: 'Название и тип обязательны' });
    }

    const id = uuidv4();
    let filePath = null;

    if (req.file) {
      filePath = '/uploads/' + req.file.filename;
    }

    const cleanAuthor = escapeHtml(author || 'Аноним');
    const cleanTitle = escapeHtml(title);
    const cleanDesc = escapeHtml(description || '');

    Artifact.create(id, cleanAuthor, type, cleanTitle, cleanDesc, filePath);
    
    // Начисляем опыт ремесленника (10 за любой артефакт)
    let experienceGained = 10;
    if (author && author.startsWith('did:phoenix:0x')) {
      // Если автор указан как DID, обновляем репутацию
      Reputation.incrementArtifacts(author);
    } else if (req.body.did) {
      // Если DID передан отдельно
      Reputation.incrementArtifacts(req.body.did);
      Reputation.createDID(req.body.did); // на всякий случай
    }

    res.status(201).json({ 
      success: true, 
      data: { id, author: cleanAuthor, type, title: cleanTitle, description: cleanDesc, filePath },
      experience: experienceGained 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
