// Breakpad app: loads kits, maps keyboard, pointer, trackpad and the native Mac shell onto the pads, and drives the display.
import { Engine } from './engine.js';
import { Transport, Song } from './sequencer.js';
import { Sampler, subHit } from './synth.js';
import { KITS } from './kits.js';

const KEYS = [
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Digit4'],
  ['KeyM', 'Comma', 'Period', 'Slash', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
];
const GLYPH = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';' };
const glyph = (code) => GLYPH[code] || code.replace('Key', '').replace('Digit', '');
const KEYMAP = new Map();
KEYS.forEach((row, b) => row.forEach((c, i) => KEYMAP.set(c, [b, i])));

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const native = window.webkit?.messageHandlers?.breakpad || null;
const store = (() => { try { return window.localStorage; } catch { return null; } })();

const S = {
  index: 0,
  kit: null,
  song: null,
  manifest: null,
  bufs: {},
  breakBuf: null,
  breakInfo: null,
  stab: null,
  down: new Map(),
  roll: 0,
  shift: false,
  alt: false,
  filter: 0,
  target: 0,
  wheelAt: 0,
  layers: { chords: true, bass: true, atmos: true, guide: false },
  section: 'drop',
  lastSound: 0,
  loadToken: 0,
  bpm: {},
  captured: false,
};
let transport;
const pads = [[], []];

function sampleInfo(name) {
  const m = S.manifest;
  return m.drums[name] || m.fx[name] || null;
}

function kitFiles(kit) {
  const m = S.manifest;
  const files = [];
  for (const bank of kit.pads) for (const p of bank) if (p.s && sampleInfo(p.s)) files.push(['sounds/' + sampleInfo(p.s).file, true]);
  files.push(['sounds/' + m.breaks[kit.break].file, false]);
  if (kit.atmos) files.push(['sounds/' + m.atmos[kit.atmos.s].file, true]);
  const insts = new Set(kit.parts.filter((p) => p.inst).map((p) => p.inst));
  insts.add(kit.stab.inst);
  for (const name of insts) for (const n of m.inst[name].notes) files.push(['sounds/' + n.file, true]);
  return files;
}

async function loadKit(index) {
  const token = ++S.loadToken;
  const kit = KITS[index];
  const chip = document.querySelector(`.kits button[data-i="${index}"]`);
  chip?.classList.add('loading');
  if (!S.kit) status('Ładowanie…', 0);
  try {
    const m = S.manifest;
    const bufs = {};
    const jobs = [];
    for (const bank of kit.pads) {
      for (const p of bank) {
        if (!p.s || bufs[p.s]) continue;
        const info = sampleInfo(p.s);
        if (!info) continue;
        bufs[p.s] = true;
        jobs.push(engine.load('sounds/' + info.file).then((b) => { bufs[p.s] = b; }));
      }
    }
    const bi = m.breaks[kit.break];
    let breakBuf;
    jobs.push(engine.load('sounds/' + bi.file, { trim: false }).then((b) => { breakBuf = b; }));
    const song = new Song(engine, transport, kit, m);
    jobs.push(song.load());
    const stabOut = engine.ctx.createGain();
    stabOut.connect(engine.fx);
    const stab = new Sampler(engine, m.inst[kit.stab.inst], stabOut, { gain: 1, release: 0.2, reverb: kit.stab.reverb, delay: kit.stab.delay });
    jobs.push(stab.load());
    await Promise.all(jobs);
    if (token !== S.loadToken) { song.dispose(); return; }
    const old = S.song;
    const now = engine.ctx.currentTime;
    S.index = index;
    S.kit = kit;
    S.song = song;
    S.bufs = bufs;
    S.breakBuf = breakBuf;
    S.breakInfo = bi;
    S.stab = stab;
    if (old) old.dispose();
    for (const [layer, on] of Object.entries(S.layers)) song.setMute(layer, !on);
    const bpm = S.bpm[kit.id] ?? kit.bpm;
    transport.bpm = bpm;
    song.setTempo(bpm);
    engine.setDrive(kit.drive ?? 0);
    engine.setDelay(0.75, bpm);
    song.onSection = (name) => { S.section = name; renderSection(); };
    if (S.section === 'break') song.applySection('break', now);
    else song.applySection('drop', now);
    if (transport.playing) song.startAtmos(now + 0.05);
    store?.setItem('bp.kit', kit.id);
    renderKit(true);
    status('', 0);
  } catch (err) {
    console.error(err);
    status('Błąd ładowania', 2000);
  } finally {
    chip?.classList.remove('loading');
  }
}

