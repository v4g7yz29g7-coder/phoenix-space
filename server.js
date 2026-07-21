require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const ethers = require('ethers');
const { generalLimiter } = require('./src/middleware/rateLimiter');
const { auditLogger } = require('./src/middleware/audit');
const Reputation = require('./src/models/Reputation');
const { checkAccess } = require('./src/middleware/security');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(generalLimiter);
app.use(auditLogger);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', require('./src/routes/api'));
app.use("/api/profile", require("./src/routes/profile"));

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/constitution", (req, res) => res.sendFile(path.join(__dirname, "public", "constitution.html")));
app.get("/constitution", (req, res) => res.sendFile(path.join(__dirname, "public", "constitution.html")));
app.get("/constitution", (req, res) => res.sendFile(path.join(__dirname, "public", "constitution.html")));
app.get("/profile", (req, res) => {
  if (Object.keys(req.query).length === 0) {
    return res.sendFile(path.join(__dirname, "public", "profile.html"));
  }
  next();
});
app.get("/license", (req, res) => res.sendFile(path.join(__dirname, "public", "license.html")));
app.get("/profile", (req, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));
app.get("/support", (req, res) => res.sendFile(path.join(__dirname, "public", "support.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin.html", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin.html", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/profile", (req, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));
app.get("/bounties", (req, res) => res.sendFile(path.join(__dirname, "public", "bounties.html")));
app.get("/community", (req, res) => res.sendFile(path.join(__dirname, "public", "community.html")));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('🔥 Соратник подключился:', socket.id);

  socket.on('authenticateDID', (data) => {
    try {
      const recoveredAddress = ethers.verifyMessage('Войти в Круг', data.signature);
      if (recoveredAddress.toLowerCase() === data.address.toLowerCase()) {
        socket.didAddress = data.address;
        Reputation.createDID(data.address);
        socket.emit('authenticated', { success: true, address: data.address });
      } else {
        socket.emit('authenticated', { success: false, error: 'Неверная подпись' });
      }
    } catch (e) {
      socket.emit('authenticated', { success: false, error: e.message });
    }
  });

  socket.on('joinCircle', (userData) => {
    const did = socket.didAddress;
    const rep = did ? Reputation.getByDID(did) : null;
    const user = {
      id: socket.id,
      name: userData.name || 'Странник',
      room: userData.room || 'общий',
      did,
      status: rep ? rep.status : 'newcomer',
      joinedAt: new Date()
    };
    onlineUsers.set(socket.id, user);
    socket.join(user.room);
    socket.emit('message', { from: 'Феникс', text: `Добро пожаловать в Круг, ${user.name}.`, time: new Date().toLocaleTimeString() });
    socket.to(user.room).emit('message', { from: 'Феникс', text: `${user.name} вошёл в круг.`, time: new Date().toLocaleTimeString() });
    io.to(user.room).emit('onlineCount', getOnlineCount(user.room));
    io.to(user.room).emit('room-users', getRoomUsers(user.room));
  });

  socket.on('circleMessage', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    let verified = false;
    if (user.did && data.signature && data.text) {
      try {
        const recoveredAddress = ethers.verifyMessage(data.text, data.signature);
        if (recoveredAddress.toLowerCase() === user.did.toLowerCase()) verified = true;
      } catch(e) {}
    }
    io.to(user.room).emit('message', {
      from: user.name, text: data.text, time: new Date().toLocaleTimeString(), did: user.did, verified
    });
  });

  socket.on('call-offer', (data) => {
    if (!checkAccess(socket, 'call-offer')) {
      socket.emit('error-notification', 'Ваш уровень доступа не позволяет совершать звонки. Пройдите практики.');
      return;
    }
    io.to(data.to).emit('call-offer', { from: socket.id, signal: data.signal, name: onlineUsers.get(socket.id)?.name });
  });

  socket.on('call-answer', (data) => io.to(data.to).emit('call-answer', { from: socket.id, signal: data.signal }));
  socket.on('ice-candidate', (data) => io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate }));

  socket.on('private-message', (data) => {
    if (!checkAccess(socket, 'private-message')) {
      socket.emit('error-notification', 'Личные сообщения недоступны для вашего уровня.');
      return;
    }
    const sender = onlineUsers.get(socket.id);
    if (!sender || !data.to) return;
    io.to(data.to).emit('private-message', { from: sender.name, fromId: socket.id, text: data.text, time: new Date().toLocaleTimeString() });
    socket.emit('private-message', { from: sender.name, fromId: socket.id, to: data.to, text: data.text, time: new Date().toLocaleTimeString(), sent: true });
  });

  socket.on('report-user', (data) => {
    const reporter = onlineUsers.get(socket.id);
    if (!reporter || !reporter.did) return;
    const success = Reputation.addComplaint(reporter.did, data.targetDid, data.reason);
    if (success) {
      socket.emit('message', { from: 'Феникс', text: 'Жалоба отправлена. Спасибо за бдительность.', time: new Date().toLocaleTimeString() });
      // Проверяем, не забанен ли теперь target
      const targetRep = Reputation.getByDID(data.targetDid);
      if (targetRep && targetRep.status === 'banned') {
        // Находим сокет цели и отключаем
        for (let [id, u] of onlineUsers.entries()) {
          if (u.did === data.targetDid) {
            const targetSocket = io.sockets.sockets.get(id);
            if (targetSocket) {
              targetSocket.emit('banned', 'Ваш аккаунт заблокирован из-за жалоб.');
              targetSocket.disconnect(true);
            }
          }
        }
      }
    } else {
      socket.emit('message', { from: 'Феникс', text: 'Вы уже отправляли жалобу на этого пользователя.', time: new Date().toLocaleTimeString() });
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      io.to(user.room).emit('message', { from: 'Феникс', text: `${user.name} покинул круг.`, time: new Date().toLocaleTimeString() });
      onlineUsers.delete(socket.id);
      io.to(user.room).emit('onlineCount', getOnlineCount(user.room));
      io.to(user.room).emit('room-users', getRoomUsers(user.room));
    }
  });
});

function getOnlineCount(room) {
  let count = 0;
  onlineUsers.forEach(u => { if (u.room === room) count++; });
  return count;
}

function getRoomUsers(room) {
  const users = [];
  onlineUsers.forEach((u, id) => {
    if (u.room === room) users.push({ id, name: u.name, status: u.status });
  });
  return users;
}

// Экспортируем onlineUsers для security.js
module.exports = { onlineUsers };

server.listen(PORT, () => {
  console.log(`🐦‍🔥 Феникс с репутацией запущен на порту ${PORT}`);
});

// ========== РЕГИСТРАЦИЯ В BOOTSTRAP-УЗЛЕ ==========
(function registerInBootstrap() {
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:8081');
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'register',
      id: 'phoenix-main',
      name: 'Сад Архитектора',
      url: 'phoenixsearch.ru'
    }));
    console.log('🌿 Наш Сад зарегистрирован в Bootstrap');
  });
  ws.on('error', () => console.log('Bootstrap-узел пока не доступен'));
})();

// Редирект для /network
app.get('/network', (req, res) => res.redirect('/network.html'));
