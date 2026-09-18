const { z } = require('zod');
const Seed = require('../models/Seed');
const { escapeHtml } = require('../utils/sanitize');

const seedSchema = z.object({
  message: z.string().min(1).max(500)
});

exports.getAllSeeds = (req, res) => {
  try {
    const seeds = Seed.getAll();
    res.json({ success: true, data: seeds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createSeed = (req, res) => {
  try {
    const { message } = seedSchema.parse(req.body);
    const cleanMessage = escapeHtml(message);
    const result = Seed.create(cleanMessage);
    res.status(201).json({ success: true, data: { id: result.lastInsertRowid, message: cleanMessage } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Текст семени должен быть от 1 до 500 символов.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};
