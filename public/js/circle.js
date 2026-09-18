let circleSocket = null;
let localStream = null;
let peers = {};

async function getMedia() { if (localStream) return localStream; try { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); return localStream; } catch(e) { console.error('getMedia error:', e); return null; } }
function createPeer(targetId, stream) { const peer = new window.SimplePeer({ initiator: true, stream }); peer.on('signal', data => circleSocket?.emit('call-offer', { to: targetId, signal: data })); peer.on('stream', remoteStream => { let container = document.getElementById('p2pVideoContainer'); if (!container) return; let videoEl = document.getElementById('remoteVideo-' + targetId); if (!videoEl) { videoEl = document.createElement('video'); videoEl.id = 'remoteVideo-' + targetId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.style.width = '100%'; videoEl.style.borderRadius = '12px'; container.appendChild(videoEl); } videoEl.srcObject = remoteStream; }); peer.on('close', () => removePeer(targetId)); peer.on('error', err => console.error('Peer error:', err)); peers[targetId] = peer; return peer; }
function answerPeer(fromId, offerSignal, stream) { const peer = new window.SimplePeer({ initiator: false, stream }); peer.on('signal', data => circleSocket?.emit('call-answer', { to: fromId, signal: data })); peer.on('stream', remoteStream => { let container = document.getElementById('p2pVideoContainer'); if (!container) return; let videoEl = document.getElementById('remoteVideo-' + fromId); if (!videoEl) { videoEl = document.createElement('video'); videoEl.id = 'remoteVideo-' + fromId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.style.width = '100%'; videoEl.style.borderRadius = '12px'; container.appendChild(videoEl); } videoEl.srcObject = remoteStream; }); peer.on('close', () => removePeer(fromId)); peer.on('error', err => console.error('Peer error:', err)); peer.signal(offerSignal); peers[fromId] = peer; return peer; }
function removePeer(peerId) { if (peers[peerId]) { peers[peerId].destroy(); delete peers[peerId]; } const videoEl = document.getElementById('remoteVideo-' + peerId); if (videoEl) videoEl.remove(); }
function endAllCalls() { Object.keys(peers).forEach(id => removePeer(id)); if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; } const container = document.getElementById('p2pVideoContainer'); if (container) container.innerHTML = ''; document.getElementById('startCallBtn').style.display = 'inline-block'; document.getElementById('hangupCallBtn').style.display = 'none'; }

function injectP2PUI() {
  const chatDiv = document.getElementById('circleChat');
  if (!chatDiv || chatDiv.style.display === 'none') return;
  if (document.getElementById('p2pBlock')) return;
  const p2pDiv = document.createElement('div');
  p2pDiv.id = 'p2pBlock';
  p2pDiv.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
      <button id="startCallBtn">📞</button>
      <button id="hangupCallBtn" style="display:none;">Завершить</button>
      <select id="peerSelect" style="background:rgba(0,0,0,0.4);border:1px solid #ff5500;border-radius:8px;padding:0.4rem;color:#fff;font-size:0.8rem;"></select>
      <input type="file" id="fileInput" style="display:none;" />
      <button id="sendFileBtn">📎</button>
    </div>
    <div id="callStatus" style="color:#ffb380;font-size:0.8rem;margin-top:0.3rem;"></div>
    <div id="p2pVideoContainer"></div>
  `;
  chatDiv.insertBefore(p2pDiv, document.getElementById('circleMessages'));
  document.getElementById('startCallBtn').addEventListener('click', async () => { const peerId = document.getElementById('peerSelect').value; if (!peerId) return alert('Выберите собеседника'); const stream = await getMedia(); if (!stream) return; createPeer(peerId, stream); document.getElementById('startCallBtn').style.display = 'none'; document.getElementById('hangupCallBtn').style.display = 'inline-block'; document.getElementById('callStatus').textContent = 'Звонок...'; });
  document.getElementById('hangupCallBtn').addEventListener('click', endAllCalls);
  document.getElementById('sendFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', () => { const targetId = document.getElementById('peerSelect').value; if (!targetId) return alert('Выберите собеседника'); const file = document.getElementById('fileInput').files[0]; if (!file) return; const peer = peers[targetId]; if (!peer) return alert('Сначала позвоните'); const reader = new FileReader(); reader.onload = () => peer.send(JSON.stringify({ type: 'file', name: file.name, data: reader.result })); reader.readAsDataURL(file); });
  circleSocket?.on('room-users', users => { const select = document.getElementById('peerSelect'); if (!select) return; select.innerHTML = '<option value="">-- собеседник --</option>'; users.forEach(u => { const opt = document.createElement('option'); opt.value = u.id; opt.textContent = u.name; select.appendChild(opt); }); });
  circleSocket?.on('call-offer', async data => { if (confirm(`${data.name} звонит. Принять?`)) { const stream = await getMedia(); if (!stream) return; answerPeer(data.from, data.signal, stream); document.getElementById('startCallBtn').style.display = 'none'; document.getElementById('hangupCallBtn').style.display = 'inline-block'; document.getElementById('callStatus').textContent = 'Разговор...'; } });
  circleSocket?.on('call-answer', data => peers[data.from]?.signal(data.signal));
  circleSocket?.on('ice-candidate', data => peers[data.from]?.signal(data.candidate));
  circleSocket?.on('peer-disconnected', id => removePeer(id));
}

function attachCircleEvents() {
  const joinBtn = document.getElementById('joinCircleBtn'), leaveBtn = document.getElementById('leaveCircleBtn'), sendBtn = document.getElementById('sendCircleMsgBtn'), msgInput = document.getElementById('circleMessageInput'), nameInput = document.getElementById('circleName'), roomSelect = document.getElementById('circleRoom'), loginDiv = document.getElementById('circleLogin'), chatDiv = document.getElementById('circleChat');
  if (joinBtn) { joinBtn.addEventListener('click', () => { const name = nameInput.value.trim() || 'Странник'; const room = roomSelect.value; if (!circleSocket) { circleSocket = io(); circleSocket.on('message', msg => { const div = document.getElementById('circleMessages'); if (!div) return; const isPhoenix = msg.from === 'Феникс'; const row = document.createElement('div'); row.style.marginBottom = '0.5rem'; if (isPhoenix) { row.style.textAlign = 'center'; row.style.color = '#ffb380'; row.style.fontStyle = 'italic'; } row.innerHTML = `${isPhoenix ? '' : '<strong style="color:#ffb380;">' + msg.from + ':</strong> '}${msg.text}<small style="color:#aa8c7a;margin-left:0.5rem;">${msg.time}</small>`; div.appendChild(row); div.scrollTop = div.scrollHeight; }); circleSocket.on('onlineCount', c => { const ind = document.getElementById('onlineIndicator'); if (ind) { ind.textContent = `${c} в круге`; } }); } circleSocket.emit('joinCircle', { name, room }); loginDiv.style.display = 'none'; chatDiv.style.display = 'block'; injectP2PUI(); }); }
  if (leaveBtn) { leaveBtn.addEventListener('click', () => { if (circleSocket) { circleSocket.disconnect(); circleSocket = null; } loginDiv.style.display = 'block'; chatDiv.style.display = 'none'; document.getElementById('circleMessages').innerHTML = ''; const p2p = document.getElementById('p2pBlock'); if (p2p) p2p.remove(); }); }
  if (sendBtn && msgInput) { const sendMessage = () => { const text = msgInput.value.trim(); if (!text || !circleSocket) return; circleSocket.emit('circleMessage', { text }); msgInput.value = ''; }; sendBtn.addEventListener('click', sendMessage); msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); }); }
}
