// public/js/script.js
document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket     = io(SOCKET_URL);
  const isMobile   = /Mobi|Android|iPhone/.test(navigator.userAgent);

  // UI references
  const player       = document.getElementById('videoPlayer');
  const statsList    = document.getElementById('statsList');
  const chatMsgs     = document.getElementById('chatMessages');
  const chatInput    = document.getElementById('chatInput');
  const sendBtn      = document.getElementById('sendBtn');
  const usernameDisp = document.getElementById('usernameDisplay');

  // 1) Random guest name
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  usernameDisp.textContent = username;

  // 2) Join room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  // 3) Ping/Pong for latency
  let latency = 0;
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });
  function ping() {
    socket.emit('pingCheck', { clientTime: Date.now() });
  }

  // 4) Chat helpers
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

  // 5) Stats + gated sync
  let syncing = false;
  socket.on('stats', list => {
    statsList.innerHTML = '';
    list.forEach(p => {
      const m  = Math.floor(p.time / 60),
            s  = String(Math.floor(p.time % 60)).padStart(2, '0'),
            li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });

    // only start desktop sync when we have >1 viewer and initState is set
    if (!isMobile && initState && list.length > 1 && !syncing) {
      syncing = true;
      startSyncLoop();
    }
  });

  // 6) Handle initial server state
  let initState = null;
  socket.on('init', state => {
    initState = state;

    // update document title & Open Graph
    if (state.title) {
      const full = `Movie Night - ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load video (HLS or direct)
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

    // sync to baseline, then wire up events & stats
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
      // sync loop will auto-start once stats>1
    }, { once: true });
  });

  // 7) User‑driven events (with explicit suppressSeek)
  let suppressSeek = false;
  function bindUserEvents() {
    player.addEventListener('seeked', e => {
      if (suppressSeek) { suppressSeek = false; return; }
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

    // override desktop arrow-key skip to ±5 sec
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

  // 8) Remote events from peers
  function bindRemoteEvents() {
    socket.on('seek', data => {
      initState.currentTime = data.time;
      initState.lastUpdate  = Date.now();
      suppressSeek = true;
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

  // 9) Smooth‑sync loop (desktop only)
  function startSyncLoop() {
    const INTERVAL      = 1000;
    const THRESHOLD     = 1.0;
    const NUDGE_FACTOR  = 0.1;
    const MIN_RATE      = 0.95;
    const MAX_RATE      = 1.05;

    setInterval(() => {
      const now        = Date.now();
      const elapsed    = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff       = serverTime - player.currentTime;

      if (Math.abs(diff) > THRESHOLD) {
        suppressSeek = true;
        player.currentTime = serverTime;
      } else {
        player.playbackRate = Math.min(
          MAX_RATE,
          Math.max(MIN_RATE, 1 + diff * NUDGE_FACTOR)
        );
      }
    }, INTERVAL);

    // authoritative pull every 5s
    setInterval(() => {
      socket.emit('getState', { roomId });
    }, INTERVAL * 5);

    socket.on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      s.paused ? player.pause() : player.play();
    });
  }

  // 10) Broadcast our stats once a second
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