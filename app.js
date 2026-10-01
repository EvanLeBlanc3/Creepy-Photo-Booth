/* Creepy Photo Booth — app shell (camera, gallery, viewer, settings) */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const app = $('#app'), video = $('#video'), vf = $('#viewfinder');

  /* ---------------- settings ---------------- */
  const DEFAULTS = { haunt: true, entity: 'random', intensity: 'noticeable', freq: '1', reveal: true, sound: false, shutter: true, grid: false };
  const S = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cpb-settings') || '{}') }; } catch (e) { return { ...DEFAULTS }; } })();
  const saveS = () => localStorage.setItem('cpb-settings', JSON.stringify(S));

  const st = { facing: 'environment', stream: null, track: null, mode: 'photo', zoom: 1, flash: false, timer: 0,
               busy: false, photos: [], vi: -1, urls: [], lockAngle: 0 };

  /* ---------------- IndexedDB gallery ---------------- */
  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('creepy-booth', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('photos', mode), req = fn(t.objectStore('photos'));
        t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error);
      });
    };
    return { put: r => tx('readwrite', s => s.put(r)), del: id => tx('readwrite', s => s.delete(id)),
             all: () => tx('readonly', s => s.getAll()), clear: () => tx('readwrite', s => s.clear()) };
  })();

  /* ---------------- sound ---------------- */
  let ac;
  const audio = () => { if (!ac) { const A = window.AudioContext || window.webkitAudioContext; if (A) ac = new A(); } if (ac && ac.state === 'suspended') ac.resume(); return ac; };
  function noiseBuf(a, secs) { const b = a.createBuffer(1, a.sampleRate * secs, a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
  function shutterSound() {
    const a = audio(); if (!a || !S.shutter) return;
    [0, 0.07].forEach((t0, i) => {
      const n = a.createBufferSource(); n.buffer = noiseBuf(a, 0.05);
      const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = i ? 2400 : 3600; f.Q.value = 0.8;
      const g = a.createGain(), t = a.currentTime + t0;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      n.connect(f).connect(g).connect(a.destination); n.start(t); n.stop(t + 0.06);
    });
  }
  function revealSting() {
    const a = audio(); if (!a) return; const t = a.currentTime, out = a.createGain();
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.35, t + 1.2); out.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    out.connect(a.destination);
    [55, 58.3, 82.4].forEach(fq => { const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fq;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; o.connect(lp).connect(out); o.start(t); o.stop(t + 4.3); });
    const n = a.createBufferSource(); n.buffer = noiseBuf(a, 3); const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(500, t); bp.frequency.linearRampToValueAtTime(1500, t + 2.5);
    const ng = a.createGain(); ng.gain.setValueAtTime(0.0001, t + 0.6); ng.gain.exponentialRampToValueAtTime(0.18, t + 1.8); ng.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    n.connect(bp).connect(ng).connect(a.destination); n.start(t + 0.6);
  }

  /* ---------------- camera ---------------- */
  function stopCamera() { if (st.stream) st.stream.getTracks().forEach(t => t.stop()); st.stream = st.track = null; }
  async function startCamera() {
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: st.facing }, width: { ideal: 4032 }, height: { ideal: 3024 } } });
      st.stream = stream; st.track = stream.getVideoTracks()[0];
      video.srcObject = stream; await video.play().catch(() => {});
      $('#camError').hidden = true;
    } catch (e) { $('#camError').hidden = false; }
    layoutVideo();
  }
  async function setTorch(on) {
    try { const c = st.track && st.track.getCapabilities && st.track.getCapabilities(); if (c && c.torch) await st.track.applyConstraints({ advanced: [{ torch: on }] }); } catch (e) {}
  }
  function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
    let aspect = st.mode === 'square' ? 1 : 3 / 4;
    if (st.lockAngle && st.mode !== 'square') aspect = 4 / 3; // phone held sideways -> landscape photo, like the real camera
    let sw, sh; if (vw / vh > aspect) { sh = vh; sw = vh * aspect; } else { sw = vw; sh = vw / aspect; }
    sw /= st.zoom; sh /= st.zoom;
    const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
    const x = c.getContext('2d');
    if (st.facing === 'user') { x.translate(c.width, 0); x.scale(-1, 1); }
    x.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------------- portrait lock (counter-rotate when sideways) ---------------- */
  function orientAngle() {
    if (typeof window.orientation === 'number') return window.orientation;
    if (screen.orientation && typeof screen.orientation.angle === 'number') { const a = screen.orientation.angle; return a === 270 ? -90 : a; }
    return 90;
  }
  function lockPortrait() {
    const W = window.innerWidth, H = window.innerHeight;
    if (W > H) {
      const a = orientAngle() === -90 ? 90 : -90;
      st.lockAngle = a; app.classList.add('locked');
      Object.assign(app.style, { width: H + 'px', height: W + 'px', left: (W - H) / 2 + 'px', top: (H - W) / 2 + 'px', transform: `rotate(${a}deg)` });
    } else {
      st.lockAngle = 0; app.classList.remove('locked');
      Object.assign(app.style, { width: '', height: '', left: '', top: '', transform: '' });
    }
    layoutVideo(); centerModes();
  }
  function layoutVideo() {
    const mirror = st.facing === 'user' ? ' scaleX(-1)' : '', zoom = st.zoom !== 1 ? ` scale(${st.zoom})` : '';
    if (st.lockAngle) { // keep the live picture upright in the real world
      const w = vf.clientWidth, h = vf.clientHeight;
      Object.assign(video.style, { width: h + 'px', height: w + 'px', left: (w - h) / 2 + 'px', top: (h - w) / 2 + 'px' });
      video.style.transform = `rotate(${-st.lockAngle}deg)${mirror}${zoom}`;
    } else {
      Object.assign(video.style, { width: '', height: '', left: '', top: '' });
      video.style.transform = (mirror + zoom).trim() || 'none';
    }
  }
  window.addEventListener('resize', () => setTimeout(lockPortrait, 60));
  window.addEventListener('orientationchange', () => setTimeout(lockPortrait, 250));

  /* ---------------- capture pipeline ---------------- */
  const toBlob = c => new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  async function countdown(n) {
    const el = $('#countdown');
    for (let i = n; i > 0; i--) { el.textContent = i; await wait(1000); }
    el.textContent = '';
  }
  async function capture() {
    if (st.busy) return; st.busy = true; audio();
    try {
      if (st.timer) await countdown(st.timer);
      const front = st.facing === 'user';
      if (st.flash) { if (front) { $('#screenFlash').classList.add('on'); await wait(280); } else { await setTorch(true); await wait(400); } }
      const frame = grabFrame();
      if (st.flash) { $('#screenFlash').classList.remove('on'); if (!front) setTorch(false); }
      $('#blink').classList.remove('go'); void $('#blink').offsetWidth; $('#blink').classList.add('go');
      shutterSound();
      if (frame) { await wait(30); await processAndSave(frame, front); }
    } finally { st.busy = false; }
  }
  async function processAndSave(canvas, selfie) {
    const clean = await toBlob(canvas);
    let haunted = null, entity = null;
    if (S.haunt && Math.random() < parseFloat(S.freq)) {
      try { const r = Haunt.apply(canvas, { entity: S.entity, intensity: S.intensity, selfie }); haunted = await toBlob(r.canvas); entity = r.entity; }
      catch (e) { console.error(e); }
    }
    const rec = { id: Date.now(), created: Date.now(), clean, haunted, entity, seen: false, selfie, num: nextNum() };
    await DB.put(rec); st.photos.push(rec); setThumb(rec, true);
    return rec;
  }
  function nextNum() { const n = (parseInt(localStorage.getItem('cpb-num') || String(4000 + Math.floor(Math.random() * 3000)), 10) + 1) % 10000; localStorage.setItem('cpb-num', n); return n; }

  let thumbURL;
  function setThumb(rec, pop) {
    const img = $('#thumbImg');
    if (thumbURL) URL.revokeObjectURL(thumbURL);
    if (!rec) { img.removeAttribute('src'); img.classList.remove('has'); thumbURL = null; return; }
    // thumbnail always shows the innocent version so nothing gets spoiled
    thumbURL = URL.createObjectURL(S.reveal || !rec.haunted ? rec.clean : rec.haunted);
    img.src = thumbURL; img.classList.add('has');
    if (pop) { $('#thumb').classList.remove('pop'); void $('#thumb').offsetWidth; $('#thumb').classList.add('pop'); }
  }

  /* ---------------- library import ---------------- */
  async function importFile(file) {
    if (!file) return;
    $('#busy').hidden = false;
    try {
      const url = URL.createObjectURL(file), img = new Image(); img.src = url; await img.decode();
      const max = 4032, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      await wait(20);
      const keep = S.freq; S.freq = '1';            // imports always get haunted (if haunting is on)
      await processAndSave(c, false); S.freq = keep;
      openViewer(st.photos.length - 1);
    } catch (e) { alert('Could not open that photo.'); }
    $('#busy').hidden = true;
  }

  /* ---------------- viewer ---------------- */
  const vClean = $('#vClean'), vHaunt = $('#vHaunt');
  let revealTimer;
  function openViewer(i) { if (!st.photos.length) return; st.vi = i; $('#viewer').hidden = false; renderViewer(); }
  function closeViewer() { $('#viewer').hidden = true; clearTimeout(revealTimer); st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = []; }
  function renderViewer() {
    const rec = st.photos[st.vi]; if (!rec) return closeViewer();
    clearTimeout(revealTimer); st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = [];
    const cu = URL.createObjectURL(rec.clean); st.urls.push(cu); vClean.src = cu;
    vHaunt.classList.remove('reveal', 'hidden');
    if (rec.haunted) {
      const hu = URL.createObjectURL(rec.haunted); st.urls.push(hu); vHaunt.src = hu; vHaunt.style.display = '';
      if (S.reveal && !rec.seen) {
        vHaunt.classList.add('hidden');
        revealTimer = setTimeout(() => { vHaunt.classList.add('reveal'); vHaunt.classList.remove('hidden'); if (S.sound) revealSting(); }, 1800 + Math.random() * 1500);
        rec.seen = true; DB.put(rec);
      }
    } else { vHaunt.removeAttribute('src'); vHaunt.style.display = 'none'; }
    const d = new Date(rec.created);
    const today = new Date().toDateString() === d.toDateString();
    $('#vDate').textContent = today ? 'Today' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    $('#vTime').textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('#vCount').textContent = `${st.vi + 1} of ${st.photos.length}`;
  }
  let tX = null, tY = null;
  $('#vStage').addEventListener('touchstart', e => { tX = e.touches[0].clientX; tY = e.touches[0].clientY; }, { passive: true });
  $('#vStage').addEventListener('touchend', e => {
    if (tX === null) return;
    let dx = e.changedTouches[0].clientX - tX, dy = e.changedTouches[0].clientY - tY; tX = null;
    if (st.lockAngle) { const t = dx; dx = st.lockAngle === -90 ? -dy : dy; dy = t; }
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      const ni = st.vi + (dx < 0 ? 1 : -1);
      if (ni >= 0 && ni < st.photos.length) { st.vi = ni; renderViewer(); }
    } else if (dy > 90) closeViewer();
  });
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1500); }

  $('#vDone').onclick = closeViewer;
  $('#thumb').onclick = () => openViewer(st.photos.length - 1);
  $('#vShare').onclick = async () => {
    const rec = st.photos[st.vi]; if (!rec) return;
    const showingClean = vHaunt.classList.contains('hidden') || !rec.haunted;
    const blob = showingClean ? rec.clean : rec.haunted;
    const file = new File([blob], `IMG_${String(rec.num || 1).padStart(4, '0')}.JPG`, { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#vReroll').onclick = async () => {
    const rec = st.photos[st.vi]; if (!rec) return;
    $('#busy').hidden = false;
    try {
      const url = URL.createObjectURL(rec.clean), img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url);
      await wait(20);
      const r = Haunt.apply(c, { entity: S.entity, intensity: S.intensity, selfie: rec.selfie });
      rec.haunted = await toBlob(r.canvas); rec.entity = r.entity; rec.seen = true;
      await DB.put(rec); renderViewer(); toast('Something new is here…');
    } catch (e) { console.error(e); }
    $('#busy').hidden = true;
  };
  $('#vClean2').onclick = () => {
    const rec = st.photos[st.vi]; if (!rec || !rec.haunted) return toast('Nothing here… yet.');
    clearTimeout(revealTimer); vHaunt.classList.remove('reveal');
    const hide = !vHaunt.classList.contains('hidden'); vHaunt.classList.toggle('hidden', hide);
    toast(hide ? 'Original' : 'Haunted');
  };
  $('#vDelete').onclick = async () => {
    const rec = st.photos[st.vi]; if (!rec || !confirm('Delete this photo?')) return;
    await DB.del(rec.id); st.photos.splice(st.vi, 1);
    setThumb(st.photos[st.photos.length - 1]);
    if (!st.photos.length) return closeViewer();
    st.vi = Math.min(st.vi, st.photos.length - 1); renderViewer();
  };

  /* ---------------- controls ---------------- */
  $('#shutter').onclick = capture;
  $('#flip').onclick = () => { st.facing = st.facing === 'user' ? 'environment' : 'user'; $('#flip').classList.toggle('spin'); startCamera(); };
  $('#flashBtn').onclick = () => { st.flash = !st.flash; $('#flashBtn').classList.toggle('on', st.flash); };
  $('#timerBtn').onclick = () => {
    st.timer = st.timer === 0 ? 3 : st.timer === 3 ? 10 : 0;
    $('#timerBtn').classList.toggle('on', !!st.timer); $('#timerLabel').textContent = st.timer ? st.timer + 's' : '';
  };
  $('#retryCam').onclick = startCamera;
  $$('#zoomPill button').forEach(b => b.onclick = () => {
    st.zoom = +b.dataset.z; $$('#zoomPill button').forEach(x => { x.classList.toggle('on', x === b); x.textContent = x.dataset.z + (x === b ? '×' : ''); });
    layoutVideo();
  });
  vf.addEventListener('click', e => {
    if (e.target.closest('#zoomPill,#camError')) return;
    const r = vf.getBoundingClientRect(), f = $('#focus');
    let x = e.clientX - r.left, y = e.clientY - r.top;
    if (st.lockAngle) { // map screen coords into the rotated viewfinder
      const cx = r.width / 2, cy = r.height / 2, dx = e.clientX - (r.left + cx), dy = e.clientY - (r.top + cy);
      const a = -st.lockAngle * Math.PI / 180;
      x = vf.clientWidth / 2 + dx * Math.cos(a) - dy * Math.sin(a); y = vf.clientHeight / 2 + dx * Math.sin(a) + dy * Math.cos(a);
    }
    f.style.left = x + 'px'; f.style.top = y + 'px';
    f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove('show'), 1100);
  });

  /* modes */
  function centerModes() {
    const a = $('#modeTrack .active'); if (!a) return;
    $('#modeTrack').style.transform = `translateX(${-(a.offsetLeft + a.offsetWidth / 2)}px)`;
  }
  function setMode(m) {
    if (m === 'library') { $('#fileInput').click(); return; }
    st.mode = m; $$('#modeTrack span').forEach(s => s.classList.toggle('active', s.dataset.mode === m));
    app.classList.toggle('square', m === 'square'); centerModes(); setTimeout(layoutVideo, 320);
  }
  $$('#modeTrack span').forEach(s => s.onclick = () => setMode(s.dataset.mode));
  let sx0 = null;
  vf.addEventListener('touchstart', e => { sx0 = e.touches[0].clientX; }, { passive: true });
  vf.addEventListener('touchend', e => {
    if (sx0 === null || st.lockAngle) return; const dx = e.changedTouches[0].clientX - sx0; sx0 = null;
    if (Math.abs(dx) > 70) setMode(dx < 0 ? 'photo' : 'square');
  });
  $('#fileInput').onchange = e => { importFile(e.target.files[0]); e.target.value = ''; };

  /* options sheet */
  const openSheet = on => { $('#sheet').classList.toggle('on', on); $('#scrim').classList.toggle('on', on); $('#chevronBtn').classList.toggle('open', on); };
  $('#chevronBtn').onclick = () => openSheet(!$('#sheet').classList.contains('on'));
  $('#scrim').onclick = () => openSheet(false);
  let shY = null;
  $('#sheet').addEventListener('touchstart', e => { shY = $('#sheet').scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  $('#sheet').addEventListener('touchend', e => { if (shY !== null && e.changedTouches[0].clientY - shY > 80 && !st.lockAngle) openSheet(false); shY = null; });

  function syncUI() {
    $$('.toggle').forEach(t => t.classList.toggle('on', !!S[t.dataset.key]));
    $$('#entityChips button').forEach(b => b.classList.toggle('on', b.dataset.v === S.entity));
    $$('#intensitySeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.intensity));
    $$('#freqSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.freq));
    $('#grid').hidden = !S.grid;
  }
  $$('.toggle').forEach(t => t.onclick = () => { S[t.dataset.key] = !S[t.dataset.key]; saveS(); syncUI(); });
  $$('#entityChips button').forEach(b => b.onclick = () => { S.entity = b.dataset.v; saveS(); syncUI(); });
  $$('#intensitySeg button').forEach(b => b.onclick = () => { S.intensity = b.dataset.v; saveS(); syncUI(); });
  $$('#freqSeg button').forEach(b => b.onclick = () => { S.freq = b.dataset.v; saveS(); syncUI(); });
  $('#importBtn').onclick = () => { openSheet(false); $('#fileInput').click(); };
  $('#clearBtn').onclick = async () => {
    if (!confirm('Delete ALL photos from Creepy Photo Booth? (Photos you already saved to your Camera Roll are safe.)')) return;
    await DB.clear(); st.photos = []; setThumb(null); openSheet(false);
  };

  /* lifecycle */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!st.track || st.track.readyState === 'ended')) startCamera();
  });
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault());

  /* boot */
  (async () => {
    syncUI(); lockPortrait();
    try { st.photos = (await DB.all()).sort((a, b) => a.id - b.id); setThumb(st.photos[st.photos.length - 1]); } catch (e) {}
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) startCamera(); else $('#camError').hidden = false;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