async function prefetch() {
  for (let k = 1; k < KITS.length; k++) {
    const kit = KITS[(S.index + k) % KITS.length];
    for (const [f, trim] of kitFiles(kit)) {
      try { await engine.load(f, { trim }); } catch {}
    }
  }
}

function unlock() {
  const ctx = engine.ctx;
  if (ctx && ctx.state !== 'running') ctx.resume();
}

function soundPad(bank, i, vel, when) {
  const kit = S.kit;
  const pad = kit?.pads[bank][i];
  if (!pad) return null;
  const ctx = engine.ctx;
  const t = when ?? ctx.currentTime;
  if (!pad.t) {
    const buf = S.bufs[pad.s];
    if (!buf || buf === true) return null;
    const v = engine.play(buf, {
      when: t,
      gain: (pad.g ?? 0.8) * vel,
      choke: pad.c,
      bus: pad.b === 'fx' ? engine.fx : engine.drums,
      reverb: pad.rev,
      delay: pad.dly,
      rate: pad.p ? Math.pow(2, pad.p / 12) : 1,
    });
    if (pad.l.startsWith('KICK')) engine.duck(t, 0.45, 0.04, 0.24);
    else if (pad.l.startsWith('SNARE')) engine.duck(t, 0.16, 0.02, 0.12);
    return v;
  }
  if (pad.t === 'chop') {
    const sl = S.breakInfo.slices[pad.i];
    if (!sl) return null;
    const rate = transport.bpm / S.breakInfo.bpm;
    if (sl.label === 'K') engine.duck(t, 0.35, 0.03, 0.2);
    return engine.play(S.breakBuf, { when: t, offset: sl.t, dur: sl.len, rate, choke: 'break', gain: vel * (kit.breakGain ?? 0.8), fade: 0.012 });
  }
  if (pad.t === 'full') {
    const bi = S.breakInfo;
    const at = transport.playing ? transport.grid(t + 0.004, 1) : t;
    return engine.play(S.breakBuf, { when: at, offset: 0, dur: (bi.bars * 240) / bi.bpm, rate: transport.bpm / bi.bpm, choke: 'break', gain: vel * (kit.breakGain ?? 0.8), fade: 0.02 });
  }
  if (pad.t === 'stab') {
    const c = S.song.current();
    const st = kit.stab;
    const len = st.len * transport.stepDur;
    c.notes.forEach((n, k) => S.stab.play(t, n + (st.oct || 0) * 12, len, vel * (st.vel ?? 0.5) * (1 - k * 0.05)));
    return null;
  }
  if (pad.t === 'sub') {
    const c = S.song.current();
    subHit(engine, engine.drums, t, c.root + 12, 0.8 * vel, transport.stepDur * 3);
    engine.duck(t, 0.5, 0.08, 0.3);
    return null;
  }
  if (pad.t === 'rewind') {
    rewind(pad, vel, t);
    return null;
  }
  return null;
}

function rewind(pad, vel, t) {
  const buf = S.bufs[pad.s];
  if (!buf || buf === true) return;
  engine.play(buf, { when: t, gain: (pad.g ?? 0.85) * vel, bus: engine.fx });
  if (!transport.playing) return;
  S.song.stop(t + 0.03);
  transport.stop();
  const restart = t + Math.min(buf.duration * 0.8, 2.2);
  transport.start(restart);
  status('Rewind', 1400);
}

function padDown(bank, i, vel = 0.9, id = 'k') {
  if (!S.kit) return;
  unlock();
  const key = `${bank}:${i}:${id}`;
  if (S.down.has(key)) return;
  const voice = soundPad(bank, i, vel);
  const pad = S.kit.pads[bank][i];
  S.down.set(key, { bank, i, vel, voice: pad?.m === 'gate' ? voice : null, next: null });
  pressUI(bank, i, true);
  flash(bank, i);
  S.lastSound = performance.now();
  wake();
}

