// script.js
document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket = io(SOCKET_SERVER_URL);
  const isMobile = /Mobi|Android|iPhone/.test(navigator.userAgent);

  const player = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // Skip ±10s with arrow keys (unless focus is in chat)
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === chatInput) return;
    if (e.key === 'ArrowRight') {
      player.currentTime = Math.min(player.duration, player.currentTime + 10);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      player.currentTime = Math.max(0, player.currentTime - 10);
      e.preventDefault();
    }
  });

  // Join room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  let latency = 0;
  let roomState = null;

  // Latency measurement
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });

  // Chat helpers
  function appendMsg(user, text) {
    const d = document.createElement('div');
    d.className = 'chatMessage';
    d.innerHTML = `<span class="user">${user}:</span> ${text}`;
    chatMsgs.append(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    appendMsg(username, msg);
    socket.emit('chat', { roomId, msg, username });
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
  socket.on('chat', (data) => appendMsg(data.username, data.msg));

  // Participants stats
  socket.on('stats', (arr) => {
    statsList.innerHTML = '';
    arr.forEach((p) => {
      const m = Math.floor(p.time / 60);
      const s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  // Receive initial state
  socket.on('init', (state) => {
    roomState = state;

    // Update document title
    if (state.title) {
      const full = `Movie Night – ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // Load video or HLS
    let hls = null;
    let currentSrc = '';
    if (state.videoUrl !== currentSrc) {
      currentSrc = state.videoUrl;
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (currentSrc.endsWith('.m3u8') && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(currentSrc);
        hls.attachMedia(player);
      } else {
        player.src = currentSrc;
      }
    }

    // Synchronize playback
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now = Date.now();
      const elapsed = (now - roomState.lastUpdate - latency) / 1000;
      const target = roomState.currentTime + (roomState.paused ? 0 : elapsed);
      player.currentTime = target;
      roomState.paused ? player.pause() : player.play();

      setupUserEvents();
      setupServerEvents();
      startSyncLoop();
      startStatsLoop();
    }, { once: true });
  });

  function setupUserEvents() {
    player.addEventListener('seeked', (e) => {
      if (!e.isTrusted) return;
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    player.addEventListener('play', (e) => {
      if (!e.isTrusted) return;
      socket.emit('play', { roomId, time: player.currentTime });
    });
    player.addEventListener('pause', (e) => {
      if (!e.isTrusted) return;
      socket.emit('pause', { roomId, time: player.currentTime });
    });
  }

  function setupServerEvents() {
    socket.on('seek', (data) => {
      roomState.currentTime = data.time;
      roomState.lastUpdate = Date.now();
      player.currentTime = data.time;
    });
    socket.on('play', (data) => {
      roomState.currentTime = data.time;
      roomState.paused = false;
      roomState.lastUpdate = Date.now();
      player.play();
    });
    socket.on('pause', (data) => {
      roomState.currentTime = data.time;
      roomState.paused = true;
      roomState.lastUpdate = Date.now();
      player.pause();
    });
  }

  function startSyncLoop() {
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - roomState.lastUpdate - latency) / 1000;
      const serverTime = roomState.currentTime + (roomState.paused ? 0 : elapsed);
      const diff = serverTime - player.currentTime;

      if (Math.abs(diff) > 1.0) {
        player.currentTime = serverTime;
      } else {
        player.playbackRate = Math.min(1.05, Math.max(0.95, 1 + diff * 0.1));
      }
    }, 1000);

    setInterval(() => {
      socket.emit('getState', { roomId });
    }, 5000);

    socket.on('syncState', (s) => {
      roomState.currentTime = s.currentTime;
      roomState.paused      = s.paused;
      roomState.lastUpdate  = s.lastUpdate;
      if (s.paused !== player.paused) {
        s.paused ? player.pause() : player.play();
      }
    });
  }

  function startStatsLoop() {
    setInterval(() => {
      socket.emit('statsUpdate', {
        username,
        latency,
        time: player.currentTime,
        platform: isMobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }
});