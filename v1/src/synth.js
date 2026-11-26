// Breakpad instruments: mono bass synths (sub, reese, wobble, dub, hoover), a sub hit and a multisample player.
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function shaper(ctx, amount) {
  const n = 1024;
  const c = new Float32Array(n);
  const k = 1 + amount * 8;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  const s = ctx.createWaveShaper();
  s.curve = c;
  s.oversample = '2x';
  return s;
}

export class Bass {
  constructor(engine, out, spec, bpm) {
    const ctx = engine.ctx;
    this.ctx = ctx;
    this.spec = spec;
    this.oscs = [];
    this.freqs = [];
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.amp.connect(out);
    const level = ctx.createGain();
    level.gain.value = spec.gain ?? 0.8;
    const type = spec.type;
    const osc = (wave, mult = 1, detune = 0, g = 1, dest) => {
      const o = ctx.createOscillator();
      o.type = wave;
      o.detune.value = detune;
      const gg = ctx.createGain();
      gg.gain.value = g;
      o.connect(gg).connect(dest);
      o.start();
      this.oscs.push(o);
      this.freqs.push({ param: o.frequency, mult });
      return o;
    };
    const lfo = (rate, depth, param) => {
      const l = ctx.createOscillator();
      l.frequency.value = rate;
      const d = ctx.createGain();
      d.gain.value = depth;
      l.connect(d).connect(param);
      l.start();
      this.oscs.push(l);
      return l;
    };
    const subBus = ctx.createGain();
    subBus.gain.value = spec.sub ?? 0.9;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    subLp.frequency.value = 160;
    subBus.connect(subLp).connect(level);
    if (type === 'sub' || type === 'dub') {
      const pre = ctx.createGain();
      pre.gain.value = 1;
      const sh = shaper(ctx, spec.drive ?? 0.25);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = spec.cutoff ?? 320;
      pre.connect(sh).connect(lp).connect(level);
      osc('sine', 1, 0, 1, pre);
      osc(type === 'dub' ? 'triangle' : 'sine', 2, 0, type === 'dub' ? 0.18 : 0.1, pre);
      this.bend = type === 'dub' ? 1.5 : 0;
    } else if (type === 'reese' || type === 'hoover') {
      const pre = ctx.createGain();
      pre.gain.value = 0.32;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = spec.cutoff ?? 700;
      lp.Q.value = spec.q ?? 2;
      const sh = shaper(ctx, spec.drive ?? 0.5);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      pre.connect(lp).connect(sh).connect(hp).connect(level);
      const spread = spec.spread ?? 16;
      const mult = type === 'hoover' ? 2 : 1;
      osc('sawtooth', mult, -spread, 1, pre);
      osc('sawtooth', mult, spread, 1, pre);
      osc('sawtooth', mult, spread * 0.4, 0.7, pre);
      if (type === 'hoover') osc('square', 1, -spread * 1.6, 0.6, pre);
      lfo(spec.lfo ?? 0.18, spec.lfoDepth ?? 380, lp.frequency);
      osc('sine', 1, 0, 1, subBus);
      this.bend = type === 'hoover' ? 7 : 0;
    } else if (type === 'wobble') {
      const pre = ctx.createGain();
      pre.gain.value = 0.36;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = spec.cutoff ?? 500;
      lp.Q.value = spec.q ?? 9;
      const sh = shaper(ctx, spec.drive ?? 0.6);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 100;
      pre.connect(lp).connect(sh).connect(hp).connect(level);
      osc('sawtooth', 1, -8, 1, pre);
      osc('square', 1, 8, 0.6, pre);
      this.wob = lfo((bpm / 60) * (spec.rate ?? 2), spec.lfoDepth ?? 900, lp.frequency);
      osc('sine', 1, 0, 1, subBus);
      this.bend = 0;
    }
    level.connect(this.amp);
    this.level = level;
    this.last = 0;
  }

  setTempo(bpm) {
    if (this.wob) this.wob.frequency.setTargetAtTime((bpm / 60) * (this.spec.rate ?? 2), this.ctx.currentTime, 0.05);
  }

  note(t, midi, dur, { glide = false, vel = 1, legato = false } = {}) {
    const f = mtof(midi);
    for (const { param, mult } of this.freqs) {
      if (glide) {
        param.setTargetAtTime(f * mult, t, 0.035);
      } else if (this.bend) {
        param.setValueAtTime(f * mult * Math.pow(2, this.bend / 12), t);
        param.setTargetAtTime(f * mult, t + 0.002, 0.03);
      } else {
        param.setValueAtTime(f * mult, t);
      }
    }
    const g = this.amp.gain;
    if (!legato) {
      g.setTargetAtTime(0, t - 0.004, 0.0015);
      g.setTargetAtTime(vel, t, 0.003);
    } else {
      g.setTargetAtTime(vel, t, 0.01);
    }
    g.setTargetAtTime(0, t + dur, this.spec.release ?? 0.03);
  }

  silence(t) {
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setTargetAtTime(0, t, 0.01);
  }

  dispose() {
    const t = this.ctx.currentTime;
    this.silence(t);
    setTimeout(() => {
      for (const o of this.oscs) { try { o.stop(); } catch {} }
      try { this.amp.disconnect(); } catch {}
    }, 200);
  }
}

export function subHit(engine, out, t, midi, gain = 0.9, len = 0.55) {
  const ctx = engine.ctx;
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = mtof(midi);
  o.frequency.setValueAtTime(f * 2.4, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.setTargetAtTime(gain * 0.75, t + 0.02, 0.08);
  g.gain.setTargetAtTime(0, t + len, 0.06);
  const sh = shaper(ctx, 0.35);
  o.connect(sh).connect(g).connect(out);
  o.start(t);
  o.stop(t + len + 0.4);
  o.onended = () => { try { g.disconnect(); } catch {} };
}

export class Sampler {
  constructor(engine, inst, out, opts = {}) {
    this.engine = engine;
    this.inst = inst;
    this.out = out;
    this.opts = opts;
    this.map = [];
  }

  async load() {
    const list = await Promise.all(this.inst.notes.map(async (n) => ({ midi: n.midi, buf: await this.engine.load('sounds/' + n.file) })));
    this.map = list.sort((a, b) => a.midi - b.midi);
  }

  nearest(midi) {
    let best = this.map[0];
    for (const s of this.map) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    return best;
  }

  play(t, midi, len, vel = 1, extra = {}) {
    if (!this.map.length) return null;
    const s = this.nearest(midi);
    const rate = Math.pow(2, (midi - s.midi) / 12);
    const o = this.opts;
    const rel = extra.release ?? o.release ?? 0.25;
    const maxDur = s.buf.duration - (this.engine.offsets.get(s.buf) || 0);
    const dur = Math.min(maxDur, (len + rel) * rate);
    return this.engine.play(s.buf, {
      when: t,
      rate,
      gain: vel * (o.gain ?? 0.5),
      bus: this.out,
      attack: extra.attack ?? o.attack ?? 0.004,
      dur,
      fade: rel,
      pan: extra.pan ?? 0,
      reverb: o.reverb ?? 0,
      delay: o.delay ?? 0,
    });
  }
}
