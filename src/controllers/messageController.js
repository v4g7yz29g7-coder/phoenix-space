const Message = require('../models/Message');

exports.sendOfflineMessage = (req, res) => {
  try {
    const { recipientDid, encryptedData, senderName } = req.body;
    if (!recipientDid || !encryptedData) {
      return res.status(400).json({ success: false, error: 'recipientDid и encryptedData обязательны' });
    }
    Message.store(recipientDid, encryptedData, senderName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getPendingMessages = (req, res) => {
  try {
    const { did } = req.query;
    if (!did) {
      return res.status(400).json({ success: false, error: 'did обязателен' });
    }
    const messages = Message.getPending(did);
    // Отмечаем как доставленные
    messages.forEach(msg => Message.markDelivered(msg.id));
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
