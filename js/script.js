document.addEventListener('DOMContentLoaded', () => {
  // ← point explicitly at your backend
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket = io(SOCKET_SERVER_URL);

  const isMobile = /Mobi|Android|iPhone/.test(navigator.userAgent);

  // random Guest #n
  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // sync settings
  const SYNC_INTERVAL = 1000,
        HARD_THRESHOLD = 1.0,
        NUDGE = 0.1,
        MIN_RATE = 0.95,
        MAX_RATE = 1.05;

  let hls, currentSrc = '', latency = 0, initState = null;
  let supSeek = false, supPlay = false, supPause = false;

  // UI refs
  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }

  socket.emit('joinRoom', { roomId, username });

  // latency ping/pong
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });

  // chat helpers
  function appendMsg(user, text) {
    const d = document.createElement('div');
    d.className = 'chatMessage';
    d.innerHTML = `<span class="user">${user}:</span> ${text}`;
    chatMsgs.append(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60),
          sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  // outgoing chat
  sendBtn.addEventListener('click', () => {
    const t = chatInput.value.trim();
    if (!t) return;
    appendMsg(username, t);
    socket.emit('chat', { roomId, msg: t, username });
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      sendBtn.click();
    }
  });
  socket.on('chat', data => appendMsg(data.username, data.msg));

  // stats
  socket.on('stats', arr => {
    statsList.innerHTML = '';
    arr.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${fmtTime(p.time)}`;
      statsList.append(li);
    });
  });

  // init state
  socket.on('init', state => {
    initState = state;
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
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const target  = initState.currentTime + (initState.paused ? 0 : elapsed);

      supSeek = true;
      player.currentTime = target;
      if (initState.paused) {
        supPause = true;
        player.pause();
      } else {
        supPlay = true;
        player.play();
      }

      setupSync();
      startSync();

      setInterval(() => {
        socket.emit('statsUpdate', {
          username,
          latency,
          time: player.currentTime,
          platform: isMobile ? 'mobile' : 'desktop'
        });
      }, 1000);
    }, { once: true });
  });

  function setupSync() {
    player.addEventListener('seeked', () => {
      if (supSeek) { supSeek = false; return; }
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    player.addEventListener('play', () => {
      if (supPlay) { supPlay = false; return; }
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      initState.paused      = false;
      socket.emit('play', { roomId, time: player.currentTime });
    });
    player.addEventListener('pause', () => {
      if (supPause) { supPause = false; return; }
      initState.currentTime = player.currentTime;
      initState.lastUpdate  = Date.now();
      initState.paused      = true;
      socket.emit('pause', { roomId, time: player.currentTime });
    });

    socket.on('play', d => {
      initState.currentTime = d.time;
      initState.paused      = false;
      initState.lastUpdate  = Date.now();
      supPlay = true;
      player.play();
    });
    socket.on('pause', d => {
      initState.currentTime = d.time;
      initState.paused      = true;
      initState.lastUpdate  = Date.now();
      supPause = true;
      player.pause();
    });
    socket.on('seek', d => {
      initState.currentTime = d.time;
      initState.lastUpdate  = Date.now();
      supSeek = true;
      player.currentTime = d.time;
    });
  }

  function startSync() {
    if (isMobile) return;
    setInterval(() => {
      const now        = Date.now();
      const elapsed    = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff       = serverTime - player.currentTime;

      if (Math.abs(diff) > HARD_THRESHOLD) {
        supSeek = true;
        player.currentTime = serverTime;
      } else {
        player.playbackRate = Math.min(
          MAX_RATE,
          Math.max(MIN_RATE, 1 + diff * NUDGE)
        );
      }
    }, SYNC_INTERVAL);

    setInterval(() => {
      socket.emit('getState', { roomId });
    }, SYNC_INTERVAL * 5);

    socket.on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      if (s.paused !== player.paused) {
        if (s.paused) {
          supPause = true;
          player.pause();
        } else {
          supPlay = true;
          player.play();
        }
      }
    });
  }
});