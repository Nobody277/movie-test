document.addEventListener('DOMContentLoaded', () => {
  const socket   = io('https://movie-night-backend-dvp8.onrender.com');
  const player   = document.getElementById('videoPlayer');
  const chatMsgs = document.getElementById('chatMessages');
  const statsList= document.getElementById('statsList');
  const chatInput= document.getElementById('chatInput');
  const sendBtn  = document.getElementById('sendBtn');
  const username = `Guest #${Math.floor(Math.random()*1000)}`;
  let roomId, latency=0, suppressSeek=false;

  // — UI Setup —
  document.getElementById('usernameDisplay').textContent = username;
  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => e.key==='Enter' && sendChat());

  function sendChat(){
    const msg = chatInput.value.trim();
    if(!msg) return;
    appendChat(username, msg);
    socket.emit('chat', { roomId, username, msg });
    chatInput.value='';
  }
  function appendChat(user, text){
    const d = document.createElement('div');
    d.className='chatMessage';
    d.innerHTML=`<b>${user}:</b> ${text}`;
    chatMsgs.append(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  // — Latency Ping/Pong —
  function ping(){ socket.emit('pingCheck', { clientTime: Date.now() }); }
  socket.on('pongCheck', ({ clientTime }) => {
    latency = (Date.now()-clientTime)/2;
  });

  // — Room Join —
  {
    const params = new URLSearchParams(location.search);
    roomId = params.get('room');
    if(!roomId){ chatMsgs.innerHTML='<i>No room specified.</i>'; return; }
    socket.emit('joinRoom', { roomId, username });
  }

  // — Incoming Init: load video + handshake —
  socket.on('init', ({ title, videoUrl, currentTime, paused, lastUpdate }) => {
    // set title/meta
    if(title){
      document.title= `Movie Night – ${title}`;
      const og = document.querySelector('meta[property="og:title"]');
      if(og) og.content = document.title;
    }
    // load stream
    player.src = videoUrl;
    // once ready, perform first seek/play
    player.addEventListener('canplay', function once(){
      const now     = Date.now();
      const elapsed = paused ? 0 : (now - lastUpdate - latency)/1000;
      safeSeek(currentTime + elapsed);
      paused ? player.pause() : player.play();
      bindControls();
      player.removeEventListener('canplay', once);
    }, { once:true });
    ping();
  });

  socket.on('tick', ({ currentTime, paused, timestamp }) => {
    const path = paused ? 0 : (Date.now() - timestamp - latency)/1000;
    const target = currentTime + path;
    const diff   = target - player.currentTime;

    if(Math.abs(diff)>0.5){
      safeSeek(target);
      player.playbackRate = 1;
    } else {
      player.playbackRate = Math.max(0.9, Math.min(1.1, 1 + diff*0.2));
    }
    paused ? player.pause() : player.play();
  });

  // — Stats Updates —
  socket.on('stats', arr => {
    statsList.innerHTML='';
    arr.forEach(p => {
      const m = Math.floor(p.time/60), s = String(Math.floor(p.time%60)).padStart(2,'0');
      const li = document.createElement('li');
      li.textContent = `${p.username} | ${p.platform} | ${Math.round(p.latency)} ms | ${m}:${s}`;
      statsList.append(li);
    });
  });
  setInterval(()=> {
    socket.emit('statsUpdate', {
      roomId, username, latency, time: player.currentTime,
      platform: /Mobi|Android|iPhone/.test(navigator.userAgent)?'mobile':'desktop'
    });
  }, 1000);

  // — Safe seek helper —
  function safeSeek(t){
    suppressSeek = true;
    player.currentTime = t;
    setTimeout(()=> suppressSeek=false, 100);
  }

  // — Control binding (only after init) —
  function bindControls(){
    player.addEventListener('seeked', e => {
      if(suppressSeek||!e.isTrusted) return;
      socket.emit('seek',{ roomId, time: player.currentTime });
    });
    player.addEventListener('play', e => {
      if(!e.isTrusted) return;
      socket.emit('play',{ roomId, time: player.currentTime });
    });
    player.addEventListener('pause', e => {
      if(!e.isTrusted) return;
      socket.emit('pause',{ roomId, time: player.currentTime });
    });
  }
});