// Audio: half of the premium feel. Spatial voices in a real-sounding room, a city
// underneath, and synthesized sound effects (no asset files).

type V3 = { x: number; y: number; z: number };

/** A table's own channel: its voices pass through here, so the room can bring one table forward and let the
 *  others fall back into a muffled murmur (a level and a low-pass, eased) */
export interface Bus { gain: GainNode; lp: BiquadFilterNode; level: number; hz: number }

/** How loud a line is said: heated and excited lines carry, sad and tender ones sit back (more so the stronger
 *  the feeling). Within ±2.5 dB: the room's compressor keeps the peaks civil. */
export function emoGain(emotion: string, intensity = 0.4) {
  const g = ({ angry: 1.18, excited: 1.12, surprised: 1.08, joyful: 1.06, stern: 1.04, contemplative: 0.94, nervous: 0.92, tender: 0.86, sad: 0.82 } as Record<string, number>)[emotion] ?? 1;
  const k = 0.6 + Math.max(0, Math.min(1, intensity)) * 0.8;
  return 1 + (g - 1) * k;
}

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

  /** Ogg Opus, natively where the browser can (Chrome, Firefox, Safari 26); older Safari gets a small
   *  WebAssembly decoder, fetched only then. ?wasmopus forces it, to test that path anywhere. */
  private native = !new URLSearchParams(location.search).has('wasmopus');
  private wasm?: Promise<typeof import('opus-decoder').OpusDecoder>;
  private decoder?: { key: string; d: import('opus-decoder').OpusDecoder };
  private queue: Promise<unknown> = Promise.resolve();
  private decode(b: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.native) return this.decodeWasm(b);
    // a copy: a failed native decode may leave the buffer detached
    return this.ctx!.decodeAudioData(b.slice(0)).catch((e) =>
      this.decodeWasm(b).then((buf) => { this.native = false; console.info('audio: Ogg Opus via WebAssembly'); return buf; }, () => { throw e; }));
  }
  private decodeWasm(b: ArrayBuffer): Promise<AudioBuffer> {
    this.wasm ??= import('opus-decoder').then((m) => m.OpusDecoder).catch((e) => { this.wasm = undefined; throw e; });
    const run = this.queue.then(async () => {             // one decoder, one file at a time
      const { channels, preSkip, frames, samples } = oggOpus(new Uint8Array(b));
      const key = `${channels}:${preSkip}`;
      if (this.decoder?.key !== key) {
        this.decoder?.d.free();
        const OpusDecoder = await this.wasm!;
        this.decoder = { key, d: new OpusDecoder({ channels, preSkip }) };
        await this.decoder.d.ready;
      } else await this.decoder.d.reset();
      const { channelData, samplesDecoded, sampleRate } = this.decoder.d.decodeFrames(frames);
      const n = samples > 0 ? Math.min(samplesDecoded, samples) : samplesDecoded;   // the last frame's padding
      if (!n) throw new Error('audio: nothing decoded');
      const buf = this.ctx!.createBuffer(channelData.length, n, sampleRate);
      channelData.forEach((c, i) => buf.copyToChannel(c.subarray(0, n) as Float32Array<ArrayBuffer>, i));
      return buf;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** there is a context to decode into (it exists once someone has tapped in) */
  get live() { return !!this.ctx; }

  /** Must be called from a user gesture (browsers require it). */
  ensure() {
    // iPhones mute web audio with the ringer switch unless the page says it's playback, like a podcast app
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) try { session.type = 'playback'; } catch { /* older Safari */ }
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    // at the voices' own rate (Kokoro speaks at 24 kHz): decoded clips take half the memory, and the reverb, the
    // spatial panners and the filters do half the work, which a phone's battery notices. (A browser that won't run
    // at 24 kHz gets its default.)
    let ctx: AudioContext;
    try { ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 24000 }); } catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    this.ctx = ctx;
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
    // inside, the real tables are the room's sound: the city and the made-up murmur only fill the gaps
    this.city.gain.setTargetAtTime(mode === 'tower' ? 0.07 : 0.012, t, 0.8);
    this.room.gain.setTargetAtTime(mode === 'tower' ? 0 : mode === 'floor' ? 0.026 : 0.014, t, 0.8);
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
      p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }).then((b) => this.decode(b));
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
      this.order.push(url);
      // decoded audio is ~96 KB a second at 24 kHz: keep the last 48 clips (a few minutes, ~28 MB), not hundreds
      while (this.order.length > 48) this.cache.delete(this.order.shift()!);
    }
    return p;
  }

  /** A table's channel, starting at the level it should have (null until there is a context). */
  bus(level = 1, hz = 18000): Bus | null {
    if (!this.ctx) return null;
    const gain = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
    gain.gain.value = level;
    lp.type = 'lowpass'; lp.frequency.value = hz; lp.Q.value = 0.5;
    gain.connect(lp).connect(this.voiceBus);
    return { gain, lp, level, hz };
  }
  /** Bring a table forward (1, open) or let it fall back (quieter, muffled), eased over about a second. */
  setBus(b: Bus, level: number, hz: number) {
    if (!this.ctx || (Math.abs(b.level - level) < 0.01 && Math.abs(b.hz - hz) < 50)) return;
    const t = this.ctx.currentTime;
    b.gain.gain.setTargetAtTime(level, t, 0.3); b.lp.frequency.setTargetAtTime(hz, t, 0.3);
    b.level = level; b.hz = hz;
  }

  /** A voice placed in the room at `pos`; returns the source so callers can stop it. */
  voice(buf: AudioBuffer, when: number, pos: V3, url = '', gain = 1, o: { hrtf?: boolean; ref?: number; rolloff?: number; bus?: Bus | null } = {}): AudioScheduledSourceNode {
    if (this.virtual || !this.ctx) { this.log.push({ url, when }); return { stop() {} } as unknown as AudioScheduledSourceNode; }
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    const pan = ctx.createPanner();
    // HRTF for the voices you're close to; plain panning (much cheaper) for tables across the room
    pan.panningModel = o.hrtf === false ? 'equalpower' : 'HRTF'; pan.distanceModel = 'inverse';
    pan.refDistance = o.ref ?? 1.6; pan.rolloffFactor = o.rolloff ?? 0.9;
    pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    src.connect(g).connect(pan).connect(o.bus?.gain ?? this.voiceBus);
    src.start(Math.max(ctx.currentTime, when));
    return src;
  }

  /** Another table's real voice, heard across the room: quiet, muffled, placed where they sit. With no place, it's
   *  straight ahead (a floor's voice through the glass, from the tower). Returns a way to fade it out early. */
  murmur(buf: AudioBuffer, when: number, pos: V3 | null, gain = 0.16): { stop(): void } | undefined {
    if (this.virtual || !this.ctx || !buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain(); g.gain.value = gain;
    let out: AudioNode = g;
    if (pos) {
      const pan = ctx.createPanner(); pan.panningModel = 'equalpower'; pan.refDistance = 2; pan.rolloffFactor = 1.2;
      pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
      out = g.connect(pan);
    }
    src.connect(lp).connect(g);
    out.connect(this.reverbSend); out.connect(this.master);
    src.start(Math.max(ctx.currentTime, when));
    return { stop: () => { const t = ctx.currentTime; g.gain.setTargetAtTime(0, t, 0.08); try { src.stop(t + 0.4); } catch { /* already over */ } } };
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.ducked ? 0.08 : 0.9, this.ctx.currentTime, 0.05);
  }
  /** the room nearly silent while you speak (the microphone should hear you, not the toys), then back */
  private ducked = false;
  duck(on: boolean) {
    this.ducked = on;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : on ? 0.08 : 0.9, this.ctx.currentTime, on ? 0.08 : 0.4);
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
  sfxAt(kind: 'chair' | 'thump' | 'clink', pos: V3, when: number) {
    if (this.virtual) { this.log.push({ url: 'sfx:' + kind, when }); return; }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = Math.max(ctx.currentTime, when);
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF'; pan.refDistance = 1.6; pan.rolloffFactor = 0.9;
    pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    pan.connect(this.voiceBus);
    if (kind === 'clink') {
      // two glasses touching across the room: two inharmonic partials, a quick ring
      for (const [f, a, d] of [[2730, 0.05, 0.5], [4120, 0.03, 0.35], [6390, 0.012, 0.2]]) {
        const o = ctx.createOscillator(); o.frequency.value = f * (0.97 + Math.random() * 0.06);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(pan); o.start(t); o.stop(t + d + 0.05);
      }
      return;
    }
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

/** Opus packets out of an Ogg Opus file (RFC 3533 pages, RFC 7845 mapping): the channel count and pre-skip from
 *  its head, the audio packets, and how many samples it really holds (the last page's granule, less pre-skip). */
function oggOpus(b: Uint8Array) {
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [], pos = 0, granule = 0;
  while (pos + 27 <= b.length) {
    if (b[pos] !== 0x4f || b[pos + 1] !== 0x67 || b[pos + 2] !== 0x67 || b[pos + 3] !== 0x53) throw new Error('audio: not Ogg');
    const g = new DataView(b.buffer, b.byteOffset + pos + 6, 8).getBigInt64(0, true);
    if (g >= 0n) granule = Number(g);
    const segs = b[pos + 26];
    let at = pos + 27 + segs;
    for (let i = 0; i < segs; i++) {
      const len = b[pos + 27 + i];
      parts.push(b.subarray(at, at + len));
      at += len;
      if (len < 255) {                                    // a packet ends here (else it continues)
        const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
        let o = 0;
        for (const x of parts) { out.set(x, o); o += x.length; }
        packets.push(out);
        parts = [];
      }
    }
    pos = at;
  }
  const head = packets[0];
  if (!head || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') throw new Error('audio: not Opus');
  const channels = head[9], preSkip = head[10] | (head[11] << 8);
  return { channels, preSkip, frames: packets.slice(2), samples: granule - preSkip };   // [1] is OpusTags
}