function padUp(bank, i, id = 'k') {
  const key = `${bank}:${i}:${id}`;
  const d = S.down.get(key);
  if (!d) return;
  S.down.delete(key);
  if (d.voice) engine.release(d.voice, engine.ctx.currentTime, 0.09);
  const still = [...S.down.values()].some((x) => x.bank === bank && x.i === i);
  if (!still) pressUI(bank, i, false);
}

function releaseAll() {
  for (const d of S.down.values()) {
    if (d.voice) engine.release(d.voice, engine.ctx.currentTime, 0.09);
    pressUI(d.bank, d.i, false);
  }
  S.down.clear();
}

function rollTick() {
  if (!S.roll || !S.down.size || !engine.ctx) return;
  const ctx = engine.ctx;
  const iv = transport.stepDur * S.roll;
  const horizon = ctx.currentTime + 0.09;
  for (const d of S.down.values()) {
    if (d.next == null) d.next = transport.playing ? transport.grid(ctx.currentTime + 0.012, S.roll) : ctx.currentTime + iv;
    let n = 0;
    while (d.next < horizon && n < 8) {
      const when = d.next;
      soundPad(d.bank, d.i, d.vel * (0.72 + 0.1 * Math.random()), when);
      const delay = Math.max(0, (when - ctx.currentTime - (ctx.outputLatency || 0)) * 1000);
      setTimeout(() => flash(d.bank, d.i), delay);
      d.next += iv;
      n++;
    }
  }
  S.lastSound = performance.now();
}

function setRoll() {
  const r = S.alt ? 0.5 : S.shift ? 1 : 0;
  if (r === S.roll) return;
  S.roll = r;
  for (const d of S.down.values()) d.next = null;
  $('roll').classList.toggle('on', !!r);
  $('rollRate').textContent = r === 0.5 ? '1/32' : r === 1 ? '1/16' : 'Shift 1/16 · ⌥ 1/32';
  post();
}

function togglePlay(force) {
  unlock();
  const want = force ?? !transport.playing;
  if (!want && transport.playing) {
    transport.stop();
    S.song?.stop(engine.ctx.currentTime);
  } else if (want && !transport.playing) {
    transport.start();
  }
  document.body.classList.toggle('playing', transport.playing);
  $('play').querySelector('span').textContent = transport.playing ? 'Stop' : 'Start';
  wake();
  post();
}

function toggleLayer(layer, force) {
  const on = force ?? !S.layers[layer];
  S.layers[layer] = on;
  S.song?.setMute(layer, !on);
  document.querySelector(`[data-layer="${layer}"]`)?.classList.toggle('on', on);
  post();
}

function toggleDrop() {
  if (!S.song) return;
  unlock();
  const next = (S.song.pendingSection ?? S.section) === 'drop' ? 'break' : 'drop';
  S.song.queueSection(next);
  renderSection();
  post();
}

function renderSection() {
  const b = $('drop');
  const pending = S.song?.pendingSection || null;
  b.classList.toggle('armed', S.section === 'break');
  b.classList.toggle('pending', !!pending);
  b.firstChild.textContent = pending ? (pending === 'break' ? 'Breakdown' : 'Drop') : S.section === 'break' ? 'Drop' : 'Breakdown';
  post();
}

function setBpm(v) {
  const bpm = Math.max(140, Math.min(190, Math.round(v)));
  S.bpm[S.kit.id] = bpm;
  transport.bpm = bpm;
  S.song?.setTempo(bpm);
  engine.setDelay(0.75, bpm);
  $('bpm').textContent = bpm;
  post();
}

function switchKit(delta) {
  const i = (S.index + delta + KITS.length) % KITS.length;
  loadKit(i);
}

