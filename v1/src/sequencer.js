// Breakpad transport and backing track: a lookahead 16th-step clock driving chords, pads, bass, atmos and the guide loop.
import { Bass, Sampler } from './synth.js';

const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14], 9: [0, 4, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], dim: [0, 3, 6], 5: [0, 7], '6/9': [0, 4, 7, 9, 14],
  m7b5: [0, 3, 6, 10], maj7s11: [0, 4, 7, 11, 18],
};
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export function chord(name, lo = 53, hi = 77) {
  const m = name.match(/^([A-G][b#]?)(.*)$/);
  const pc = PC[m[1]];
  const ints = QUAL[m[2]] ?? QUAL[''];
  const notes = ints.map((i) => {
    let n = 48 + pc + i;
    while (n < lo) n += 12;
    while (n > hi) n -= 12;
    return n;
  });
  return { name, pc, notes: [...new Set(notes)].sort((a, b) => a - b), root: 24 + pc };
}

export class Transport {
  constructor(engine) {
    this.engine = engine;
    this.bpm = 174;
    this.playing = false;
    this.step = 0;
    this.next = 0;
    this.listeners = new Set();
    const src = 'let t=null;onmessage=e=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),e.data)}';
    try {
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.worker.onmessage = () => this.tick();
      this.worker.postMessage(20);
    } catch {
      setInterval(() => this.tick(), 20);
    }
  }

  get stepDur() { return 60 / this.bpm / 4; }

  start(at) {
    const ctx = this.engine.ctx;
    this.playing = true;
    this.step = 0;
    this.next = at ?? ctx.currentTime + 0.06;
    this.t0 = this.next;
    this.tick();
  }

  stop() { this.playing = false; }

  tick() {
    if (this.onTick) this.onTick();
    if (!this.playing) return;
    const ctx = this.engine.ctx;
    const horizon = ctx.currentTime + 0.12;
    while (this.next < horizon) {
      for (const fn of this.listeners) fn(this.step, this.next);
      this.step += 1;
      this.next += this.stepDur;
    }
  }

  at(t) {
    if (!this.playing) return null;
    return this.step - (this.next - t) / this.stepDur;
  }

  grid(t, div = 1) {
    if (!this.playing) return t;
    const pos = this.at(t);
    const g = Math.ceil(pos / div - 1e-6) * div;
    return this.next - (this.step - g) * this.stepDur;
  }
}

export class Song {
  constructor(engine, transport, kit, manifest) {
    this.engine = engine;
    this.transport = transport;
    this.kit = kit;
    this.manifest = manifest;
    this.parts = [];
    this.layers = {};
    this.mutes = { chords: false, bass: false, atmos: false, guide: true };
    this.section = 'drop';
    this.pendingSection = null;
    this.prog = [];
    this.voices = new Set();
    this.onSection = null;
  }

  async load() {
    const { engine, kit, manifest } = this;
    const ctx = engine.ctx;
    this.bus = ctx.createGain();
    this.bus.connect(engine.music);
    for (const name of ['chords', 'bass', 'atmos', 'guide']) {
      const g = ctx.createGain();
      g.gain.value = this.mutes[name] ? 0 : 1;
      g.connect(this.bus);
      this.layers[name] = g;
    }
    this.sectionGain = ctx.createGain();
    this.sectionGain.connect(this.layers.bass);
    let step = 0;
    for (const [name, bars] of kit.chords) {
      const c = chord(name, kit.range?.[0] ?? 53, kit.range?.[1] ?? 77);
      this.prog.push({ ...c, start: step, len: bars * 16 });
      step += bars * 16;
    }
    this.loopSteps = step;
    const jobs = [];
    for (const p of kit.parts) {
      const part = { ...p };
      const out = ctx.createGain();
      out.gain.value = (p.gain ?? 1) * (p.type === 'bass' ? 0.1 : 0.36);
      let node = out;
      if (p.lowpass) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = p.lowpass;
        f.Q.value = 0.6;
        out.connect(f);
        node = f;
      }
      node.connect(p.type === 'bass' ? this.sectionGain : this.layers[p.layer || 'chords']);
      part.out = out;
      if (p.type === 'bass') {
        part.synth = new Bass(engine, out, p.synth, this.transport.bpm);
      } else if (p.inst) {
        part.sampler = new Sampler(engine, manifest.inst[p.inst], out, { gain: p.vel ?? 0.5, attack: p.attack, release: p.release, reverb: p.reverb, delay: p.delay });
        jobs.push(part.sampler.load());
      }
      this.parts.push(part);
    }
    if (kit.atmos) {
      jobs.push(engine.load('sounds/' + manifest.atmos[kit.atmos.s].file).then((b) => { this.atmosBuf = b; }));
    }
    if (kit.guide !== false) {
      const g = manifest.breaks[kit.guide?.s || 'guide165'];
      jobs.push(engine.load('sounds/' + g.file, { trim: false }).then((b) => { this.guideBuf = b; this.guideInfo = g; }));
    }
    await Promise.all(jobs);
  }

  chordAt(step) {
    const s = ((step % this.loopSteps) + this.loopSteps) % this.loopSteps;
    for (const c of this.prog) if (s >= c.start && s < c.start + c.len) return c;
    return this.prog[0];
  }

  current() {
    const tr = this.transport;
    if (!tr.playing) return this.prog[0];
    return this.chordAt(Math.max(0, Math.floor(tr.at(this.engine.ctx.currentTime))));
  }

  setMute(layer, on) {
    this.mutes[layer] = on;
    const g = this.layers[layer];
    if (g) g.gain.setTargetAtTime(on ? 0 : 1, this.engine.ctx.currentTime, 0.03);
  }

  queueSection(name) {
    this.pendingSection = name;
    if (!this.transport.playing) this.applySection(name, this.engine.ctx.currentTime);
  }

  applySection(name, t) {
    this.section = name;
    this.pendingSection = null;
    const f = this.engine.musicFilter.frequency;
    const g = this.sectionGain.gain;
    const bar = this.transport.stepDur * 16;
    f.cancelScheduledValues(t);
    g.cancelScheduledValues(t);
    if (name === 'break') {
      f.setValueAtTime(f.value, t);
      f.exponentialRampToValueAtTime(this.kit.breakdownCut ?? 900, t + bar * 0.5);
      g.setTargetAtTime(0, t, 0.02);
    } else {
      f.setValueAtTime(Math.max(200, f.value), t);
      f.exponentialRampToValueAtTime(20000, t + 0.05);
      g.setTargetAtTime(1, t, 0.005);
    }
    if (this.onSection) this.onSection(name, t);
  }

  startAtmos(t) {
    if (!this.atmosBuf || this.atmosVoice) return;
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.atmosBuf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(this.kit.atmos.gain ?? 1, t + 1.2);
    src.connect(g).connect(this.layers.atmos);
    src.start(t, Math.random() * this.atmosBuf.duration * 0.5);
    this.atmosVoice = { src, g };
  }

  stopAtmos(t) {
    const v = this.atmosVoice;
    if (!v) return;
    this.atmosVoice = null;
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setTargetAtTime(0, t, 0.25);
    v.src.stop(t + 1.5);
  }

  step(step, t) {
    const sd = this.transport.stepDur;
    const s = step % 16;
    if (s === 0 && this.pendingSection) this.applySection(this.pendingSection, t);
    if (step === 0) this.startAtmos(t);
    const c = this.chordAt(step);
    const loopPos = ((step % this.loopSteps) + this.loopSteps) % this.loopSteps;
    const chordStep = loopPos - c.start;
    const barInChord = Math.floor(chordStep / 16);
    for (const p of this.parts) {
      if (p.type === 'pad') {
        if (chordStep === 0) this.track(p.sampler, c.notes.map((n, i) => p.sampler.play(t, n + (p.oct || 0) * 12, c.len * sd, 0.9 - i * 0.04, { pan: (i / Math.max(1, c.notes.length - 1) - 0.5) * 0.5 })));
      } else if (p.type === 'stabs') {
        const pat = p.pattern[barInChord % p.pattern.length];
        for (const ev of pat) {
          if (ev[0] !== s) continue;
          const notes = p.top ? c.notes.slice(-p.top) : c.notes;
          this.track(p.sampler, notes.map((n) => p.sampler.play(t, n + (p.oct || 0) * 12, ev[1] * sd, ev[2] ?? 1)));
        }
      } else if (p.type === 'arp') {
        const pat = p.pattern[(barInChord + Math.floor(loopPos / 16)) % p.pattern.length];
        for (const ev of pat) {
          if (ev[0] !== s) continue;
          const pool = c.notes.concat(c.notes.map((n) => n + 12));
          const n = pool[ev[1] % pool.length] + (p.oct || 0) * 12;
          this.track(p.sampler, [p.sampler.play(t, n, ev[2] * sd, ev[3] ?? 1)]);
        }
      } else if (p.type === 'bass') {
        const pat = p.pattern[Math.floor(loopPos / 16) % p.pattern.length];
        for (const ev of pat) {
          if (ev[0] !== s) continue;
          const midi = c.root + (p.oct ?? 0) * 12 + (ev[2] ?? 0);
          p.synth.note(t, midi, ev[1] * sd - 0.004, { glide: !!ev[3], legato: !!ev[3], vel: ev[4] ?? 1 });
        }
      }
    }
    if (this.guideBuf && s === 0) {
      const gi = this.guideInfo;
      const gb = gi.bars;
      const bar = Math.floor(step / 16) % gb;
      const rate = this.transport.bpm / gi.bpm;
      const barLen = 240 / gi.bpm;
      this.engine.play(this.guideBuf, { when: t, rate, offset: bar * barLen, dur: barLen, fade: 0.004, gain: this.kit.guide?.gain ?? 0.4, bus: this.layers.guide });
    }
  }

  track(sampler, voices) {
    for (const v of voices) {
      if (!v) continue;
      this.voices.add(v);
      v.src.addEventListener('ended', () => this.voices.delete(v));
    }
  }

  stop(t) {
    for (const v of this.voices) this.engine.release(v, t, 0.12);
    this.voices.clear();
    for (const p of this.parts) if (p.synth) p.synth.silence(t);
    this.stopAtmos(t);
  }

  setTempo(bpm) {
    for (const p of this.parts) if (p.synth) p.synth.setTempo(bpm);
  }

  dispose() {
    const t = this.engine.ctx.currentTime;
    this.stop(t);
    for (const p of this.parts) if (p.synth) p.synth.dispose();
    setTimeout(() => { try { this.bus.disconnect(); } catch {} }, 600);
  }
}
