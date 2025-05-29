// public/js/script.js

document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  const isMobile          = /Mobi|Android|iPhone/.test(navigator.userAgent);

  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');

  // client‐side "authoritative" state mirror
  let initState         = { currentTime: 0, paused: true, lastUpdate: Date.now(), videoUrl: '' };
  let latency           = 0;
  let syncIntervalId    = null;
  let stateSyncInterval = null;
  let statsIntervalId   = null;
  let hls               = null;
  let currentSrc        = '';
  let suppressSeekEmit  = false;

  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }

  socket.emit('joinRoom', { roomId, username });

  // ——— Helpers ——————————————————————————————————————————

  // wrap programmatic seeks so we don't emit our own events
  function safeSeek(time) {
    suppressSeekEmit = true;
    player.currentTime = time;
    setTimeout(() => suppressSeekEmit = false, 50);
  }

  // measure round‐trip latency
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }

  // append chat message
  function appendMsg(user, text) {
    const el = document.createElement('div');
    el.className = 'chatMessage';
    el.innerHTML = `<span class="user">${user}:</span> ${text}`;
    chatMsgs.append(el);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  // ——— Chat UI ——————————————————————————————————————————

  sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    appendMsg(username, msg);
    socket.emit('chat', { roomId, msg, username });
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', e => e.key === 'Enter' && sendBtn.click());
  socket.on('chat', data => appendMsg(data.username, data.msg));

  // ——— Latency & Stats ——————————————————————————————————————————

  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });

  socket.on('stats', users => {
    statsList.innerHTML = '';
    users.forEach(p => {
      const m = Math.floor(p.time / 60);
      const s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  // ——— Incoming initialization ——————————————————————————————————————————

  socket.on('init', state => {
    initState = { ...state };

    if (state.title) {
      const full = `Movie Night – ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load or HLS‑attach new source
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

    // initial sync once metadata is ready
    ping();
    player.pause();
    player.addEventListener('canplay', function onCanPlay() {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const target  = initState.currentTime + (initState.paused ? 0 : elapsed);
      safeSeek(target);
      initState.paused ? player.pause() : player.play();

      bindUserControls();
      bindRemoteControls();
      startSyncLoop();
      startStatsLoop();

      player.removeEventListener('canplay', onCanPlay);
    }, { once: true });
  });

  // ——— User → Server events ——————————————————————————————————————————

  function bindUserControls() {
    player.addEventListener('seeked', e => {
      if (suppressSeekEmit || !e.isTrusted) return;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    player.addEventListener('play', e => {
      if (!e.isTrusted) return;
      initState.paused      = false;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      socket.emit('play', { roomId, time: player.currentTime });
    });
    player.addEventListener('pause', e => {
      if (!e.isTrusted) return;
      initState.paused      = true;
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      socket.emit('pause', { roomId, time: player.currentTime });
    });
  }

  // ——— Server → User events ——————————————————————————————————————————

  function bindRemoteControls() {
    socket.off('seek').on('seek', data => {
      initState.currentTime = data.time;
      initState.lastUpdate  = Date.now();
      safeSeek(data.time);
    });
    socket.off('play').on('play', data => {
      initState.currentTime = data.time;
      initState.paused      = false;
      initState.lastUpdate  = Date.now();
      player.play();
    });
    socket.off('pause').on('pause', data => {
      initState.currentTime = data.time;
      initState.paused      = true;
      initState.lastUpdate  = Date.now();
      player.pause();
    });
    socket.off('syncState').on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      s.paused ? player.pause() : player.play();
    });
  }

  // ——— Sync loop ——————————————————————————————————————————

  function startSyncLoop() {
    clearInterval(syncIntervalId);
    clearInterval(stateSyncInterval);

    syncIntervalId = setInterval(() => {
      if (initState.paused) return;  // no drift while paused

      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + elapsed;
      const diff   = serverTime - player.currentTime;

      if (Math.abs(diff) > 0.5) {
        safeSeek(serverTime);
        player.playbackRate = 1;
      } else {
        player.playbackRate = Math.min(1.05, Math.max(0.95, 1 + diff * 0.1));
      }
    }, 1000);

    // refresh authoritative state periodically
    stateSyncInterval = setInterval(() => {
      socket.emit('getState', { roomId });
    }, 5000);
  }

  // ——— Stats reporting ——————————————————————————————————————————

  function startStatsLoop() {
    clearInterval(statsIntervalId);
    statsIntervalId = setInterval(() => {
      socket.emit('statsUpdate', {
        username,
        latency,
        time: player.currentTime,
        platform: isMobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }
});