function buildUI() {
  for (let b = 0; b < 2; b++) {
    const grid = $('grid' + b);
    for (let row = 3; row >= 0; row--) {
      for (let col = 0; col < 4; col++) {
        const i = row * 4 + col;
        const el = document.createElement('div');
        el.className = 'pad enter';
        el.style.animationDelay = `${(3 - row) * 45 + col * 30 + b * 90}ms`;
        el.dataset.bank = b;
        el.dataset.i = i;
        el.innerHTML = `<span class="light"></span><span class="sub"></span><span class="lab"></span><span class="k">${glyph(KEYS[b][i])}</span>`;
        el.light = el.firstChild;
        el.subEl = el.children[1];
        el.labEl = el.children[2];
        grid.appendChild(el);
        pads[b][i] = el;
        bindPointer(el, b, i);
      }
    }
  }
  const steps = $('steps');
  for (let k = 0; k < 16; k++) steps.appendChild(document.createElement('i'));
  const nav = $('kits');
  KITS.forEach((k, i) => {
    const btn = document.createElement('button');
    btn.dataset.i = i;
    btn.style.setProperty('--c', k.accent);
    btn.innerHTML = `<i></i>${k.name}`;
    btn.onclick = () => { unlock(); loadKit(i); };
    nav.appendChild(btn);
  });
  $('play').onclick = () => togglePlay();
  $('drop').onclick = () => toggleDrop();
  $('tp').onclick = () => { try { native?.postMessage({ type: 'capture', on: !S.captured }); } catch {} };
  $('kitPrev').onclick = () => switchKit(-1);
  $('kitNext').onclick = () => switchKit(1);
  $('bpmDown').onclick = () => setBpm(transport.bpm - 1);
  $('bpmUp').onclick = () => setBpm(transport.bpm + 1);
  document.querySelectorAll('[data-layer]').forEach((b) => { b.onclick = () => toggleLayer(b.dataset.layer); });
  document.querySelectorAll('#skins button').forEach((b) => { b.onclick = () => setSkin(b.dataset.skin); });
  document.querySelectorAll('#bankTabs button').forEach((b) => {
    b.onclick = () => showBank(+b.dataset.show);
  });
  $('helpBtn').onclick = () => { $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  $('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
  showBank(0);
}

function showBank(b) {
  document.querySelectorAll('.bank').forEach((el) => el.classList.toggle('show', +el.dataset.bank === b));
  document.querySelectorAll('#bankTabs button').forEach((el) => el.classList.toggle('on', +el.dataset.show === b));
}

function bindPointer(el, b, i) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const p = e.pressure && e.pressure !== 0.5 ? 0.55 + e.pressure * 0.5 : 0.9;
    padDown(b, i, Math.min(1, p), 'p' + e.pointerId);
  });
  const up = (e) => padUp(b, i, 'p' + e.pointerId);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setSkin(name) {
  document.body.classList.remove('skin-graphite', 'skin-hardware', 'skin-paper');
  document.body.classList.add('skin-' + name);
  document.querySelectorAll('#skins button').forEach((b) => b.classList.toggle('on', b.dataset.skin === name));
  store?.setItem('bp.skin', name);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0b0b0c';
}

function renderKit(animate) {
  const kit = S.kit;
  document.documentElement.style.setProperty('--accent', kit.accent);
  const name = $('kitName');
  name.textContent = kit.name;
  if (animate) {
    name.classList.remove('swap');
    void name.offsetWidth;
    name.classList.add('swap');
  }
  $('kitKey').textContent = `${kit.key} · ${S.breakInfo ? breakName(kit.break) : ''}`;
  $('bpm').textContent = transport.bpm;
  document.querySelectorAll('.kits button').forEach((b) => b.classList.toggle('on', +b.dataset.i === S.index));
  document.querySelector('.kits button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  for (let b = 0; b < 2; b++) {
    kit.pads[b].forEach((p, i) => {
      const el = pads[b][i];
      let lab = p.l || '';
      let sub = '';
      el.classList.toggle('fx', p.b === 'fx' || p.t === 'rewind');
      el.classList.toggle('chop', p.t === 'chop');
      if (p.t === 'chop') {
        const sl = S.breakInfo.slices[p.i];
        lab = `CHOP ${p.i + 1}`;
        sub = sl ? `<b>${sl.label}</b> ${String(sl.step + 1).padStart(2, '0')}` : '';
      } else if (p.t === 'stab' || p.t === 'sub') {
        sub = '';
      }
      el.labEl.textContent = lab;
      el.subEl.innerHTML = sub;
      el.classList.toggle('empty', !!p.s && !sampleInfo(p.s));
      if (animate) {
        el.classList.remove('relabel');
        void el.offsetWidth;
        el.style.animationDelay = `${(b * 16 + i) * 9}ms`;
        el.classList.add('relabel');
      }
    });
  }
  renderSection();
  post();
}

