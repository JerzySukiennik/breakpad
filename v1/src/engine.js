// Breakpad engine: audio graph, sample loading, voices, choke groups, ducking and the master filter.
export class Engine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.pending = new Map();
    this.offsets = new WeakMap();
    this.reversed = new WeakMap();
    this.chokes = new Map();
    this.base = '';
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.master = gain(0.68);
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.8;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 1.1;
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -16;
    this.glue.knee.value = 8;
    this.glue.ratio.value = 2.5;
    this.glue.attack.value = 0.012;
    this.glue.release.value = 0.16;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.09;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.hp).connect(this.lp).connect(this.glue).connect(this.limiter);
    this.out = gain(/[?&]silent/.test(location.search) ? 0 : 1);
    this.limiter.connect(this.out).connect(ctx.destination);
    this.limiter.connect(this.analyser);

    this.drums = gain(0.5);
    this.drive = ctx.createWaveShaper();
    this.drive.oversample = '2x';
    this.setDrive(0);
    this.drumComp = ctx.createDynamicsCompressor();
    this.drumComp.threshold.value = -12;
    this.drumComp.knee.value = 4;
    this.drumComp.ratio.value = 3;
    this.drumComp.attack.value = 0.004;
    this.drumComp.release.value = 0.09;
    this.drums.connect(this.drive).connect(this.drumComp).connect(this.master);

    this.music = gain(1);
    this.duckGain = gain(1);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.7;
    this.music.connect(this.musicFilter).connect(this.duckGain).connect(this.master);

    this.fx = gain(0.55);
    this.fx.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 3.2);
    this.reverbOut = gain(0.32);
    this.reverbIn = gain(1);
    const revHp = ctx.createBiquadFilter();
    revHp.type = 'highpass';
    revHp.frequency.value = 220;
    this.reverbIn.connect(revHp).connect(this.reverb).connect(this.reverbOut).connect(this.master);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.26;
    this.delayFb = gain(0.42);
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2600;
    const dhp = ctx.createBiquadFilter();
    dhp.type = 'highpass';
    dhp.frequency.value = 300;
    this.delayIn = gain(1);
    this.delayOut = gain(0.5);
    this.delayIn.connect(this.delay);
    this.delay.connect(dlp).connect(dhp).connect(this.delayFb).connect(this.delay);
    dhp.connect(this.delayOut).connect(this.master);
    return ctx;
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const k = 0.55 - 0.45 * t;
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, decay) * (i < 300 ? i / 300 : 1);
      }
    }
    return buf;
  }

  setDrive(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 1 + amount * 6;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = amount <= 0 ? x : Math.tanh(k * x) / norm;
    }
    if (this.drive) this.drive.curve = curve;
  }

  setDelay(beats, bpm) {
    if (!this.ctx) return;
    this.delay.delayTime.setTargetAtTime((60 / bpm) * beats, this.ctx.currentTime, 0.05);
  }

  async load(path, { trim = true } = {}) {
    const url = this.base + path;
    if (this.buffers.has(url)) return this.buffers.get(url);
    if (this.pending.has(url)) return this.pending.get(url);
    const p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.offsets.set(buf, trim ? this.leading(buf) : 0);
      this.buffers.set(url, buf);
      this.pending.delete(url);
      return buf;
    })();
    this.pending.set(url, p);
    return p;
  }

  leading(buf) {
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    const thr = peak * 0.03;
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]) > thr) return Math.max(0, i - Math.floor(buf.sampleRate * 0.0015)) / buf.sampleRate;
    }
    return 0;
  }

  reverse(buf) {
    if (this.reversed.has(buf)) return this.reversed.get(buf);
    const r = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c);
      const d = r.getChannelData(c);
      for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i];
    }
    this.offsets.set(r, 0);
    this.reversed.set(buf, r);
    return r;
  }

  play(buf, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !buf) return null;
    const t = Math.max(o.when ?? ctx.currentTime, ctx.currentTime);
    const b = o.reverse ? this.reverse(buf) : buf;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const rate = o.rate ?? 1;
    src.playbackRate.setValueAtTime(rate, t);
    const g = ctx.createGain();
    const vol = o.gain ?? 1;
    let node = src;
    if (o.lowpass || o.highpass) {
      const f = ctx.createBiquadFilter();
      f.type = o.lowpass ? 'lowpass' : 'highpass';
      f.frequency.value = o.lowpass || o.highpass;
      f.Q.value = o.q ?? 0.7;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    let out = g;
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      g.connect(p);
      out = p;
    }
    out.connect(o.bus || this.drums);
    if (o.reverb) {
      const s = ctx.createGain();
      s.gain.value = o.reverb;
      out.connect(s).connect(this.reverbIn);
    }
    if (o.delay) {
      const s = ctx.createGain();
      s.gain.value = o.delay;
      out.connect(s).connect(this.delayIn);
    }
    const offset = (o.offset ?? (o.reverse ? 0 : this.offsets.get(b) || 0));
    const atk = o.attack ?? 0.0015;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + atk);
    const voice = { src, g, t, ended: false, stop: (when, fade) => this.release(voice, when, fade) };
    if (o.dur) {
      const real = o.dur / rate;
      const fd = Math.min(o.fade ?? 0.012, real * 0.5);
      g.gain.setValueAtTime(vol, t + Math.max(atk, real - fd));
      g.gain.linearRampToValueAtTime(0, t + real);
      src.start(t, offset, o.dur + 0.02);
      src.stop(t + real + 0.03);
    } else {
      src.start(t, offset);
    }
    src.onended = () => {
      voice.ended = true;
      try { out.disconnect(); } catch {}
    };
    if (o.choke) {
      const list = this.chokes.get(o.choke) || [];
      for (const v of list) if (!v.ended) v.stop(t, 0.006);
      this.chokes.set(o.choke, [voice]);
    }
    return voice;
  }

  release(voice, when, fade = 0.05) {
    if (!voice || voice.ended) return;
    const ctx = this.ctx;
    const t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
    const g = voice.g.gain;
    g.cancelScheduledValues(t);
    if (t <= ctx.currentTime + 0.001) g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, fade / 4);
    try { voice.src.stop(t + fade * 2 + 0.02); } catch {}
  }

  duck(when, depth = 0.35, hold = 0.02, release = 0.18) {
    const g = this.duckGain.gain;
    const t = Math.max(when, this.ctx.currentTime);
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - depth, t, 0.004);
    g.setTargetAtTime(1, t + hold, release / 3);
  }

  sweep(x) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const lpF = x < 0 ? 22000 * Math.pow(160 / 22000, Math.min(1, -x)) : 22000;
    const hpF = x > 0 ? 10 * Math.pow(2200 / 10, Math.min(1, x)) : 10;
    this.lp.frequency.setTargetAtTime(lpF, t, 0.03);
    this.hp.frequency.setTargetAtTime(hpF, t, 0.03);
    this.lp.Q.setTargetAtTime(x < -0.05 ? 4 : 1.1, t, 0.05);
    this.hp.Q.setTargetAtTime(x > 0.05 ? 3.5 : 0.8, t, 0.05);
  }
}
