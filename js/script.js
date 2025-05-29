document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  const isMobile          = /Mobi|Android|iPhone/.test(navigator.userAgent);

  // UI refs
  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');

  // 1) Random Guest username
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // 2) Join the room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  // 3) Latency ping/pong
  let latency = 0;
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });

  // 4) Chat send/receive
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

  // 5) Stats & gated sync
  let syncing = false;
  socket.on('stats', arr => {
    // render stats list
    statsList.innerHTML = '';
    arr.forEach(p => {
      const m = Math.floor(p.time / 60),
            s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });

    // only start the desktop sync loop once we have >1 viewer
    if (!isMobile && arr.length > 1 && !syncing) {
      syncing = true;
      startSyncLoop();
    }
  });

  // 6) Handle initial state
  let initState = null;
  socket.on('init', state => {
    initState = state;

    // update page title and Open Graph
    if (state.title) {
      const full = `Movie Night - ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load or HLS‑attach video
    let hls, currentSrc = '';
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

    // sync to server time, then bind events
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now     = Date.now();
      const elapsed = (now - state.lastUpdate - latency) / 1000;
      const target  = state.currentTime + (state.paused ? 0 : elapsed);

      player.currentTime = target;
      state.paused ? player.pause() : player.play();

      bindUserEvents();
      bindRemoteEvents();
      startStatsLoop();
    }, { once: true });
  });

  // 7) User‑initiated controls (only when e.isTrusted)
  function bindUserEvents() {
    player.addEventListener('seeked', e => {
      if (!e.isTrusted) return;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    player.addEventListener('play', e => {
      if (!e.isTrusted) return;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      initState.paused      = false;
      socket.emit('play', { roomId, time: player.currentTime });
    });
    player.addEventListener('pause', e => {
      if (!e.isTrusted) return;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      initState.paused      = true;
      socket.emit('pause', { roomId, time: player.currentTime });
    });

    // desktop arrow‑key ±5 sec
    window.addEventListener('keydown', e => {
      if (isMobile) return;
      if (document.activeElement === chatInput) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowLeft' ? -5 : +5;
        player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + delta));
        initState.currentTime = player.currentTime;
        initState.lastUpdate  = Date.now();
        socket.emit('seek', { roomId, time: player.currentTime });
      }
    }, { capture: true });
  }

  // 8) Remote updates from other viewers
  function bindRemoteEvents() {
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

  // 9) Smooth‑sync loop (desktop only, starts once stats>1)
  function startSyncLoop() {
    const SYNC_INTERVAL  = 1000;
    const HARD_THRESHOLD = 1.0;
    const NUDGE_FACTOR   = 0.1;
    const MIN_RATE       = 0.95;
    const MAX_RATE       = 1.05;

    setInterval(() => {
      const now        = Date.now();
      const elapsed    = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff       = serverTime - player.currentTime;

      if (Math.abs(diff) > HARD_THRESHOLD) {
        player.currentTime = serverTime;
      } else {
        player.playbackRate = Math.min(
          MAX_RATE,
          Math.max(MIN_RATE, 1 + diff * NUDGE_FACTOR)
        );
      }
    }, SYNC_INTERVAL);

    // periodic authoritative pull
    setInterval(() => {
      socket.emit('getState', { roomId });
    }, SYNC_INTERVAL * 5);

    socket.on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      s.paused ? player.pause() : player.play();
    });
  }

  // 10) Broadcast your stats every second
  function startStatsLoop() {
    setInterval(() => {
      socket.emit('statsUpdate', {
        username,
        latency,
        time:      player.currentTime,
        platform:  isMobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }
});