function breakName(id) {
  const names = { amen165: 'Amen', amen160: 'Amen', amen173: 'Amen', think: 'Think', apache: 'Apache', apache_half: 'Apache halftime', liquid174: 'rolling break', neuro174: 'tight break', roller175: 'roller break', broke170: 'broken break', mdl170: 'dark break' };
  return (names[id] || 'break') + ` ${S.breakInfo.bpm.toFixed(0)}`;
}

function pressUI(b, i, on) {
  const el = pads[b][i];
  if (!el) return;
  el.classList.toggle('down', on);
  const pad = S.kit?.pads[b][i];
  el.classList.toggle('held', on && (pad?.m === 'gate' || !!S.roll));
}

function flash(b, i) {
  const el = pads[b][i];
  if (!el) return;
  for (const a of el.light.getAnimations()) a.cancel();
  el.light.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: 'cubic-bezier(.12,.7,.3,1)' });
  el.classList.add('flash');
  clearTimeout(el._ft);
  el._ft = setTimeout(() => el.classList.remove('flash'), 170);
}

let statusTimer;
function status(text, ms) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('on', !!text);
  clearTimeout(statusTimer);
  if (text && ms) statusTimer = setTimeout(() => el.classList.remove('on'), ms);
}

let raf = 0;
let lastStep = -1;
let lastChord = '';
const scope = $('scope');
const sctx = scope.getContext('2d');
const wave = new Uint8Array(1024);

function wake() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame() {
  raf = 0;
  const ctx = engine.ctx;
  const now = performance.now();
  const dt = Math.min(0.1, (now - (frame.last || now)) / 1000);
  frame.last = now;
  const target = S.target !== 0 ? S.target : (now - S.wheelAt < 450 ? S.filter : 0);
  const k = 1 - Math.exp(-dt * (S.target !== 0 ? 2.2 : 10));
  if (Math.abs(target - S.filter) > 0.002 || (S.target === 0 && now - S.wheelAt >= 450 && S.filter !== 0)) {
    S.filter += (target - S.filter) * k;
    if (Math.abs(S.filter) < 0.003 && S.target === 0) S.filter = 0;
    engine.sweep(S.filter);
  }
  const fm = $('filterMeter').firstChild;
  fm.style.left = S.filter < 0 ? `${50 + S.filter * 50}%` : '50%';
  fm.style.width = `${Math.abs(S.filter) * 50}%`;

  if (transport?.playing && ctx) {
    const pos = transport.at(ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0));
    const step = Math.max(0, Math.floor(pos));
    if (step !== lastStep) {
      lastStep = step;
      const s = step % 16;
      const dots = $('steps').children;
      for (let d = 0; d < 16; d++) dots[d].classList.toggle('on', d === s);
      $('bar').textContent = `${Math.floor(step / 16) + 1}.${Math.floor(s / 4) + 1}`;
      const c = S.song?.chordAt(step);
      if (c && c.name !== lastChord) {
        lastChord = c.name;
        updateChordPads(c);
      }
    }
  } else if (lastStep !== -1) {
    lastStep = -1;
    for (const d of $('steps').children) d.classList.remove('on');
    $('bar').textContent = '1.1';
    if (S.song) updateChordPads(S.song.prog[0]);
  }

  drawScope();
  const busy = transport?.playing || now - S.lastSound < 2500 || S.filter !== 0 || S.target !== 0 || S.down.size > 0;
  if (busy) raf = requestAnimationFrame(frame);
  else frame.last = 0;
}

