const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8081');

ws.on('open', () => {
  console.log('🧪 Тестовый Сад подключился к Bootstrap');
  ws.send(JSON.stringify({
    type: 'register',
    id: 'test-garden-1',
    name: '🌸 Сад Брата (тест)',
    url: 'test.local'
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'nodeList') {
    console.log('Текущая сеть:', msg.nodes.map(n => n.name).join(', '));
  }
});

ws.on('close', () => console.log('🧪 Тестовый Сад отключился'));
console.log('Запущен тестовый узел. Нажми Ctrl+C для остановки.');
