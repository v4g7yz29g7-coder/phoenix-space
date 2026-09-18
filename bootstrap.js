const WebSocket = require('ws');
const PORT = 8081;

const nodes = new Map(); // id -> { name, url, joinedAt }

const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', (ws) => {
  let nodeInfo = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        nodeInfo = {
          id: msg.id || 'unknown',
          name: msg.name || 'Безымянный Сад',
          url: msg.url || '',
          joinedAt: new Date().toISOString()
        };
        nodes.set(nodeInfo.id, nodeInfo);
        console.log(`🌿 Сад зарегистрирован: ${nodeInfo.name} (${nodeInfo.url})`);
        // Отправляем обновлённый список всем
        broadcastNodeList();
      } else if (msg.type === 'list') {
        // Клиент запросил список
        ws.send(JSON.stringify({ type: 'nodeList', nodes: Array.from(nodes.values()) }));
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    if (nodeInfo) {
      nodes.delete(nodeInfo.id);
      console.log(`🍂 Сад отключился: ${nodeInfo.name}`);
      broadcastNodeList();
    }
  });
});

function broadcastNodeList() {
  const list = JSON.stringify({ type: 'nodeList', nodes: Array.from(nodes.values()) });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(list);
  });
}

console.log(`🐦‍🔥 Bootstrap-узел слушает порт ${PORT}`);
