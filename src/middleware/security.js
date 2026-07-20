const Reputation = require('../models/Reputation');

function checkAccess(socket, event) {
  const user = require('../../server').onlineUsers?.get(socket.id);
  if (!user || !user.did) return false;

  const rep = Reputation.getByDID(user.did) || { status: 'newcomer' };

  if (rep.status === 'banned') return false;

  if (event === 'call-offer' || event === 'send-file' || event === 'private-message') {
    // Новичкам запрещены звонки и файлы
    if (rep.status === 'newcomer' || Reputation.isNewcomer(user.did)) return false;
  }

  return true;
}

module.exports = { checkAccess };
