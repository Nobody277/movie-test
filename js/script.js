document.addEventListener('DOMContentLoaded', () => {
  const SOCKET_SERVER_URL = 'https://movie-night-backend-dvp8.onrender.com';
  const socket = io(SOCKET_SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });
  
  const isMobile = /Mobi|Android|iPhone/.test(navigator.userAgent);
  let initState = null;
  let latencySamples = [];
  let latency = 0;
  let isSelfEvent = false;
  let lastSyncTime = 0;
  let syncCount = 0;
  let driftHistory = [];
  const DRIFT_HISTORY_SIZE = 5;

  // Debug logging function
  function debugLog(message, data = {}) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const prefix = `[${timestamp}] DEBUG:`;
    console.log(prefix, message, data);
  }

  const player = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

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
  
  debugLog('Joining room', { roomId, username });
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
    debugLog('Pong received', { rtt, latency });
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
      const m = Math.floor(p.time / 60),
        s = String(Math.floor(p.time % 60)).padStart(2, '0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });

  socket.on('init', state => {
    debugLog('Received init state', state);
    initState = state;
    lastSyncTime = Date.now();

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

    // Setup player event listeners first
    setupPlayerEventListeners();
    
    // sync the time
    ping();
    player.pause();
    
    player.addEventListener('canplay', () => {
      const now = Date.now();
      const elapsed = (now - state.lastUpdate - latency) / 1000;
      const target = state.currentTime + (state.paused ? 0 : elapsed);
      
      debugLog('Canplay event - setting time', { 
        now, 
        lastUpdate: state.lastUpdate, 
        latency,
        elapsed,
        targetTime: target,
        playerTime: player.currentTime
      });
      
      // Mark as programmatic seek
      isSelfEvent = true;
      player.currentTime = target;
      lastSyncTime = now;
      
      if (state.paused) {
        player.pause();
      } else {
        player.play().catch(e => debugLog('Play error', e));
      }
      
      // Setup remote events and start loops
      setupRemoteEvents(state);
      startSyncLoop();
      startStatsLoop();
      
      // Reset self event flag after seek completes
      setTimeout(() => {
        isSelfEvent = false;
        debugLog('Initial sync completed', {
          playerTime: player.currentTime,
          targetTime: target
        });
      }, 1000);
    }, { once: true });
  });

  function setupPlayerEventListeners() {
    debugLog('Setting up player event listeners');
    
    // Remove any existing listeners first
    player.removeEventListener('seeked', handleSeek);
    player.removeEventListener('play', handlePlay);
    player.removeEventListener('pause', handlePause);
    
    // Add new listeners
    player.addEventListener('seeked', handleSeek);
    player.addEventListener('play', handlePlay);
    player.addEventListener('pause', handlePause);
  }
  
  function handleSeek(e) {
    debugLog('Seeked event', {
      isTrusted: e.isTrusted,
      isSelfEvent,
      currentTime: player.currentTime
    });
    
    if (!e.isTrusted || isSelfEvent) return;
    debugLog('Emitting seek event', player.currentTime);
    socket.emit('seek', { roomId, time: player.currentTime });
  }
  
  function handlePlay(e) {
    debugLog('Play event', {
      isTrusted: e.isTrusted,
      isSelfEvent,
      currentTime: player.currentTime
    });
    
    if (!e.isTrusted || isSelfEvent) return;
    debugLog('Emitting play event', player.currentTime);
    socket.emit('play', { roomId, time: player.currentTime });
  }
  
  function handlePause(e) {
    debugLog('Pause event', {
      isTrusted: e.isTrusted,
      isSelfEvent,
      currentTime: player.currentTime
    });
    
    if (!e.isTrusted || isSelfEvent) return;
    debugLog('Emitting pause event', player.currentTime);
    socket.emit('pause', { roomId, time: player.currentTime });
  }

  function setupRemoteEvents(state) {
    debugLog('Setting up remote event listeners');
    
    socket.off('seek');
    socket.off('play');
    socket.off('pause');
    
    socket.on('seek', data => {
      const timeDiff = Math.abs(player.currentTime - data.time);
      debugLog('Received remote seek', {
        data,
        currentTime: player.currentTime,
        difference: timeDiff
      });
      
      if (timeDiff > 0.5) {
        debugLog('Applying remote seek', data.time);
        isSelfEvent = true;
        state.currentTime = data.time;
        state.lastUpdate = Date.now();
        player.currentTime = data.time;
        setTimeout(() => isSelfEvent = false, 100);
      }
    });
    
    socket.on('play', data => {
      debugLog('Received remote play', data);
      isSelfEvent = true;
      state.currentTime = data.time;
      state.paused = false;
      state.lastUpdate = Date.now();
      player.play().catch(e => debugLog('Remote play error', e));
      setTimeout(() => isSelfEvent = false, 100);
    });
    
    socket.on('pause', data => {
      debugLog('Received remote pause', data);
      isSelfEvent = true;
      state.currentTime = data.time;
      state.paused = true;
      state.lastUpdate = Date.now();
      player.pause();
      setTimeout(() => isSelfEvent = false, 100);
    });
  }

  // Hybrid sync with time adjustment and playback rate
  function startSyncLoop() {
    if (!initState) {
      console.warn('Sync loop started before state initialization');
      return;
    }

    debugLog('Starting hybrid sync loop');
    
    const syncInterval = setInterval(() => {
      if (!initState) {
        clearInterval(syncInterval);
        return;
      }
      
      syncCount++;
      const now = Date.now();
      const elapsed = (now - initState.lastUpdate - latency) / 1000;
      const serverTime = initState.currentTime + (initState.paused ? 0 : elapsed);
      const drift = serverTime - player.currentTime;
      const absDrift = Math.abs(drift);
      
      // Calculate average drift
      driftHistory.push(drift);
      if (driftHistory.length > DRIFT_HISTORY_SIZE) {
        driftHistory.shift();
      }
      const avgDrift = driftHistory.reduce((sum, val) => sum + val, 0) / driftHistory.length;
      
      // Only adjust if we're playing and there's significant drift
      if (!player.paused) {
        // Large drift correction
        if (absDrift > 1.0) {
          debugLog(`Large drift correction #${syncCount}`, {
            serverTime,
            playerTime: player.currentTime,
            drift,
            avgDrift
          });
          
          isSelfEvent = true;
          player.currentTime = player.currentTime + drift * 0.5; // Partial correction
          setTimeout(() => isSelfEvent = false, 100);
        } 
        // Small drift correction with playback rate
        else if (absDrift > 0.1) {
          // Calculate playback rate adjustment (limited to ±2%)
          const rateAdjustment = Math.min(0.02, Math.max(-0.02, drift * 0.01));
          const newRate = 1.0 + rateAdjustment;
          
          debugLog(`Playback rate adjustment #${syncCount}`, {
            serverTime,
            playerTime: player.currentTime,
            drift,
            avgDrift,
            newRate
          });
          
          player.playbackRate = newRate;
        }
        // Reset to normal speed when in sync
        else if (player.playbackRate !== 1.0) {
          debugLog(`Resetting playback rate to 1.0`);
          player.playbackRate = 1.0;
        }
      }
    }, 1000); // Sync every 1 second

    // State sync every 5 seconds
    setInterval(() => {
      debugLog('Requesting state update');
      socket.emit('getState', { roomId });
    }, 5000);
    
    socket.on('syncState', s => {
      if (!initState) return;
      debugLog('Received syncState', s);
      
      // Only update if state is newer
      if (s.lastUpdate > initState.lastUpdate) {
        initState.currentTime = s.currentTime;
        initState.paused = s.paused;
        initState.lastUpdate = s.lastUpdate;
        
        if (s.paused !== player.paused) {
          debugLog(`Pause state changed to ${s.paused}`);
          isSelfEvent = true;
          s.paused ? player.pause() : player.play().catch(e => debugLog('Play error', e));
          setTimeout(() => isSelfEvent = false, 100);
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
  
  // Initial debug info
  debugLog('Player initialized', {
    userAgent: navigator.userAgent,
    isMobile,
    roomId
  });
});