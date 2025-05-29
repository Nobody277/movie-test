document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  const isMobile          = /Mobi|Android|iPhone/.test(navigator.userAgent);

  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');

  // state & timing
  let initState         = { currentTime: 0, paused: true, lastUpdate: Date.now(), videoUrl: '' };
  let latency           = 0;
  let syncIntervalId    = null;
  let stateSyncInterval = null;
  let statsIntervalId   = null;
  let hls               = null;
  let currentSrc        = '';

  // generate a Guest username
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // join the room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  // ping/pong latency check
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });

  // chat send / receive
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

  // stats updates
  socket.on('stats', arr => {
    statsList.innerHTML = '';
    arr.forEach(p => {
      const m = Math.floor(p.time / 60);
      const s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  // handle initial state from server
  socket.on('init', state => {
    initState = { ...state };

    // update title/meta
    if (state.title) {
      const full = `Movie Night - ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load or HLS-attach the stream
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

    // initial sync once video can play
    ping();
    player.pause();
    const onCanPlay = () => {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const target  = initState.currentTime + (initState.paused ? 0 : elapsed);
      player.currentTime = target;
      initState.paused ? player.pause() : player.play();

      setupUserEvents();
      setupRemoteEvents();
      startSyncLoop();
      startStatsLoop();

      player.removeEventListener('canplay', onCanPlay);
    };
    player.addEventListener('canplay', onCanPlay, { once: true });
  });

  // user → server controls
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
  }

  // server → user controls
  function setupRemoteEvents() {
    socket.off('seek').on('seek', data => {
      initState.currentTime = data.time;
      initState.lastUpdate  = Date.now();
      player.currentTime    = data.time;
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
  }

  // authoritative sync loop
  function startSyncLoop() {
    // clear any existing loops
    if (syncIntervalId)    clearInterval(syncIntervalId);
    if (stateSyncInterval) clearInterval(stateSyncInterval);

    syncIntervalId = setInterval(() => {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff   = serverTime - player.currentTime;

      if (Math.abs(diff) > 0.5) {
        player.currentTime = serverTime;
        player.playbackRate = 1;
      } else {
        player.playbackRate = Math.min(1.05, Math.max(0.95, 1 + diff * 0.1));
      }
    }, 1000);

    stateSyncInterval = setInterval(() => {
      socket.emit('getState', { roomId });
    }, 5000);

    socket.off('syncState').on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;

      if (s.paused && !player.paused) player.pause();
      else if (!s.paused && player.paused) player.play();
    });
  }

  // periodic stats reporting
  function startStatsLoop() {
    if (statsIntervalId) clearInterval(statsIntervalId);
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