function updateChordPads(c) {
  if (!S.kit) return;
  S.kit.pads[0].forEach((p, i) => {
    if (p.t === 'stab') pads[0][i].subEl.textContent = c.name;
    if (p.t === 'sub') pads[0][i].subEl.textContent = c.name.match(/^[A-G][b#]?/)[0];
  });
}

function drawScope() {
  const w = scope.width;
  const h = scope.height;
  sctx.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.body);
  const accent = style.getPropertyValue('--accent').trim();
  const faint = style.getPropertyValue('--faint').trim();
  if (!engine.analyser) {
    sctx.fillStyle = faint;
    sctx.fillRect(0, h / 2, w, 1.5);
    return;
  }
  engine.analyser.getByteTimeDomainData(wave);
  let peak = 0;
  for (let i = 0; i < wave.length; i++) peak = Math.max(peak, Math.abs(wave[i] - 128));
  sctx.lineWidth = 3;
  sctx.lineJoin = 'round';
  sctx.strokeStyle = peak > 2 ? accent : faint;
  sctx.beginPath();
  const n = wave.length;
  for (let i = 0; i < n; i += 2) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 + ((wave[i] - 128) / 128) * h * 0.46;
    if (i === 0) sctx.moveTo(x, y);
    else sctx.lineTo(x, y);
  }
  sctx.stroke();
}

function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey) return;
  const code = e.code;
  if (!$('help').hidden) {
    if (code === 'Escape' || code === 'Enter' || code === 'Space') { $('help').hidden = true; e.preventDefault(); }
    return;
  }
  if (code === 'ShiftLeft' || code === 'ShiftRight') { S.shift = true; setRoll(); return; }
  if (code === 'AltLeft' || code === 'AltRight') { S.alt = true; setRoll(); e.preventDefault(); return; }
  const m = KEYMAP.get(code);
  if (m) {
    e.preventDefault();
    if (!e.repeat) padDown(m[0], m[1], 0.9, code);
    return;
  }
  const handled = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'KeyT', 'KeyY', 'KeyG', 'KeyH', 'Digit5', 'Digit6', 'Tab'];
  if (handled.includes(code)) e.preventDefault();
  if (e.repeat) return;
  switch (code) {
    case 'Space': togglePlay(); break;
    case 'ArrowLeft': switchKit(-1); break;
    case 'ArrowRight': switchKit(1); break;
    case 'ArrowUp': S.target = 1; unlock(); wake(); break;
    case 'ArrowDown': S.target = -1; unlock(); wake(); break;
    case 'Enter': toggleDrop(); break;
    case 'KeyT': toggleLayer('chords'); break;
    case 'KeyY': toggleLayer('bass'); break;
    case 'KeyG': toggleLayer('atmos'); break;
    case 'KeyH': toggleLayer('guide'); break;
    case 'Digit5': setBpm(transport.bpm - 1); break;
    case 'Digit6': setBpm(transport.bpm + 1); break;
    default: break;
  }
}

function onKeyUp(e) {
  const code = e.code;
  if (code === 'ShiftLeft' || code === 'ShiftRight') { S.shift = false; setRoll(); return; }
  if (code === 'AltLeft' || code === 'AltRight') { S.alt = false; setRoll(); return; }
  const m = KEYMAP.get(code);
  if (m) { padUp(m[0], m[1], code); return; }
  if ((code === 'ArrowUp' && S.target > 0) || (code === 'ArrowDown' && S.target < 0)) { S.target = 0; wake(); }
}

function onWheel(e) {
  if (!$('help').hidden || S.captured) return;
  e.preventDefault();
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  S.filter = Math.max(-1, Math.min(1, S.filter - d * 0.0032));
  S.wheelAt = performance.now();
  engine.sweep(S.filter);
  wake();
}

function post() {
  if (!native || !S.kit) return;
  try {
    native.postMessage({
      type: 'state',
      kit: S.kit.name,
      kitIndex: S.index,
      kits: KITS.map((k) => k.name),
      accent: S.kit.accent,
      playing: !!transport?.playing,
      section: S.section,
      pending: S.song?.pendingSection || null,
      layers: S.layers,
      roll: S.roll,
      bpm: transport?.bpm,
      fx: S.kit.pads[1].slice(8).map((p) => p.l),
    });
  } catch {}
}

