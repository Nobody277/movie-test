document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket            = io(SOCKET_SERVER_URL);
  const isMobile          = /Mobi|Android|iPhone/.test(navigator.userAgent);
  let initState           = null;
  let latencySamples      = [];
  let latency             = 0;
  let isInitialSync       = true;

  const player    = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs  = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn   = document.getElementById('sendBtn');

  // generate a Guest username
  const username = `Guest #${Math.floor(Math.random()*1000)+1}`;
  document.getElementById('usernameDisplay').textContent = username;

  // join the room
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  socket.emit('joinRoom', { roomId, username });

  // helper: ping/pong for latency with averaging
  function ping() {
    const t0 = Date.now();
    socket.emit('pingCheck', { clientTime: t0 });
  }
  socket.on('pongCheck', ({ clientTime }) => {
    const rtt = Date.now() - clientTime;
    latencySamples.push(rtt / 2);
    
    // Keep last 5 samples and average
    if (latencySamples.length > 5) latencySamples.shift();
    latency = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
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
      const m = Math.floor(p.time/60),
            s = String(Math.floor(p.time%60)).padStart(2,'0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  socket.on('init', state => {
    // Store the initial state
    initState = state;
    isInitialSync = true;  // Mark initial sync in progress

    // update title
    if (state.title) {
      const full = `Movie Night - ${state.title}`;
      document.title = full;
      const og = document.querySelector('meta[property="og:title"]');
      if (og) og.setAttribute('content', full);
    }

    // load or HLS-attach the stream
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

    // sync the time
    ping();
    player.pause();
    player.addEventListener('canplay', () => {
      const now     = Date.now();
      const elapsed = (now - state.lastUpdate - latency) / 1000;
      const target  = state.currentTime + (state.paused ? 0 : elapsed);
      
      // Gradual sync without seeking
      player.currentTime = target;
      
      // Setup events after initial sync
      state.paused ? player.pause() : player.play();
      setupUserEvents();
      setupRemoteEvents(state);
      startSyncLoop();
      startStatsLoop();
      
      // Mark initial sync complete after short delay
      setTimeout(() => isInitialSync = false, 2000);
    }, { once: true });
  });

  // user ↔ server event wiring
  function setupUserEvents() {
    player.addEventListener('seeked', e => {
      if (!e.isTrusted || isInitialSync) return;
      socket.emit('seek', { roomId, time: player.currentTime });
    });
    
    player.addEventListener('play', e => {
      if (!e.isTrusted || isInitialSync) return;
      socket.emit('play', { roomId, time: player.currentTime });
    });
    
    player.addEventListener('pause', e => {
      if (!e.isTrusted || isInitialSync) return;
      socket.emit('pause', { roomId, time: player.currentTime });
    });
  }

  function setupRemoteEvents(state) {
    socket.on('seek', data => {
      // Only sync if difference is significant
      if (Math.abs(player.currentTime - data.time) > 0.5) {
        state.currentTime = data.time;
        state.lastUpdate = Date.now();
        player.currentTime = data.time;
      }
    });
    
    socket.on('play', data => {
      state.currentTime = data.time;
      state.paused = false;
      state.lastUpdate = Date.now();
      player.play();
    });
    
    socket.on('pause', data => {
      state.currentTime = data.time;
      state.paused = true;
      state.lastUpdate = Date.now();
      player.pause();
    });
  }

  // sync loop
  function startSyncLoop() {
    if (!initState) {
      console.warn('Sync loop started before state initialization');
      return;
    }

    const syncInterval = setInterval(() => {
      if (!initState) {
        clearInterval(syncInterval);
        return;
      }
      
      const now = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const diff = serverTime - player.currentTime;
      
      // Only adjust if difference is significant
      if (Math.abs(diff) > 0.2) {
        // Smooth adjustment (1/10th of difference per second)
        player.currentTime += diff * 0.1;
      }
    }, 100);  // More frequent but gentle adjustments
    
    // State sync every 5 seconds
    setInterval(() => socket.emit('getState', { roomId }), 5000);
    socket.on('syncState', s => {
      if (!initState) return;
      
      // Only update if state is newer
      if (s.lastUpdate > initState.lastUpdate) {
        initState.currentTime = s.currentTime;
        initState.paused = s.paused;
        initState.lastUpdate = s.lastUpdate;
        
        if (s.paused !== player.paused) {
          s.paused ? player.pause() : player.play();
        }
      }
    });
  }

  // send stats every second
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