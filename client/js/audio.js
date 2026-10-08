// Procedural sound effects and music using the Web Audio API. No audio files.

const NOTE = (semis) => 440 * Math.pow(2, semis / 12); // semis relative to A4

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.sfxOn = true;
    this.musicOn = true;
    this.vibrateOn = true;
    this.musicWanted = false;
    this.noiseBuf = null;
    this.timer = null;
  }

  // Must be called from a user gesture the first time.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.ratio.value = 4;
      this.master.connect(this.comp).connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxOn ? 1 : 0;
      this.sfx.connect(this.master);
      this.music = this.ctx.createGain();
      this.music.gain.value = 0;
      this.music.connect(this.master);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      if (this.musicWanted) this.startMusic();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setSfx(on) {
    this.sfxOn = on;
    if (this.sfx) this.sfx.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  setMusic(on) {
    this.musicOn = on;
    if (on && this.musicWanted) this.startMusic();
    else this.stopMusic();
  }

  setVibrate(on) {
    this.vibrateOn = on;
  }

  vibrate(pattern) {
    if (this.vibrateOn && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* not allowed before user gesture */ }
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get now() {
    return this.ctx.currentTime;
  }

  tone(freq, t, dur, { type = 'triangle', gain = 0.3, attack = 0.005, slideTo = null, slideTime = dur, filter = null, q = 1, dest = this.sfx, vibrato = 0 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + slideTime);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 11;
      lg.gain.value = vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq;
      f.Q.value = q;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(t, dur, { gain = 0.3, freq = 2000, type = 'bandpass', q = 1.2, dest = this.sfx, sweepTo = null } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  play(name, arg) {
    if (!this.ctx || !this.sfxOn || this.ctx.state !== 'running') return;
    const t = this.now + 0.005;
    const fn = SFX[name];
    if (fn) fn(this, t, arg);
  }

  startMusic() {
    this.musicWanted = true;
    if (!this.ctx || !this.musicOn || this.timer) return;
    this.music.gain.cancelScheduledValues(this.now);
    this.music.gain.setTargetAtTime(0.16, this.now, 0.4);
    this.step = 0;
    this.nextTime = this.now + 0.1;
    this.melodyNote = 0;
    this.timer = setInterval(() => this.schedule(), 60);
  }

  stopMusic(keepWanted = false) {
    if (!keepWanted) this.musicWanted = false;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.music) this.music.gain.setTargetAtTime(0, this.now, 0.15);
  }

  // Lookahead scheduler: bouncy bass + generative pentatonic melody + light percussion.
  schedule() {
    if (this.ctx.state !== 'running') return;
    const spb = 60 / 116 / 2; // eighth notes at 116 bpm
    const prog = [[-9, [0, 4, 7]], [-2, [0, 4, 7]], [0, [0, 3, 7]], [-4, [0, 4, 7]]]; // C G Am F
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    while (this.nextTime < this.now + 0.25) {
      const t = this.nextTime;
      const s = this.step;
      const bar = Math.floor(s / 8) % prog.length;
      const [root, chord] = prog[bar];
      const beat = s % 8;
      const m = this.music;
      // Bass: root on beats, octave hop on offbeats.
      const bassNote = root - 24 + (beat % 2 ? 12 : 0) + (beat === 6 ? 7 : 0);
      this.tone(NOTE(bassNote), t, spb * 0.9, { type: 'triangle', gain: 0.22, dest: m, filter: { freq: 900 } });
      // Percussion.
      if (beat % 4 === 0) this.tone(120, t, 0.12, { type: 'sine', gain: 0.25, slideTo: 45, dest: m });
      if (beat % 2 === 1) this.noise(t, 0.04, { gain: 0.05, freq: 8000, type: 'highpass', dest: m });
      if (beat === 4) this.noise(t, 0.09, { gain: 0.07, freq: 1800, dest: m });
      // Melody: random walk over the scale, landing on chord tones on strong beats.
      if (Math.random() < (beat % 2 ? 0.45 : 0.8)) {
        let idx = this.melodyNote + Math.round((Math.random() - 0.5) * 3);
        idx = Math.max(0, Math.min(scale.length - 1, idx));
        if (beat % 4 === 0) {
          const target = chord[Math.floor(Math.random() * chord.length)];
          idx = scale.reduce((bi, v, i) => (Math.abs(v - target) < Math.abs(scale[bi] - target) ? i : bi), 0);
        }
        this.melodyNote = idx;
        const note = root + scale[idx] + 3;
        this.tone(NOTE(note), t, spb * 0.85, { type: 'square', gain: 0.05, dest: m, filter: { freq: 2600 } });
        this.tone(NOTE(note + 12), t, spb * 0.5, { type: 'sine', gain: 0.03, dest: m });
      }
      this.nextTime += spb;
      this.step++;
    }
  }
}

const SFX = {
  tap(a, t) {
    a.tone(620, t, 0.07, { type: 'sine', gain: 0.25, slideTo: 300 });
  },
  rattle(a, t) {
    for (let i = 0; i < 7; i++) {
      const tt = t + i * (0.035 + Math.random() * 0.03);
      a.noise(tt, 0.03, { gain: 0.22, freq: 2200 + Math.random() * 2500, q: 3 });
      a.tone(900 + Math.random() * 900, tt, 0.025, { type: 'square', gain: 0.03, filter: { freq: 3000 } });
    }
  },
  land(a, t) {
    a.noise(t, 0.05, { gain: 0.35, freq: 1700, q: 4 });
    a.tone(820, t, 0.09, { type: 'triangle', gain: 0.25, slideTo: 520 });
    a.tone(330, t, 0.12, { type: 'sine', gain: 0.25, slideTo: 180 });
    a.noise(t + 0.07, 0.03, { gain: 0.12, freq: 2400, q: 4 });
  },
  hop(a, t, step = 0) {
    const f = 523.25 * Math.pow(2, Math.min(step, 14) / 12);
    a.tone(f, t, 0.11, { type: 'triangle', gain: 0.22 });
    a.tone(f * 2, t, 0.05, { type: 'sine', gain: 0.08 });
    a.noise(t, 0.015, { gain: 0.08, freq: 3500, q: 2 });
  },
  exit(a, t) {
    a.tone(170, t, 0.32, { type: 'sine', gain: 0.35, slideTo: 760, slideTime: 0.16, vibrato: 30 });
    a.tone(340, t + 0.02, 0.22, { type: 'triangle', gain: 0.12, slideTo: 1200, slideTime: 0.14 });
  },
  capture(a, t) {
    a.tone(150, t, 0.25, { type: 'sine', gain: 0.6, slideTo: 40 });
    a.noise(t, 0.12, { gain: 0.4, freq: 400, type: 'lowpass' });
    a.tone(1500, t + 0.12, 0.6, { type: 'sine', gain: 0.18, slideTo: 260, slideTime: 0.55, vibrato: 18 });
  },
  home(a, t) {
    [0, 4, 7, 12, 16, 19].forEach((s, i) => a.tone(NOTE(3 + s), t + i * 0.06, 0.25, { type: 'triangle', gain: 0.2 }));
    for (let i = 0; i < 6; i++) a.tone(2000 + Math.random() * 2500, t + 0.2 + i * 0.05, 0.12, { type: 'sine', gain: 0.06 });
  },
  six(a, t) {
    a.tone(NOTE(10), t, 0.12, { type: 'square', gain: 0.12, filter: { freq: 3000 } });
    a.tone(NOTE(15), t + 0.1, 0.28, { type: 'square', gain: 0.14, filter: { freq: 3500 } });
    a.tone(NOTE(27), t + 0.1, 0.25, { type: 'sine', gain: 0.07 });
  },
  turn(a, t) {
    a.tone(NOTE(12), t, 0.5, { type: 'sine', gain: 0.22 });
    a.tone(NOTE(19), t + 0.12, 0.7, { type: 'sine', gain: 0.18 });
    a.tone(NOTE(31), t + 0.12, 0.3, { type: 'sine', gain: 0.04 });
  },
  tick(a, t) {
    a.tone(1600, t, 0.03, { type: 'square', gain: 0.06, filter: { freq: 2500 } });
  },
  noMove(a, t) {
    a.tone(NOTE(-2), t, 0.15, { type: 'triangle', gain: 0.15 });
    a.tone(NOTE(-6), t + 0.12, 0.25, { type: 'triangle', gain: 0.15 });
  },
  win(a, t) {
    const seq = [[3, 0.12], [7, 0.12], [10, 0.12], [15, 0.36], [12, 0.12], [15, 0.6]];
    let tt = t;
    for (const [s, d] of seq) {
      a.tone(NOTE(s), tt, d + 0.12, { type: 'square', gain: 0.12, filter: { freq: 3200 } });
      a.tone(NOTE(s - 12), tt, d + 0.12, { type: 'triangle', gain: 0.16 });
      tt += d;
    }
    a.tone(NOTE(19), tt - 0.6, 0.8, { type: 'sine', gain: 0.1 });
  },
  finish(a, t) {
    [[10, 0], [7, 0.18], [3, 0.36]].forEach(([s, d]) => a.tone(NOTE(s), t + d, 0.6, { type: 'sine', gain: 0.16 }));
    a.tone(NOTE(-9), t + 0.36, 0.9, { type: 'triangle', gain: 0.12 });
  },
  chat(a, t) {
    a.tone(NOTE(14), t, 0.08, { type: 'sine', gain: 0.12 });
    a.tone(NOTE(19), t + 0.06, 0.1, { type: 'sine', gain: 0.1 });
  },
};

export const audio = new AudioEngine();
