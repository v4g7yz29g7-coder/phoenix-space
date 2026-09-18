// flag_cli.js — простой CLI: node flag_cli.js green [agent] [reason]
const ioClient = require('socket.io-client');

const [,, flag, agent, reason] = process.argv;
if (!flag) {
  console.log('Usage: node flag_cli.js <green|yellow|blue|red|finish> [agent] [reason]');
  process.exit(1);
}

const FLAGS = {
  green:  { emoji: '🟢', label: 'GREEN'  },
  yellow: { emoji: '🟡', label: 'YELLOW' },
  blue:   { emoji: '🔵', label: 'BLUE'   },
  red:    { emoji: '🔴', label: 'RED'    },
  finish: { emoji: '🏁', label: 'FINISH' },
};

const f = FLAGS[flag];
if (!f) {
  console.log('❌ Неизвестный флаг:', flag);
  process.exit(1);
}

const socket = ioClient('http://127.0.0.1:3020', {
  transports: ['polling'],
  reconnection: false,
});

socket.on('connect', () => {
  socket.emit('flag:event', {
    type: 'flag',
    flag,
    emoji: f.emoji,
    label: f.label,
    msg: reason || f.label,
    agent: agent || null,
    reason: reason || null,
    race_id: 'test_' + Date.now(),
    ts: Date.now(),
  });
  console.log(`${f.emoji} FLAG ${f.label}` + (agent ? ` → ${agent}` : '') + (reason ? ` (${reason})` : ''));
  setTimeout(() => process.exit(0), 800);
});

socket.on('connect_error', (e) => {
  console.log('❌ connect_error:', e.message);
  process.exit(1);
});
