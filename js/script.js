document.addEventListener('DOMContentLoaded', () => {
  const SERVER = 'https://movie-night-backend-dvp8.onrender.com';
  const socket = io(SERVER);
  const mobile = /Mobi|Android|iPhone/.test(navigator.userAgent);
  let state = null;
  let latency = 0;
  let selfEvent = false;
  let lastUpdate = 0;

  const player = document.getElementById('videoPlayer');
  const statsList = document.getElementById('statsList');
  const chatMsgs = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

  const username = `Guest #${Math.floor(Math.random() * 1000) + 1}`;
  document.getElementById('usernameDisplay').textContent = username;

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) {
    chatMsgs.innerHTML = '<em>No room specified.</em>';
    return;
  }
  
  socket.emit('joinRoom', { roomId, username });

  function ping() {
    const start = Date.now();
    socket.emit('pingCheck', { time: start });
  }
  
  socket.on('pongCheck', ({ time }) => {
    const rtt = Date.now() - time;
    latency = rtt / 2;
  });

  function addMsg(user, text) {
    const msg = document.createElement('div');
    msg.className = 'chatMessage';
    msg.innerHTML = `<span class="user">${user}:</span> ${text}`;
    chatMsgs.append(msg);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
  
  sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    addMsg(username, msg);
    socket.emit('chat', { roomId, msg, username });
    chatInput.value = '';
  });
  
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendBtn.click();
  });
  
  socket.on('chat', data => addMsg(data.username, data.msg));

  socket.on('stats', users => {
    statsList.innerHTML = '';
    users.forEach(u => {
      const m = Math.floor(u.time/60);
      const s = String(Math.floor(u.time%60)).padStart(2,'0');
      const item = document.createElement('li');
      item.textContent = `${u.username} | ${u.platform} | ${Math.round(u.latency)} ms | ${m}:${s}`;
      statsList.append(item);
    });
  });

  socket.on('init', s => {
    state = s;
    lastUpdate = s.lastUpdate;
    
    if (s.title) {
      const title = `Movie Night - ${s.title}`;
      document.title = title;
      const meta = document.querySelector('meta[property="og:title"]');
      if (meta) meta.setAttribute('content', title);
    }

    let hls, src = '';
    if (s.videoUrl !== src) {
      src = s.videoUrl;
      if (hls) hls.destroy();
      if (src.endsWith('.m3u8') && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(player);
      } else {
        player.src = src;
      }
    }

    setupEvents();
    
    ping();
    player.pause();
    
    player.addEventListener('canplay', () => {
      const now = Date.now();
      const elapsed = (now - s.lastUpdate - latency) / 1000;
      const target = s.paused ? s.currentTime : s.currentTime + elapsed;
      
      selfEvent = true;
      player.currentTime = target;
      
      s.paused ? player.pause() : player.play();
      
      startSync();
      startStats();
      
      setTimeout(() => selfEvent = false, 1000);
    }, { once: true });
  });

  function setupEvents() {
    player.onseeked = e => {
      if (!e.isTrusted || selfEvent) return;
      if (Date.now() - lastUpdate < 500) return;
      socket.emit('seek', { roomId, time: player.currentTime });
      lastUpdate = Date.now();
    };
    
    player.onplay = e => {
      if (!e.isTrusted || selfEvent) return;
      if (Date.now() - lastUpdate < 500) return;
      socket.emit('play', { roomId, time: player.currentTime });
      lastUpdate = Date.now();
    };
    
    player.onpause = e => {
      if (!e.isTrusted || selfEvent) return;
      if (Date.now() - lastUpdate < 500) return;
      socket.emit('pause', { roomId, time: player.currentTime });
      lastUpdate = Date.now();
    };
  }

  socket.on('seek', data => {
    const diff = Math.abs(player.currentTime - data.time);
    if (diff > 0.5) {
      selfEvent = true;
      player.currentTime = data.time;
      setTimeout(() => selfEvent = false, 100);
    }
  });
  
  socket.on('play', data => {
    if (Math.abs(player.currentTime - data.time) > 0.5) {
      selfEvent = true;
      player.currentTime = data.time;
      setTimeout(() => selfEvent = false, 100);
    }
    player.play();
  });
  
  socket.on('pause', () => {
    player.pause();
  });

  function startSync() {
    if (!state) return;
    
    setInterval(() => {
      if (!state || player.paused) return;
      
      const now = Date.now();
      const elapsed = (now - state.lastUpdate - latency) / 1000;
      const serverTime = state.paused ? state.currentTime : state.currentTime + elapsed;
      const drift = serverTime - player.currentTime;
      const absDrift = Math.abs(drift);
      
      if (absDrift > 2.0) {
        selfEvent = true;
        player.currentTime += drift * 0.5;
        setTimeout(() => selfEvent = false, 100);
      } 
      else if (absDrift > 0.1) {
        const rate = 1 + Math.min(0.05, Math.max(-0.05, drift * 0.01));
        player.playbackRate = rate;
      }
      else if (player.playbackRate !== 1.0) {
        player.playbackRate = 1.0;
      }
    }, 1000);
    
    setInterval(() => socket.emit('getState', { roomId }), 5000);
    
    socket.on('syncState', s => {
      if (!state) return;
      if (s.lastUpdate > state.lastUpdate) {
        state = s;
        
        if (s.paused !== player.paused) {
          selfEvent = true;
          s.paused ? player.pause() : player.play();
          setTimeout(() => selfEvent = false, 100);
        }
      }
    });
  }

  function startStats() {
    setInterval(() => {
      socket.emit('statsUpdate', {
        username,
        latency,
        time: player.currentTime,
        platform: mobile ? 'mobile' : 'desktop'
      });
    }, 1000);
  }
});