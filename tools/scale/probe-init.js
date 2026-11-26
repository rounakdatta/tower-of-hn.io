// Tower of HN listening probe: page instrumentation, injected before the app runs (Playwright addInitScript).
// Read-only: it wraps fetch, decodeAudioData, AudioBufferSourceNode.start and history to timestamp what the real client
// does, and changes nothing the app sees. Times are epoch ms (performance.timeOrigin + now), so they line up with the
// server's file times (towerd's ETags carry each file's mtime, base 36).
(() => {
  const T = () => performance.timeOrigin + performance.now();
  const log = (window.__probeLog = []);
  const byKey = new Map();          // bytes fingerprint -> url (the app decodes a copy of what it fetched)
  const bufUrl = new WeakMap();     // AudioBuffer -> url
  const fp = (b) => {
    const u = new Uint8Array(b);
    let h = b.byteLength >>> 0;
    for (let i = 0; i < Math.min(u.length, 128); i++) h = (Math.imul(h, 31) + u[i]) >>> 0;
    return h + ':' + b.byteLength;
  };
  // floors and deltas: keep which turns are voiced (compactly), so the analysis knows what the client knew, when
  const floorSummary = (j) => ({
    story: j.story && j.story.id, rev: j.rev,
    tables: (j.tables || []).map((t) => ({ root: t.root, turns: t.turns.map((u) => [u.id, u.v ? u.v[0] : null, u.gapMs || 0, u.v ? u.v[1] : 0]) })),
  });
  const deltaSummary = (j) => ({ epoch: j.epoch, floors: j.floors, patches: (j.patches || []).map((p) => ({ s: p.s, from: p.from, to: p.to, v: p.v.map(([id, v]) => [id, v ? v[0] : null]) })) });
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const rec = { k: 'fetch', url, method: (init && init.method) || 'GET', t0: T() };
    if (init && typeof init.body === 'string') rec.body = init.body.slice(0, 200);
    log.push(rec);
    return of.apply(this, arguments).then((r) => {
      rec.th = T(); rec.status = r.status; rec.etag = r.headers.get('etag');
      const ab = r.arrayBuffer.bind(r), js = r.json.bind(r);
      r.arrayBuffer = () => ab().then((b) => { rec.te = T(); rec.bytes = b.byteLength; byKey.set(fp(b), url); return b; });
      r.json = () => js().then((j) => {
        rec.te = T();
        try {
          if (/head\.json/.test(url)) { rec.at = j.at; rec.epoch = j.epoch; rec.load = j.load; rec.floors = j.floors; rec.tower = j.tower; }
          else if (/\/live\/f\//.test(url)) rec.floor = floorSummary(j);
          else if (/\/live\/e\//.test(url)) rec.delta = deltaSummary(j);
          else if (/\/live\/c\//.test(url)) rec.side = { id: j.id, n: (j.clips || []).length, partial: !!j.partial, of: j.of, dur: j.dur };
        } catch (e) { rec.perr = String(e); }
        return j;
      });
      return r;
    }, (e) => { rec.err = String(e); rec.te = T(); throw e; });
  };
  const od = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (b, ...rest) {
    const url = byKey.get(fp(b)), t0 = T();
    return od.call(this, b, ...rest).then((buf) => {
      if (url) bufUrl.set(buf, url);
      log.push({ k: 'decode', url, t0, t1: T(), dur: buf.duration });
      return buf;
    });
  };
  const os = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const url = this.buffer ? bufUrl.get(this.buffer) : undefined;
    if (url) {
      const now = this.context.currentTime, t = T();
      log.push({ k: 'start', url, t, when, ctxNow: now, at: t + Math.max(0, when - now) * 1000, dur: this.buffer.duration,
        lat: (this.context.baseLatency || 0) + (this.context.outputLatency || 0) });
    }
    return os.call(this, when, ...rest);
  };
  for (const m of ['pushState', 'replaceState']) {
    const o = history[m];
    history[m] = function (s, t, u) { log.push({ k: 'nav', t: T(), url: String(u) }); return o.apply(this, arguments); };
  }
  window.__probeT = T;
})();
