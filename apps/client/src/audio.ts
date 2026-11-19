// Audio: half of the premium feel. Spatial voices in a real-sounding room, a city
// underneath, and synthesized sound effects (no asset files).

type V3 = { x: number; y: number; z: number };

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private voiceBus!: GainNode;
  private reverbSend!: GainNode;
  private city!: GainNode;
  private room!: GainNode;
  private cache = new Map<string, Promise<AudioBuffer>>();
  private order: string[] = [];
  muted = false;
  /** record mode: no real audio; a virtual clock and a log of what would have played (muxed into videos later) */
  virtual = false;
  vclock = 0;
  log: { url: string; when: number }[] = [];

  /** Must be called from a user gesture (browsers require it). */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.25;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(1.5, 2.6);
    this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = 0.16;
    this.reverbSend.connect(reverb).connect(this.master);
    this.voiceBus = ctx.createGain(); this.voiceBus.gain.value = 1;
    this.voiceBus.connect(this.master); this.voiceBus.connect(this.reverbSend);
    // the city: brown noise, low-passed, with a slow swell
    this.city = ctx.createGain(); this.city.gain.value = 0;
    const cityLp = ctx.createBiquadFilter(); cityLp.type = 'lowpass'; cityLp.frequency.value = 320;
    this.loopNoise('brown').connect(cityLp).connect(this.city).connect(this.master);
    // the room: soft band-passed murmur, slowly modulated like distant conversation
    this.room = ctx.createGain(); this.room.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.7;
    const mod = ctx.createGain(); mod.gain.value = 0.6;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.37;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(mod.gain); lfo.start();
    this.loopNoise('pink').connect(bp).connect(mod).connect(this.room).connect(this.reverbSend);
    this.setMode('tower');
  }

  setMode(mode: 'tower' | 'floor' | 'table') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.city.gain.setTargetAtTime(mode === 'tower' ? 0.07 : 0.018, t, 0.8);
    this.room.gain.setTargetAtTime(mode === 'tower' ? 0 : mode === 'floor' ? 0.05 : 0.025, t, 0.8);
  }

  now() { return this.virtual ? this.vclock : this.ctx?.currentTime ?? 0; }

  listener(pos: V3, fwd: V3, up: V3) {
    const l = this.ctx?.listener;
    if (!l || !l.positionX) return;
    const t = this.ctx!.currentTime;
    l.positionX.setTargetAtTime(pos.x, t, 0.05); l.positionY.setTargetAtTime(pos.y, t, 0.05); l.positionZ.setTargetAtTime(pos.z, t, 0.05);
    l.forwardX.setTargetAtTime(fwd.x, t, 0.05); l.forwardY.setTargetAtTime(fwd.y, t, 0.05); l.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
    l.upX.setTargetAtTime(up.x, t, 0.05); l.upY.setTargetAtTime(up.y, t, 0.05); l.upZ.setTargetAtTime(up.z, t, 0.05);
  }

  load(url: string): Promise<AudioBuffer> {
    if (this.virtual) return Promise.resolve(null as unknown as AudioBuffer);
    let p = this.cache.get(url);
    if (!p) {
      p = fetch(url).then((r) => r.arrayBuffer()).then((b) => this.ctx!.decodeAudioData(b));
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
      this.order.push(url);
      while (this.order.length > 160) this.cache.delete(this.order.shift()!);
    }
    return p;
  }

  /** A voice placed in the room at `pos`; returns the source so callers can stop it. */
  voice(buf: AudioBuffer, when: number, pos: V3, url = '', gain = 1): AudioScheduledSourceNode {
    if (this.virtual || !this.ctx) { this.log.push({ url, when }); return { stop() {} } as unknown as AudioScheduledSourceNode; }
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1.6; pan.rolloffFactor = 0.9;
    pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    src.connect(g).connect(pan).connect(this.voiceBus);
    src.start(Math.max(ctx.currentTime, when));
    return src;
  }

  /** Another table's real voice, heard across the room: quiet, muffled, placed where they sit. */
  murmur(buf: AudioBuffer, when: number, pos: V3) {
    if (this.virtual || !this.ctx || !buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain(); g.gain.value = 0.16;
    const pan = ctx.createPanner(); pan.panningModel = 'equalpower'; pan.refDistance = 2; pan.rolloffFactor = 1.2;
    pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    src.connect(lp).connect(g).connect(pan);
    pan.connect(this.reverbSend); pan.connect(this.master);
    src.start(Math.max(ctx.currentTime, when));
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- sound effects, synthesized
  sfx(kind: 'ding' | 'rumble' | 'whoosh' | 'blip' | 'tick' | 'sit') {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime, out = ctx.createGain();
    out.connect(this.master); out.connect(this.reverbSend);
    const tone = (f: number, start: number, dur: number, amp: number, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + start); g.gain.linearRampToValueAtTime(amp, t + start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(out); o.start(t + start); o.stop(t + start + dur + 0.05);
      return o;
    };
    if (kind === 'ding') {             // the elevator: a soft two-note chime
      tone(1046.5, 0, 1.6, 0.07); tone(2093, 0, 0.9, 0.015);
      tone(784, 0.32, 2.0, 0.07); tone(1568, 0.32, 1.0, 0.012);
    } else if (kind === 'rumble') {    // floors trading places: felt more than heard
      const o = tone(46, 0, 1.6, 0.22, 'sine'); o.frequency.exponentialRampToValueAtTime(38, t + 1.6);
      const n = ctx.createBufferSource(); n.buffer = this.noise('brown', 2);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.15); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      n.connect(lp).connect(g).connect(out); n.start(t); n.stop(t + 2);
      tone(220, 1.15, 0.12, 0.02, 'triangle');           // the clunk as it seats
    } else if (kind === 'whoosh') {    // the elevator ride
      const n = ctx.createBufferSource(); n.buffer = this.noise('pink', 2.6);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(220, t); bp.frequency.exponentialRampToValueAtTime(900, t + 1.2); bp.frequency.exponentialRampToValueAtTime(260, t + 2.4);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.6); g.gain.linearRampToValueAtTime(0, t + 2.5);
      n.connect(bp).connect(g).connect(out); n.start(t); n.stop(t + 2.6);
    } else if (kind === 'blip') {      // a comment landed somewhere in the tower
      const o = tone(1320, 0, 0.35, 0.025); o.frequency.exponentialRampToValueAtTime(990, t + 0.3);
    } else if (kind === 'tick') {
      tone(2400, 0, 0.04, 0.012, 'square');
    } else if (kind === 'sit') {
      tone(180, 0, 0.18, 0.05, 'triangle'); tone(240, 0.05, 0.2, 0.03, 'triangle');
    }
  }

  /** A sound placed in the room, on the scene's audio clock (recorded videos synthesize the same sound when muxing). */
  sfxAt(kind: 'chair' | 'thump', pos: V3, when: number) {
    if (this.virtual) { this.log.push({ url: 'sfx:' + kind, when }); return; }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = Math.max(ctx.currentTime, when);
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF'; pan.refDistance = 1.6; pan.rolloffFactor = 0.9;
    pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    pan.connect(this.voiceBus);
    if (kind === 'thump') {
      // two palms on a wooden tabletop: a low body and a short knock
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(92, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.2);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.006); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      const n = ctx.createBufferSource(); n.buffer = this.noise('pink', 0.12);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0.35, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.connect(g).connect(pan); n.connect(lp).connect(ng).connect(pan);
      o.start(t); o.stop(t + 0.32); n.start(t); n.stop(t + 0.12);
      return;
    }
    // a chair dragged on wood: stick-slip judder (a slowing saw) through two wooden resonances
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(58, t); o.frequency.linearRampToValueAtTime(34, t + 0.4);
    const n = ctx.createBufferSource(); n.buffer = this.noise('pink', 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.04); g.gain.linearRampToValueAtTime(0.11, t + 0.26); g.gain.linearRampToValueAtTime(0, t + 0.44);
    for (const [f, q, a] of [[620, 3, 1], [1450, 5, 0.6]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const w = ctx.createGain(); w.gain.value = a;
      o.connect(bp); n.connect(bp); bp.connect(w).connect(g);
    }
    g.connect(pan);
    o.start(t); o.stop(t + 0.5); n.start(t); n.stop(t + 0.5);
  }

  // ---------------------------------------------------------------- generated buffers
  private noise(kind: 'pink' | 'brown', secs: number) {
    const ctx = this.ctx!, n = Math.floor(ctx.sampleRate * secs), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }
  private loopNoise(kind: 'pink' | 'brown') {
    const src = this.ctx!.createBufferSource(); src.buffer = this.noise(kind, 6); src.loop = true; src.start();
    return src;
  }
  private impulse(secs: number, decay: number) {
    const ctx = this.ctx!, n = Math.floor(ctx.sampleRate * secs), buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 90 ? i / 90 : 1);
    }
    return buf;
  }
}
