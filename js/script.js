document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  const isMobile          = /Mobi|Android|iPhone/.test(navigator.userAgent);

  // UI refs
  const player     = document.getElementById('videoPlayer');
  const statsList  = document.getElementById('statsList');
  const chatMsgs   = document.getElementById('chatMessages');
  const chatInput  = document.getElementById('chatInput');
  const sendBtn    = document.getElementById('sendBtn');

  // State globals
  let initState    = { currentTime: 0, paused: true, lastUpdate: 0, title: null };
  let latency      = 0;
  let hls          = null;
  let currentSrc   = '';

  // Pick a random Guest username
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // Join room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  // Ping/pong for latency measurement
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
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendBtn.click();
  });
  socket.on('chat', data => appendMsg(data.username, data.msg));

  // Stats panel
  socket.on('stats', arr => {
    statsList.innerHTML = '';
    arr.forEach(p => {
      const m = Math.floor(p.time / 60),
            s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  // INITIAL STATE from server
  socket.on('init', state => {
    // Save for sync logic
    initState = {
      currentTime: state.currentTime,
      paused:      state.paused,
      lastUpdate:  state.lastUpdate,
      title:       state.title || null
    };

    // Update tab/OG title
    if (initState.title) {
      const full = `Movie Night – ${initState.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // Load video (HLS or direct)
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

    // Sync to server time & play/pause
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const target  = initState.currentTime + (initState.paused ? 0 : elapsed);

      player.currentTime = target;
      if (initState.paused) player.pause();
      else                   player.play();

      // Wire up handlers once video is ready
      setupUserEvents();
      setupRemoteEvents();
      startSyncLoop();
      startStatsLoop();
    }, { once: true });
  });

  // USER events → emit only on trusted (real) user actions
  function setupUserEvents() {
    player.addEventListener('seeked', e => {
      if (!e.isTrusted) return;
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    player.addEventListener('play', e => {
      if (!e.isTrusted) return;
      socket.emit('play', { roomId, time: player.currentTime });
    });
    player.addEventListener('pause', e => {
      if (!e.isTrusted) return;
      socket.emit('pause', { roomId, time: player.currentTime });
    });

    // ← Arrow keys for ±10 s seeking
    document.addEventListener('keydown', e => {
      if (document.activeElement === chatInput) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        player.currentTime = Math.max(0, player.currentTime - 10);
        socket.emit('seek', { roomId, time: player.currentTime });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        player.currentTime = Math.min(player.duration, player.currentTime + 10);
        socket.emit('seek', { roomId, time: player.currentTime });
      }
    });
  }

  // REMOTE events → update initState + player without re‑emitting
  function setupRemoteEvents() {
    socket.on('seek', data => {
      initState.currentTime = data.time;
      initState.lastUpdate  = Date.now();
      player.currentTime    = data.time;
    });
    socket.on('play', data => {
      initState.currentTime = data.time;
      initState.paused      = false;
      initState.lastUpdate  = Date.now();
      player.play();
    });
    socket.on('pause', data => {
      initState.currentTime = data.time;
      initState.paused      = true;
      initState.lastUpdate  = Date.now();
      player.pause();
    });
  }

  // Sync loop to gently nudge clients toward server time
  function startSyncLoop() {
    setInterval(() => {
      // if paused, skip any sync adjustments
      if (initState.paused) return;

      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + elapsed;
      const diff = serverTime - player.currentTime;

      if (Math.abs(diff) > 1.0) {
        // big jump
        player.currentTime = serverTime;
      } else {
        // small nudge
        player.playbackRate = Math.min(
          1.05,
          Math.max(0.95, 1 + diff * 0.1)
        );
      }
    }, 1000);

    // Periodically refresh authoritative state
    setInterval(() => {
      socket.emit('getState', { roomId });
    }, 5000);

    socket.on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      // apply new pause/play if needed
      if (s.paused !== player.paused) {
        s.paused ? player.pause() : player.play();
      }
    });
  }

  // Stats broadcast every second
  function startStatsLoop() {
    setInterval(() => {
      socket.emit('statsUpdate', {
        username,
        latency,
        time:     player.currentTime,
        platform: isMobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }
});