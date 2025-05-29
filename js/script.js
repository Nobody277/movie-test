document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  let initState;    // will hold the authoritative room state
  let latency = 0;  // measured ping/2

  const isMobile = /Mobi|Android|iPhone/.test(navigator.userAgent);
  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');
  document.getElementById('usernameDisplay').textContent = `Guest #${Math.floor(Math.random()*1000)+1}`;

  // figure out which room we’re in
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }

  // join
  socket.emit('joinRoom', { roomId, username: document.getElementById('usernameDisplay').textContent }, res => {
    if (res.error) {
      chatMsgs.innerHTML = `<em>${res.error}</em>`;
    }
  });

  // latency ping/pong
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now() - clientTime) / 2;
  });
  setInterval(ping, 5000);

  // handle incoming chat
  sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    appendMsg(document.getElementById('usernameDisplay').textContent, msg);
    socket.emit('chat', { roomId, msg, username: document.getElementById('usernameDisplay').textContent });
    chatInput.value = '';
  });
  socket.on('chat', data => appendMsg(data.username, data.msg));
  function appendMsg(user, text) {
    const d = document.createElement('div');
    d.className = 'chatMessage';
    d.innerHTML = `<span class="user">${user}:</span> ${text}`;
    chatMsgs.append(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  // incoming stats
  socket.on('stats', arr => {
    statsList.innerHTML = '';
    arr.forEach(p => {
      const m = Math.floor(p.time/60),
            s = String(Math.floor(p.time%60)).padStart(2,'0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  // initial room state
  socket.on('init', state => {
    initState = state;

    // set up title & metadata
    if (state.title) {
      const full = `Movie Night - ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load stream
    let hls, currentSrc = '';
    if (state.videoUrl !== currentSrc) {
      currentSrc = state.videoUrl;
      if (hls) { hls.destroy(); hls = null; }
      if (currentSrc.endsWith('.m3u8')) {
        hls = new Hls();
        hls.loadSource(currentSrc);
        hls.attachMedia(player);
      } else {
        player.src = currentSrc;
      }
    }

    // seek/play to match
    const now     = Date.now();
    const elapsed = (now - state.lastUpdate - latency) / 1000;
    const target  = state.currentTime + (state.paused ? 0 : elapsed);
    player.currentTime = target;
    state.paused ? player.pause() : player.play();

    setupUserEvents();
    setupRemoteEvents();
    startSyncLoop();
    startStatsLoop();

  }, { once: true });

  // user → server
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

  // server → user
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
      player.currentTime    = data.time;
      player.play();
    });
    socket.on('pause', data => {
      initState.currentTime = data.time;
      initState.paused      = true;
      initState.lastUpdate  = Date.now();
      player.currentTime    = data.time;
      player.pause();
    });
    socket.on('syncState', s => {
      initState.currentTime = s.currentTime;
      initState.paused      = s.paused;
      initState.lastUpdate  = s.lastUpdate;
      if (s.paused !== player.paused) {
        s.paused ? player.pause() : player.play();
      }
    });
  }

  // authoritative sync loop
  function startSyncLoop() {
    setInterval(() => {
      const now     = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff       = serverTime - player.currentTime;

      if (Math.abs(diff) > 1.0) {
        // jump if way off
        player.currentTime = serverTime;
      } else {
        // small nudge via playbackRate
        player.playbackRate = Math.min(1.05, Math.max(0.95, 1 + diff * 0.1));
      }
    }, 1000);

    // also poll server for fresh authoritative state
    setInterval(() => socket.emit('getState', { roomId }), 5000);
  }

  // send stats every second
  function startStatsLoop() {
    setInterval(() => {
      socket.emit('statsUpdate', {
        roomId,
        username: document.getElementById('usernameDisplay').textContent,
        latency,
        time: player.currentTime,
        platform: isMobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }

});