const fingers = new Map();
function showTouches(list) {
  const banks = $('banks');
  const box = banks.getBoundingClientRect();
  const seen = new Set();
  for (const t of list) {
    const b = t.x < 0.5 ? 0 : 1;
    const g = $('grid' + b).getBoundingClientRect();
    const lx = (t.x - b * 0.5) * 2;
    let el = fingers.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'finger';
      banks.appendChild(el);
      fingers.set(t.id, el);
    }
    el.style.left = `${g.left - box.left + lx * g.width}px`;
    el.style.top = `${g.top - box.top + (1 - t.y) * g.height}px`;
    seen.add(t.id);
  }
  for (const [id, el] of fingers) {
    if (!seen.has(id)) { el.remove(); fingers.delete(id); }
  }
}

window.BP = {
  pad: (b, i, vel = 0.9, id = 't') => padDown(b, i, vel, id),
  padUp: (b, i, id = 't') => padUp(b, i, id),
  touches: (list) => showTouches(list || []),
  capture: (on) => {
    S.captured = !!on;
    document.body.classList.toggle('captured', S.captured);
    if (!on) { showTouches([]); releaseAll(); }
  },
  filter: (x) => { S.filter = Math.max(-1, Math.min(1, x)); S.wheelAt = performance.now(); engine.sweep(S.filter); wake(); },
  cmd: (name, arg) => {
    unlock();
    if (name === 'play') togglePlay();
    else if (name === 'kitNext') switchKit(1);
    else if (name === 'kitPrev') switchKit(-1);
    else if (name === 'kit') loadKit(+arg);
    else if (name === 'drop') toggleDrop();
    else if (name === 'layer') toggleLayer(arg);
    else if (name === 'roll') { S.shift = arg !== 0.5; S.alt = arg === 0.5; setRoll(); }
    else if (name === 'rollEnd') { S.shift = false; S.alt = false; setRoll(); }
    else if (name === 'bpm') setBpm(transport.bpm + (+arg || 0));
    else if (name === 'fx') { padDown(1, 8 + (+arg), 0.9, 'tb'); setTimeout(() => padUp(1, 8 + (+arg), 'tb'), 0); }
    else if (name === 'fxDown') padDown(1, 8 + (+arg), 0.9, 'tb');
    else if (name === 'fxUp') padUp(1, 8 + (+arg), 'tb');
    else if (name === 'release') releaseAll();
  },
  state: () => ({ kit: S.kit?.id, playing: transport?.playing, section: S.section, layers: S.layers, roll: S.roll, bpm: transport?.bpm, filter: S.filter, audio: engine.ctx?.state }),
  level: () => {
    const a = new Float32Array(engine.analyser.fftSize);
    engine.analyser.getFloatTimeDomainData(a);
    let p = 0;
    let s = 0;
    for (const v of a) { p = Math.max(p, Math.abs(v)); s += v * v; }
    return { peak: +(20 * Math.log10(p + 1e-9)).toFixed(1), rms: +(10 * Math.log10(s / a.length + 1e-12)).toFixed(1) };
  },
};

async function boot() {
  engine.base = '';
  engine.ensure();
  transport = new Transport(engine);
  transport.listeners.add((step, t) => S.song?.step(step, t));
  transport.onTick = rollTick;
  setSkin(store?.getItem('bp.skin') || 'graphite');
  buildUI();
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('wheel', onWheel, { passive: false });
  addEventListener('blur', () => { releaseAll(); S.shift = S.alt = false; setRoll(); S.target = 0; });
  addEventListener('pointerdown', unlock, { capture: true });
  S.manifest = await (await fetch('sounds/manifest.json')).json();
  const saved = store?.getItem('bp.kit');
  const idx = Math.max(0, KITS.findIndex((k) => k.id === saved));
  await loadKit(idx);
  drawScope();
  if (native) native.postMessage({ type: 'ready' });
  setTimeout(prefetch, 1500);
}

boot();
