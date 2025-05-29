// public/js/script.js
document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket = io(SOCKET_SERVER_URL);
  const isMobile = /Mobi|Android|iPhone/.test(navigator.userAgent);

  // DOM elements
  const player       = document.getElementById('videoPlayer');
  const statsList    = document.getElementById('statsList');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput    = document.getElementById('chatInput');
  const sendBtn      = document.getElementById('sendBtn');
  const usernameDisp = document.getElementById('usernameDisplay');

  // Username & room
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  usernameDisp.textContent = username;
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMessages.innerHTML = '<em>No room specified.</em>';
    return;
  }

  // State
  let latency    = 0;
  let roomState  = null;
  const SYNC_INTERVAL          = 1000;
  const STATE_REQUEST_INTERVAL = 5000;
  const STATS_INTERVAL         = 1000;

  // Helpers
  const ping = () => {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  };
  const appendChatMessage = (user, msg) => {
    const div = document.createElement('div');
    div.className = 'chatMessage';
    div.innerHTML = `<span class="user">${user}:</span> ${msg}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  // Socket handlers
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });
  socket.on('chat', data => appendChatMessage(data.username, data.msg));
  socket.on('stats', participants => {
    statsList.innerHTML = '';
    participants.forEach(p => {
      const mm = Math.floor(p.time / 60);
      const ss = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${mm}:${ss}`;
      statsList.appendChild(li);
    });
  });

  socket.on('init', state => {
    roomState = state;

    // Update title & OG
    if (state.title) {
      const full = `Movie Night – ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // Load source (HLS vs MP4)
    let hls       = null;
    let currentSrc = '';
    if (state.videoUrl !== currentSrc) {
      currentSrc = state.videoUrl;
      if (hls) { hls.destroy(); hls = null; }
      if (currentSrc.endsWith('.m3u8') && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(currentSrc);
        hls.attachMedia(player);
      } else {
        player.src = currentSrc;
      }
    }

    // Initial sync when ready
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now     = Date.now();
      const elapsed = (now - roomState.lastUpdate - latency) / 1000;
      const target  = roomState.currentTime + (roomState.paused ? 0 : elapsed);

      player.currentTime = target;
      state.paused ? player.pause() : player.play();

      // User‑initiated events
      player.addEventListener('seeked', e => {
        if (!e.isTrusted) return;
        socket.emit('seek', { roomId, time: player.currentTime });
      });
      player.addEventListener('play',   e => {
        if (!e.isTrusted) return;
        socket.emit('play', { roomId, time: player.currentTime });
      });
      player.addEventListener('pause',  e => {
        if (!e.isTrusted) return;
        socket.emit('pause', { roomId, time: player.currentTime });
      });

      // Server‑driven updates
      socket.on('seek', data => {
        roomState.currentTime = data.time;
        roomState.lastUpdate  = Date.now();
        player.currentTime    = data.time;
      });
      socket.on('play', data => {
        roomState.currentTime = data.time;
        roomState.paused      = false;
        roomState.lastUpdate  = Date.now();
        player.play();
      });
      socket.on('pause', data => {
        roomState.currentTime = data.time;
        roomState.paused      = true;
        roomState.lastUpdate  = Date.now();
        player.pause();
      });

      // Sync loop
      setInterval(() => {
        const now     = Date.now();
        const elapsed = (now - roomState.lastUpdate - latency) / 1000;
        const serverTime = roomState.currentTime + (roomState.paused ? 0 : elapsed);
        const diff       = serverTime - player.currentTime;

        if (Math.abs(diff) > 1) {
          player.currentTime = serverTime;
        } else {
          player.playbackRate = Math.min(1.05, Math.max(0.95, 1 + diff * 0.1));
        }
      }, SYNC_INTERVAL);

      // Periodic state request
      setInterval(() => {
        socket.emit('getState', { roomId });
      }, STATE_REQUEST_INTERVAL);
      socket.on('syncState', s => {
        roomState.currentTime = s.currentTime;
        roomState.paused      = s.paused;
        roomState.lastUpdate  = s.lastUpdate;
        if (s.paused !== player.paused) {
          s.paused ? player.pause() : player.play();
        }
      });

      // Stats reporting
      setInterval(() => {
        socket.emit('statsUpdate', {
          username,
          latency,
          time: player.currentTime,
          platform: isMobile ? 'mobile' : 'desktop'
        });
      }, STATS_INTERVAL);

    }, { once: true });
  });

  // Now that handlers are in place, join
  socket.emit('joinRoom', { roomId, username });

  // Chat input
  sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    appendChatMessage(username, msg);
    socket.emit('chat', { roomId, msg, username });
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendBtn.click();
  });

  // ←→ Arrow keys: skip ±10s and sync immediately
  document.addEventListener('keydown', e => {
    if (document.activeElement === chatInput) return;
    let newTime = null;
    if (e.key === 'ArrowRight') {
      newTime = Math.min(player.duration, player.currentTime + 10);
    } else if (e.key === 'ArrowLeft') {
      newTime = Math.max(0, player.currentTime - 10);
    }
    if (newTime !== null) {
      player.currentTime = newTime;
      socket.emit('seek', { roomId, time: newTime });
      e.preventDefault();
    }
  });
});