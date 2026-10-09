'use strict';
/* ==========================================================================
   HD — horizontal displacement. Four-corner data collection.

   What this is for: one day the app should say *where* on the bed each jump
   landed, the way the FIG's HD score does. The plan is a moonlander1 board
   clipped round a spring at each corner of the bed: a landing near one corner
   loads that corner's springs more than the others, so the four signals
   together should give the landing position. Nobody knows yet how well that
   works, so this file only *collects* the data, in a form that can be
   labelled (where did the jump really land?) and modelled offline.

   How it hangs together:
   - One of the four boards is the main sensor, connected the usual way with
     "Connect sensor". Its jumps still feed the Live bars and sessions. The
     other three are connected from the HD panel and only ever feed HD, so they
     never put three extra copies of every jump into a session.
   - Every board runs its own detector, so every board reports every jump
     (J + DJ). Those four reports are matched into one landing by time. Each
     board has its own clock, so each one's offset to the phone's clock is
     learned from the jumps themselves (see onJump).
   - While collecting, every board is in trigger mode (d t), so it sends the
     raw window round each jump. For each corner the landing's raw and filtered
     signal is cut out and saved, with a few summary features.
   - Labels (x, y in cm, origin at the bed centre) are added afterwards on the
     review screen or in the exported CSV.

   Behind the HD switch on the Debug screen. Off, none of this runs or shows.
   Needs debug.js (decodeBlock, verticalG, smoothedG) and app.js.
   ========================================================================== */

const HDC = {
  storageKey: '2themoon-hd',
  // FIG Apparatus Norms 2017, TRA 1 (cm). The bed is drawn and labelled in
  // these units, origin at the red cross, x along the length, y across it.
  bed: { L: 428, W: 214 },
  frame: { L: 505, W: 291 },          // inside of the frame: the springs live between bed and frame
  areaA: { L: 215, W: 108 },          // red lines, continued to the edges of the bed
  areaB: 108,                         // the 108 x 108 centre square
  cross: 70,                          // the red cross at the centre
  // Signal cut out per corner: the contact (onset to takeoff) plus this much
  // either side. Contacts here are ~430-530 ms, so a jump is ~1.1 s per corner.
  preMs: 300,
  postMs: 300,
  // Matching four boards' reports of one landing. Contacts are ~0.5 s long and
  // landings ~1.5 s apart, so 300 ms is generous without risking neighbours.
  groupTolMs: 300,
  groupWaitMs: 5000,                  // give up waiting for a corner (or its samples) after this
  bufMax: 16000,                      // samples kept per board (40 s at 400 Hz)
  offsetKeep: 20,                     // jumps the clock offset is learned over
};

// Corners as drawn: 1 top left, then clockwise. Coordinates are the bed
// corner, in cm from the centre (y up).
const HD_CORNERS = [1, 2, 3, 4];
const HD_CORNER_POS = { 1: [-214, 107], 2: [214, 107], 3: [214, -107], 4: [-214, -107] };
const HD_CORNER_NAME = { 1: 'Top left', 2: 'Top right', 3: 'Bottom right', 4: 'Bottom left' };

/* -------------------------------------------------------------------------
   One corner's board
   ------------------------------------------------------------------------- */
class HDBoard {
  constructor(corner) {
    this.corner = corner;
    this.device = null; this.tx = null; this.rx = null; this.decoder = null;
    this.state = 'empty';       // empty | connecting | connected | reconnecting | lost
    this.userDisconnect = false;
    this.lineBuf = '';
    this.sendChain = Promise.resolve();
    this.onValue = (e) => this.feed(this.decoder.decode(e.target.value, { stream: true }));
    this.onDisconnected = () => HD.boardLost(this);
    this.clearSignal();
  }
  clearSignal() {
    this.buf = { idx: [], ax: [], ay: [], az: [] };
    this.g0 = null;
    this.periodUs = 2500;
    this.params = {};
    this.pendingJ = new Map();  // index -> J, waiting for its DJ
    this.offsets = [];          // recent (phone ms - sensor ms) per jump
    this.blocks = 0;
    this.jumps = 0;
  }
  feed(text) {
    this.lineBuf += text;
    let i;
    while ((i = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, i).replace(/\r$/, '');
      this.lineBuf = this.lineBuf.slice(i + 1);
      let p = null;
      try { p = parsePacket(line); } catch (e) { p = null; }
      if (p && p.type !== 'D' && typeof Debug !== 'undefined') Debug.push(`[${this.corner}] ${line}`, 'in');
      if (p) HD.handle(this, p);
    }
    if (this.lineBuf.length > 1024) this.lineBuf = '';
  }
  lastIdx() { const d = this.buf.idx; return d.length ? d[d.length - 1] : -Infinity; }
}

/* -------------------------------------------------------------------------
   The HD module
   ------------------------------------------------------------------------- */
const HD = {
  ready: false,
  on: false,
  // Saved per browser: which board sits at which corner, and how it is mounted.
  // corners[c] = { name, spring, edge }  (edge: 'end' | 'side', where the spring count starts)
  settings: { on: false, corners: {} },
  boards: {},                 // corner -> HDBoard (boards connected from this panel)
  mainBoard: null,            // HDBoard holding the main sensor's signal state (no GATT of its own)
  run: null,                  // the recording in progress: hdRuns record
  open: [],                   // landings still being matched
  last: null,                 // the most recent finished landing, for the Live screen
  label: null,                // review screen: { run, jumps, i }
  timer: null,

  /* ---------- lifecycle ---------- */
  init() {
    if (this.ready) return;
    this.ready = true;
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(HDC.storageKey) || '{}')); } catch (e) { /* defaults */ }
    if (!this.settings.corners) this.settings.corners = {};
    for (const c of HD_CORNERS) this.boards[c] = new HDBoard(c);
    this.mainBoard = new HDBoard(0);
    this.wire();
    this.setOn(!!this.settings.on, { quiet: true });
  },

  save() {
    try { localStorage.setItem(HDC.storageKey, JSON.stringify(this.settings)); } catch (e) { /* private mode */ }
  },

  /** HD runs only while both the switch and the debug tools are on. */
  active() { return this.on && typeof Debug !== 'undefined' && Debug.enabled; },

  setOn(on, { quiet = false } = {}) {
    this.on = !!on;
    this.settings.on = this.on;
    this.save();
    if (!this.on) {
      if (this.run) this.stop();
      for (const c of HD_CORNERS) this.disconnectBoard(this.boards[c]);
    }
    this.applyVisibility();
    if (!quiet) toast(this.on ? 'HD on' : 'HD off');
  },

  /** Called on every switch change, and by debug.js when the debug tools go on or off. */
  applyVisibility() {
    const sw = document.getElementById('hd-switch');
    if (sw) sw.setAttribute('aria-checked', String(this.on));
    const panel = document.getElementById('hd-panel');
    if (panel) panel.hidden = !this.on;
    const live = document.getElementById('live-hd');
    if (live) live.hidden = !this.active();
    if (!this.active() && this.run) this.stop();
    clearInterval(this.timer);
    this.timer = this.active() ? setInterval(() => this.tick(), 500) : null;
    this.render();
    this.renderLive();
  },

  /* ---------- which board is where ---------- */
  mainConnected() { return typeof BLE !== 'undefined' && BLE.state === 'connected' && !S.demo; },
  /** The corner the main sensor sits at, or 0. Remembered by the sensor's name. */
  mainCorner() {
    if (!S.deviceName) return 0;
    for (const c of HD_CORNERS) if ((this.settings.corners[c] || {}).name === S.deviceName) return c;
    return 0;
  },
  /** The board feeding a corner right now, or null. */
  boardAt(c) {
    if (this.mainCorner() === c) return this.mainConnected() ? this.mainBoard : null;
    const b = this.boards[c];
    return b.state === 'connected' ? b : null;
  },
  liveCorners() { return HD_CORNERS.filter((c) => this.boardAt(c)); },
  cornerOf(b) { return b === this.mainBoard ? this.mainCorner() : b.corner; },
  cfg(c) { return this.settings.corners[c] || (this.settings.corners[c] = { name: null, spring: null, edge: 'end' }); },

  /* ---------- intake ---------- */
  /** Every line from the main sensor (app.js ingestLine). */
  mainLine(line, p) {
    if (!this.active() || !p) return;
    if (p.kind === 'name') {
      // The sensor states its name on every (re)connect: the moment to put it
      // back in trigger mode, since a reconnect may have been a reboot.
      this.render(); this.renderLive();
      if (this.run) { this.sendTo(this.mainBoard, 't'); this.sendTo(this.mainBoard, 'd t'); }
      return;
    }
    if (!this.mainCorner()) return;
    this.handle(this.mainBoard, p);
  },

  handle(b, p) {
    if (!this.active()) return;
    switch (p.kind) {
      case 'capture':    this.addBlock(b, p); break;
      case 'dumpHeader': b.g0 = p.g0; if (p.periodUs > 0) b.periodUs = p.periodUs; break;
      case 'calib':      b.g0 = p.g0; if (p.periodUs > 0) b.periodUs = p.periodUs; break;
      case 'param':      b.params[p.name] = p.value; break;
      case 'name':
        if (b !== this.mainBoard) { this.cfg(b.corner).name = p.name; this.save(); this.render(); }
        break;
      case 'jump':
        b.pendingJ.set(p.index, { ...p, at: Date.now() });
        // Backfilled jumps arrive without a DJ and are never matched; don't keep them.
        for (const [k, j] of b.pendingJ) if (Date.now() - j.at > 5000) b.pendingJ.delete(k);
        break;
      case 'jumpMarks': {
        const j = b.pendingJ.get(p.index);
        if (!j) break;
        b.pendingJ.delete(p.index);
        this.onJump(b, j, p);
        break;
      }
      default: break;
    }
  },

  addBlock(b, p) {
    const rows = decodeBlock(p.b64);
    if (!rows.length) return;
    const d = b.buf;
    const last = b.lastIdx();
    // A much lower index means the board rebooted: its old samples are another timeline.
    if (p.startIdx + rows.length < last - 4000) b.clearSignal();
    // Back-to-back trigger windows can resend samples we already have. Keep the
    // buffer strictly increasing so a window can be found by binary search.
    const skip = Math.max(0, b.lastIdx() - p.startIdx + 1);
    for (let i = skip; i < rows.length; i++) {
      d.idx.push(p.startIdx + i);
      d.ax.push(rows[i][0]); d.ay.push(rows[i][1]); d.az.push(rows[i][2]);
    }
    if (d.idx.length > HDC.bufMax) {
      const cut = d.idx.length - HDC.bufMax + 2000;
      for (const k of ['idx', 'ax', 'ay', 'az']) d[k].splice(0, cut);
    }
    b.blocks++;
  },

  /* ---------- matching one landing across corners ---------- */
  onJump(b, j, dj) {
    const corner = this.cornerOf(b);
    if (!corner) return;
    b.jumps++;
    // The board's clock against the phone's. J goes out once the next landing
    // is confirmed, so arrival minus that landing's sensor time is the offset
    // plus a delay (detection + Bluetooth). The smallest recent value is the
    // closest to the offset itself. A jump far off the rest means a reboot.
    const now = Date.now();
    const landMs = j.timestamp + j.flightMs;
    const off = now - landMs;
    const min0 = b.offsets.length ? Math.min(...b.offsets) : off;
    if (Math.abs(off - min0) > 5000) b.offsets = [];
    b.offsets.push(off);
    if (b.offsets.length > HDC.offsetKeep) b.offsets.shift();
    const offset = Math.min(...b.offsets);
    const onsetAt = j.timestamp - j.contactMs + offset;   // landing onset, phone clock

    const m = {
      corner, deviceName: b === this.mainBoard ? S.deviceName : this.cfg(corner).name,
      index: j.index, flightMs: j.flightMs, contactMs: j.contactMs, peakG: j.peakG,
      flags: j.flags, timestampMs: j.timestamp,
      onsetIdx: dj.onset, takeoffIdx: dj.takeoff, landIdx: dj.land,
      onsetAt, board: b,
    };
    let g = this.open.find((x) => !x.members[corner] && Math.abs(x.t - onsetAt) <= HDC.groupTolMs);
    if (!g) {
      g = { t: onsetAt, created: now, members: {} };
      this.open.push(g);
    }
    g.members[corner] = m;
    const ts = Object.values(g.members).map((x) => x.onsetAt);
    g.t = ts.reduce((a, x) => a + x, 0) / ts.length;
    this.tick();
  },

  /** Finish every landing that has all its corners and their samples, or has waited long enough. */
  tick() {
    if (!this.open.length) return;
    const expected = this.liveCorners().length;
    const now = Date.now();
    const done = [];
    for (const g of this.open) {
      const ms = Object.values(g.members);
      const allIn = ms.length >= expected;
      const samplesIn = !this.run || ms.every((m) => this.windowReady(m));
      if ((allIn && samplesIn) || now - g.created > HDC.groupWaitMs) done.push(g);
    }
    for (const g of done) {
      this.open.splice(this.open.indexOf(g), 1);
      this.finish(g);
    }
  },

  windowReady(m) {
    const b = m.board;
    const postS = Math.ceil(HDC.postMs * 1000 / b.periodUs);
    return b.lastIdx() >= Math.ceil(m.takeoffIdx) + postS;
  },

  async finish(g) {
    const corners = {};
    for (const [c, m] of Object.entries(g.members)) {
      const b = m.board;
      const win = this.run ? this.cutWindow(b, m) : null;
      const { board, onsetAt, ...rest } = m;
      corners[c] = {
        ...rest,
        periodUs: b.periodUs, g0: b.g0 ? b.g0.slice() : null,
        smoothMs: b.params.smooth_ms ?? null,
        win: win ? win.win : null,
        complete: win ? win.complete : false,
        feat: win ? win.feat : null,
      };
    }
    const rec = { at: new Date(g.t).toISOString(), corners, x: null, y: null };
    rec.shares = this.shares(rec);
    this.last = rec;
    this.renderLive();
    if (!this.run) return;
    rec.runId = this.run.id;
    rec.n = ++this.run.count;
    try {
      await DB.put('hdJumps', rec);
      await DB.put('hdRuns', this.run);
    } catch (e) { console.warn('[hd] save failed', e); }
    this.renderStatus();
  },

  /** One corner's landing: raw and filtered signal round the contact, plus summary features. */
  cutWindow(b, m) {
    const d = b.buf;
    const n = d.idx.length;
    if (!n) return null;
    const per = b.periodUs / 1000;   // ms per sample
    const a = Math.floor(m.onsetIdx) - Math.round(HDC.preMs / per);
    const z = Math.ceil(m.takeoffIdx) + Math.round(HDC.postMs / per);
    // The filter needs its window full before it reads anything, so start the
    // slice early enough to warm it up.
    const ms = Number.isFinite(b.params.smooth_ms) ? b.params.smooth_ms : 100;
    const warm = Math.ceil((ms * 1000) / b.periodUs) + 2;
    const i0 = lowerBound(d.idx, n, a - warm);
    const i1 = lowerBound(d.idx, n, z + warm + 1);   // past z: s at z describes a later sample
    if (i1 <= i0) return null;
    const idx = d.idx.slice(i0, i1);
    const v = idx.map((_, k) => verticalG(d.ax[i0 + k], d.ay[i0 + k], d.az[i0 + k], b.g0));
    const { s, delay } = smoothedG(idx, v, ms);
    // s[k] describes sample idx[k] - delay (the moving average lags), so the
    // filtered value *at* a sample is found delay samples later. delay can be
    // a half sample: average the two neighbours.
    const dInt = Math.floor(delay), dFrac = delay - dInt;
    const sAt = (k) => {
      const q = k + dInt;
      if (q >= idx.length || idx[q] !== idx[k] + dInt) return NaN;
      if (!dFrac) return s[q];
      if (q + 1 >= idx.length || idx[q + 1] !== idx[q] + 1) return NaN;
      return s[q] * (1 - dFrac) + s[q + 1] * dFrac;
    };
    const out = { idx: [], ax: [], ay: [], az: [], v: [], s: [] };
    for (let k = 0; k < idx.length; k++) {
      if (idx[k] < a || idx[k] > z) continue;
      out.idx.push(idx[k]);
      out.ax.push(d.ax[i0 + k]); out.ay.push(d.ay[i0 + k]); out.az.push(d.az[i0 + k]);
      out.v.push(v[k]); out.s.push(sAt(k));
    }
    const complete = out.idx.length === z - a + 1 && out.s.every(Number.isFinite);
    const win = {
      startIdx: a,
      idx: Int32Array.from(out.idx),
      ax: Float32Array.from(out.ax), ay: Float32Array.from(out.ay), az: Float32Array.from(out.az),
      v: Float32Array.from(out.v), s: Float32Array.from(out.s),
    };
    return { win, complete, feat: this.features(win, m.onsetIdx, m.takeoffIdx, per) };
  },

  /** Summary numbers over the contact (onset to takeoff), on the filtered signal
      unless the name says raw. These are a starting point for the model, not
      the model: the windows are saved so anything else can be computed later. */
  features(w, onset, takeoff, per) {
    let peakS = -Infinity, peakAt = NaN, impulse = 0, sum = 0, cnt = 0, peakV = -Infinity;
    for (let k = 0; k < w.idx.length; k++) {
      const i = w.idx[k];
      if (i < onset || i > takeoff) continue;
      const s = w.s[k], v = w.v[k];
      if (Number.isFinite(v) && v > peakV) peakV = v;
      if (!Number.isFinite(s)) continue;
      if (s > peakS) { peakS = s; peakAt = i; }
      impulse += Math.max(0, s - 1) * per / 1000;
      sum += s; cnt++;
    }
    // The dip: the mat giving way at landing, before the push. Between onset and the peak.
    let dipS = Infinity;
    for (let k = 0; k < w.idx.length; k++) {
      const i = w.idx[k];
      if (i < onset || !(i <= peakAt)) continue;
      if (Number.isFinite(w.s[k]) && w.s[k] < dipS) dipS = w.s[k];
    }
    const fin = (x) => (Number.isFinite(x) ? x : null);
    return {
      peakS: fin(peakS),
      peakSMs: fin((peakAt - onset) * per),      // time of the filtered peak after onset
      impulseGs: cnt ? impulse : null,           // area of filtered s above 1 g over the contact, g·s
      meanS: cnt ? sum / cnt : null,
      dipS: fin(dipS),
      peakV: fin(peakV),                         // raw peak: mostly mat rattle, kept for completeness
    };
  },

  /** Each corner's share of the landing. Impulse when the samples are there,
      otherwise the detector's own (filtered) peak above 1 g. */
  shares(rec) {
    const cs = Object.entries(rec.corners);
    const byImpulse = cs.length && cs.every(([, m]) => m.feat && m.feat.impulseGs != null);
    const val = (m) => Math.max(0, byImpulse ? m.feat.impulseGs : m.peakG - 1);
    const total = cs.reduce((a, [, m]) => a + val(m), 0);
    const out = { basis: byImpulse ? 'impulse' : 'peak' };
    for (const [c, m] of cs) out[c] = total > 0 ? val(m) / total : null;
    return out;
  },

  /* ---------- recording ---------- */
  async start() {
    const live = this.liveCorners();
    if (!live.length) { toast('Connect at least one corner board first'); return; }
    if (live.length < 4) toast(`Only ${live.length} of 4 corners connected — recording anyway`);
    this.run = {
      startedAt: new Date().toISOString(), endedAt: null, count: 0, labelled: 0,
      bed: { ...HDC.bed, areaA: HDC.areaA, areaB: HDC.areaB, frame: HDC.frame },
      coords: 'cm, origin at the bed centre (red cross); x along the length (+ toward corners 2/3), y across (+ toward corners 1/2)',
      window: { preMs: HDC.preMs, postMs: HDC.postMs },
      boards: this.snapshotBoards(),
    };
    try { this.run.id = await DB.put('hdRuns', this.run); }
    catch (e) { console.warn('[hd] could not start a run', e); toast("Couldn't start recording"); this.run = null; return; }
    this.open = [];
    for (const c of live) {
      const b = this.boardAt(c);
      b.clearSignal();
      this.sendTo(b, 't');     // the settings, so smooth_ms is known for the filtered signal
      this.sendTo(b, 'd t');
    }
    if (typeof Debug !== 'undefined') Debug.setArmed(true);
    this.render();
  },

  async stop() {
    if (!this.run) return;
    // Landings still being matched belong to this run: save them with whatever arrived.
    for (const g of this.open.splice(0)) await this.finish(g);
    const run = this.run;
    this.run = null;
    for (const c of HD_CORNERS) { const b = this.boardAt(c); if (b) this.sendTo(b, 'd 0'); }
    if (typeof Debug !== 'undefined') Debug.setArmed(false);
    run.endedAt = new Date().toISOString();
    run.boards = this.snapshotBoards(run.boards);
    try { await DB.put('hdRuns', run); } catch (e) { console.warn('[hd] could not close the run', e); }
    toast(`Saved ${run.count} landing${run.count === 1 ? '' : 's'}`);
    this.render();
  },

  /** Which board was where, how it was mounted, and the settings it ran. */
  snapshotBoards(prev = {}) {
    const out = {};
    for (const c of HD_CORNERS) {
      const cfg = this.cfg(c), b = this.boardAt(c);
      out[c] = {
        name: cfg.name, spring: cfg.spring, edge: cfg.edge, main: this.mainCorner() === c,
        pos: HD_CORNER_POS[c],
        params: b ? { ...b.params } : (prev[c] || {}).params || {},
        g0: b && b.g0 ? b.g0.slice() : (prev[c] || {}).g0 || null,
        periodUs: b ? b.periodUs : (prev[c] || {}).periodUs || null,
      };
    }
    return out;
  },

  /* ---------- the extra boards' own connections ---------- */
  sendTo(b, cmd) {
    const rx = b === this.mainBoard ? (typeof BLE !== 'undefined' ? BLE.rx : null) : b.rx;
    if (!rx) return Promise.resolve(false);
    // One write at a time per board: Web Bluetooth refuses overlapping GATT operations.
    b.sendChain = b.sendChain.then(async () => {
      try {
        await rx.writeValue(new TextEncoder().encode(cmd + '\n'));
        if (typeof Debug !== 'undefined') Debug.push(`[${this.cornerOf(b) || '?'}] ${cmd}`, 'out');
        return true;
      } catch (e) { console.info('[hd] send failed', cmd, e.message); return false; }
    });
    return b.sendChain;
  },

  async connectBoard(c) {
    if (!BLE.supported()) { toast('This browser has no Bluetooth'); return; }
    const svc = CONFIG.serviceUUID.toLowerCase();
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: CONFIG.deviceNamePrefix }, { services: [svc] }],
        optionalServices: [svc],
      });
    } catch (e) {
      if (e.name !== 'NotFoundError') toast("Couldn't open the sensor list. Is Bluetooth switched on?");
      return;
    }
    // Picked the main sensor: it already has a connection, so just put it here.
    if (BLE.device && device.id === BLE.device.id) { this.useMain(c); return; }
    // Picked a board that sits at another corner: move it.
    for (const o of HD_CORNERS) {
      if (o !== c && this.boards[o].device && this.boards[o].device.id === device.id) this.disconnectBoard(this.boards[o], { forget: true });
    }
    await this.attach(this.boards[c], device);
  },

  /** Reconnect a remembered board without the picker, if the browser still has permission. */
  async reconnectBoard(c) {
    const name = this.cfg(c).name;
    if (navigator.bluetooth && navigator.bluetooth.getDevices && name) {
      try {
        const d = (await navigator.bluetooth.getDevices()).find((x) => x.name === name);
        if (d) { await this.attach(this.boards[c], d); return; }
      } catch (e) { /* fall through to the picker */ }
    }
    this.connectBoard(c);
  },

  async attach(b, device) {
    if (b.device && b.device !== device) this.disconnectBoard(b);
    b.device = device;
    b.userDisconnect = false;
    device.removeEventListener('gattserverdisconnected', b.onDisconnected);
    device.addEventListener('gattserverdisconnected', b.onDisconnected);
    const cfg = this.cfg(b.corner);
    if (device.name) cfg.name = device.name;
    // A board can't be the main sensor and an extra at once.
    if (cfg.name && cfg.name === S.deviceName && this.mainConnected()) { this.disconnectBoard(b); this.useMain(b.corner); return; }
    this.save();
    b.state = 'connecting';
    this.render();
    try { await this.setupBoard(b); }
    catch (e) {
      console.warn('[hd] connect failed', e);
      b.state = 'lost';
      toast(`Couldn't connect corner ${b.corner}. Is it switched on and nearby?`);
      this.render(); this.renderLive();
    }
  },

  async setupBoard(b) {
    const svc = CONFIG.serviceUUID.toLowerCase();
    const server = await b.device.gatt.connect();
    const service = await server.getPrimaryService(svc);
    const tx = await service.getCharacteristic(CONFIG.characteristicUUID.toLowerCase());
    let rx = null;
    try { rx = await service.getCharacteristic(CONFIG.commandCharacteristicUUID.toLowerCase()); } catch { rx = null; }
    if (b.tx) b.tx.removeEventListener('characteristicvaluechanged', b.onValue);
    b.tx = tx; b.rx = rx;
    b.decoder = new TextDecoder();
    b.lineBuf = '';
    b.clearSignal();
    tx.addEventListener('characteristicvaluechanged', b.onValue);
    await tx.startNotifications();
    b.state = 'connected';
    this.render(); this.renderLive();
    await this.sendTo(b, 't');
    if (this.run) await this.sendTo(b, 'd t');
  },

  async boardLost(b) {
    if (b.userDisconnect || !b.device) { b.state = 'empty'; this.render(); this.renderLive(); return; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      b.state = 'reconnecting';
      this.render(); this.renderLive();
      await sleep(1000 * attempt);
      if (b.userDisconnect) return;
      try { await this.setupBoard(b); return; } catch (e) { /* try again */ }
    }
    b.state = 'lost';
    toast(`Corner ${b.corner} disconnected`);
    this.render(); this.renderLive();
  },

  disconnectBoard(b, { forget = false } = {}) {
    b.userDisconnect = true;
    if (b.device) {
      b.device.removeEventListener('gattserverdisconnected', b.onDisconnected);
      if (b.device.gatt.connected) b.device.gatt.disconnect();
    }
    if (b.tx) b.tx.removeEventListener('characteristicvaluechanged', b.onValue);
    b.device = null; b.tx = null; b.rx = null;
    b.state = 'empty';
    if (forget) { this.cfg(b.corner).name = null; this.save(); }
  },

  /** Put the main sensor (the one on "Connect sensor") at this corner. */
  useMain(c) {
    if (!S.deviceName) { toast('Connect the main sensor on the Live screen first'); return; }
    for (const o of HD_CORNERS) if (this.cfg(o).name === S.deviceName) this.cfg(o).name = null;
    this.disconnectBoard(this.boards[c]);
    this.cfg(c).name = S.deviceName;
    this.mainBoard.clearSignal();
    this.save();
    if (this.run) { this.sendTo(this.mainBoard, 't'); this.sendTo(this.mainBoard, 'd t'); }
    this.render(); this.renderLive();
  },

  /* ---------- drawing the bed ---------- */
  /** The bed from above, in cm, with the FIG red lines. opts: { shares, marker, status, tappable } */
  bedSVG({ shares = null, marker = null, status = {}, tappable = false } = {}) {
    const { L, W } = HDC.bed, hl = L / 2, hw = W / 2;
    const fl = HDC.frame.L / 2, fw = HDC.frame.W / 2;
    const aL = HDC.areaA.L / 2, aW = HDC.areaA.W / 2, b2 = HDC.areaB / 2, cr = HDC.cross / 2;
    const pad = 12;
    const vb = `${-fl - pad} ${-fw - pad} ${2 * (fl + pad)} ${2 * (fw + pad)}`;
    const Y = (y) => -y;   // drawn with y up
    const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${Y(y1)}" x2="${x2}" y2="${Y(y2)}"/>`;
    // Webbing: faint lines so the bed reads as a bed, not a box.
    let web = '';
    for (let x = -hl + 20; x < hl; x += 20) web += `<line x1="${x}" y1="${-hw}" x2="${x}" y2="${hw}"/>`;
    for (let y = -hw + 20; y < hw; y += 20) web += `<line x1="${-hl}" y1="${y}" x2="${hl}" y2="${y}"/>`;
    const red = [
      // Area A's long sides, continued to both ends of the bed
      line(-hl, aW, hl, aW), line(-hl, -aW, hl, -aW),
      // Area A's short sides, continued to both sides of the bed
      line(-aL, -hw, -aL, hw), line(aL, -hw, aL, hw),
      // Area B: the centre square (its top and bottom are Area A's long sides)
      line(-b2, -aW, -b2, aW), line(b2, -aW, b2, aW),
      // the red cross
      line(-cr, 0, cr, 0), line(0, -cr, 0, cr),
    ].join('');
    // Each board sits on a spring at its corner: halfway between bed and frame.
    const sx = (hl + fl) / 2, sy = (hw + fw) / 2;
    const corners = HD_CORNERS.map((c) => {
      const [px, py] = HD_CORNER_POS[c];
      const x = Math.sign(px) * sx, y = Math.sign(py) * sy;
      const share = shares ? shares[c] : null;
      const st = status[c] || 'off';
      const r = share != null ? 9 + 26 * Math.sqrt(share) : 9;
      // The share reads inside the bed corner, clear of the springs.
      const tx = Math.sign(px) * (hl - 34), ty = Math.sign(py) * (hw - 22);
      return `<g class="hd-corner" data-state="${st}">` +
        `<circle class="hd-corner-dot${share != null ? ' has-share' : ''}" cx="${x}" cy="${Y(y)}" r="${r.toFixed(1)}"/>` +
        `<text class="hd-corner-num" x="${x}" y="${Y(y)}" dy="0.35em">${c}</text>` +
        (share != null ? `<text class="hd-share" x="${tx}" y="${Y(ty)}" dy="0.35em">${Math.round(share * 100)}%</text>` : '') +
        `</g>`;
    }).join('');
    const mk = marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)
      ? `<g class="hd-marker"><circle cx="${marker.x}" cy="${Y(marker.y)}" r="11"/><line x1="${marker.x - 18}" y1="${Y(marker.y)}" x2="${marker.x + 18}" y2="${Y(marker.y)}"/><line x1="${marker.x}" y1="${Y(marker.y) - 18}" x2="${marker.x}" y2="${Y(marker.y) + 18}"/></g>`
      : '';
    return `<svg class="hd-bed${tappable ? ' tappable' : ''}" viewBox="${vb}" role="img" aria-label="Trampoline bed from above with the FIG red lines${shares ? ', and each corner’s share of the last landing' : ''}">` +
      `<rect class="hd-frame" x="${-fl}" y="${-fw}" width="${2 * fl}" height="${2 * fw}" rx="14"/>` +
      `<rect class="hd-mat" x="${-hl}" y="${-hw}" width="${L}" height="${W}"/>` +
      `<g class="hd-web">${web}</g>` +
      `<g class="hd-red">${red}</g>` +
      corners + mk +
      `</svg>`;
  },

  cornerStatus() {
    const st = {};
    for (const c of HD_CORNERS) {
      if (this.mainCorner() === c) st[c] = this.mainConnected() ? 'on' : 'off';
      else st[c] = { connected: 'on', connecting: 'wait', reconnecting: 'wait' }[this.boards[c].state] || 'off';
    }
    return st;
  },

  /* ---------- Live screen ---------- */
  renderLive() {
    const el = document.getElementById('live-hd');
    if (!el || el.hidden) return;
    const n = this.liveCorners().length;
    const last = this.last;
    const seen = last ? Object.keys(last.corners).length : 0;
    const basis = last && last.shares.basis === 'impulse' ? 'impulse' : 'peak force';
    el.innerHTML =
      `<div class="hd-head"><div><p class="kicker">HD · horizontal displacement</p>` +
      `<h2 class="hd-title">Where you land</h2></div>` +
      `<span class="hd-count${n === 4 ? ' all' : ''}">${n}/4 corners</span></div>` +
      this.bedSVG({ shares: last ? last.shares : null, status: this.cornerStatus() }) +
      `<p class="hd-note">${last
        ? `Last landing: each corner’s share of the ${basis}, seen by ${seen} of 4 corners. `
        : n ? 'Waiting for a landing. ' : 'Connect the corner boards in Debug → HD. '}` +
      `<span class="hd-soon">Landing position estimate coming soon.</span></p>`;
  },

  /* ---------- Debug panel ---------- */
  render() {
    if (typeof S === 'undefined' || S.view !== 'debug' || !this.on) return;
    this.renderBoards();
    this.renderStatus();
    this.renderRuns();
    this.renderLabel();
  },

  renderBoards() {
    const el = document.getElementById('hd-boards');
    if (!el) return;
    const mainC = this.mainCorner();
    // Laid out like the bed: 1 2 on top, 4 3 below.
    el.innerHTML = [1, 2, 4, 3].map((c) => {
      const cfg = this.cfg(c), b = this.boards[c];
      const isMain = mainC === c;
      const state = isMain ? (this.mainConnected() ? 'connected' : 'main-off') : b.state;
      const label = {
        connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…',
        lost: 'Disconnected', empty: cfg.name ? 'Not connected' : 'No board', 'main-off': 'Main sensor not connected',
      }[state];
      const sig = isMain ? this.mainBoard : b;
      const live = state === 'connected';
      let btns = '';
      if (isMain) btns = `<button type="button" class="btn-small" data-hd="unmain" data-c="${c}">Not here</button>`;
      else if (live) btns = `<button type="button" class="btn-small" data-hd="disconnect" data-c="${c}">Disconnect</button>`;
      else {
        btns = cfg.name
          ? `<button type="button" class="btn-small" data-hd="reconnect" data-c="${c}">Reconnect</button><button type="button" class="btn-small" data-hd="connect" data-c="${c}">Other…</button>`
          : `<button type="button" class="btn-small" data-hd="connect" data-c="${c}">Connect</button>`;
        if (this.mainConnected() && mainC !== c) btns += `<button type="button" class="btn-small" data-hd="main" data-c="${c}">Main here</button>`;
      }
      return `<div class="hd-slot" data-state="${live ? 'on' : 'off'}">` +
        `<div class="hd-slot-head"><span class="hd-slot-num">${c}</span><span class="hd-slot-where">${HD_CORNER_NAME[c]}</span>` +
        `${isMain ? '<span class="pill pill-demo">Main</span>' : ''}</div>` +
        `<div class="hd-slot-name">${esc(cfg.name ? splitDeviceName(cfg.name).label : '—')}</div>` +
        `<div class="hd-slot-state">${label}${live && this.run ? ` · ${sig.jumps} jumps` : ''}</div>` +
        `<div class="hd-slot-mount">` +
        `<label>Spring <input type="number" inputmode="numeric" min="1" max="40" step="1" value="${cfg.spring ?? ''}" data-hd-spring="${c}" placeholder="#"></label>` +
        `<select data-hd-edge="${c}" aria-label="Spring counted from">` +
        `<option value="end"${cfg.edge !== 'side' ? ' selected' : ''}>from the end</option>` +
        `<option value="side"${cfg.edge === 'side' ? ' selected' : ''}>from the side</option></select></div>` +
        `<div class="hd-slot-btns">${btns}</div></div>`;
    }).join('');
  },

  renderStatus() {
    const el = document.getElementById('hd-status');
    const btn = document.getElementById('hd-rec');
    if (!el || !btn) return;
    btn.textContent = this.run ? 'Stop recording' : 'Start recording';
    btn.classList.toggle('btn-danger-solid', !!this.run);
    el.innerHTML = this.run
      ? `<b>Recording</b> since ${esc(fmtTime(this.run.startedAt))} · ${this.run.count} landing${this.run.count === 1 ? '' : 's'} saved`
      : `${this.liveCorners().length} of 4 corners connected · not recording`;
  },

  async renderRuns() {
    const el = document.getElementById('hd-runs');
    if (!el) return;
    let runs = [];
    try { runs = await DB.all('hdRuns'); } catch (e) { /* store not there yet */ }
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    el.innerHTML = runs.length ? runs.slice(0, 30).map((r) =>
      `<div class="crow"><span>${esc(fmtDateShort(r.startedAt))} ${esc(fmtTime(r.startedAt))} · ${r.count} landing${r.count === 1 ? '' : 's'}` +
      ` · <span class="${r.labelled >= r.count && r.count ? '' : 'dim'}">${r.labelled || 0} labelled</span></span>` +
      `<span class="crow-btns">` +
      `<button type="button" class="btn-small" data-hd="label" data-run="${r.id}"${r.count ? '' : ' disabled'}>Label</button>` +
      `<button type="button" class="btn-small" data-hd="csv" data-run="${r.id}"${r.count ? '' : ' disabled'}>CSV</button>` +
      `<button type="button" class="btn-small" data-hd="del" data-run="${r.id}"${this.run && this.run.id === r.id ? ' disabled' : ''}>Delete</button>` +
      `</span></div>`).join('')
      : '<p class="dim">No HD recordings yet.</p>';
  },

  /* ---------- labelling: where did each jump really land? ---------- */
  async openLabel(runId) {
    const run = await DB.get('hdRuns', runId);
    const jumps = (await DB.byIndex('hdJumps', 'runId', runId)).sort((a, b) => a.n - b.n);
    if (!run || !jumps.length) { toast('Nothing to label in that recording'); return; }
    const first = jumps.findIndex((j) => j.x == null || j.y == null);
    this.label = { run, jumps, i: first >= 0 ? first : 0 };
    this.renderLabel();
    const el = document.getElementById('hd-label');
    if (el) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  },

  renderLabel() {
    const el = document.getElementById('hd-label');
    if (!el) return;
    const L = this.label;
    el.hidden = !L;
    if (!L) { el.innerHTML = ''; return; }
    const j = L.jumps[L.i];
    const done = L.jumps.filter((x) => x.x != null && x.y != null).length;
    const rows = HD_CORNERS.map((c) => {
      const m = j.corners[c];
      if (!m) return `<tr><td>${c}</td><td colspan="4" class="dim">not seen</td></tr>`;
      const f = m.feat || {};
      const sh = j.shares && j.shares[c] != null ? `${Math.round(j.shares[c] * 100)}%` : '–';
      return `<tr><td>${c}</td><td>${sh}</td><td>${f.peakS != null ? f.peakS.toFixed(2) : m.peakG.toFixed(2)}</td>` +
        `<td>${f.impulseGs != null ? f.impulseGs.toFixed(3) : '–'}</td><td>${Math.round(m.contactMs)}</td></tr>`;
    }).join('');
    el.innerHTML =
      `<div class="hd-label-head"><strong>Landing ${j.n} of ${L.jumps.length}</strong>` +
      `<span class="dim">${done} labelled · ${esc(fmtTime(j.at))}</span>` +
      `<button type="button" class="btn-small" data-hd="label-close">Done</button></div>` +
      this.bedSVG({ shares: j.shares, marker: { x: j.x, y: j.y }, status: { 1: 'on', 2: 'on', 3: 'on', 4: 'on' }, tappable: true }) +
      `<p class="dim">Tap where this landing was, or type it. cm from the red cross: x along the bed (+ toward corners 2 and 3), y across (+ toward corners 1 and 2).</p>` +
      `<div class="hd-xy">` +
      `<label>x <input type="number" inputmode="decimal" step="1" min="-253" max="253" data-hd-xy="x" value="${j.x ?? ''}"></label>` +
      `<label>y <input type="number" inputmode="decimal" step="1" min="-146" max="146" data-hd-xy="y" value="${j.y ?? ''}"></label>` +
      `<button type="button" class="btn-small" data-hd="label-clear">Clear</button></div>` +
      `<div class="dbg-row">` +
      `<button type="button" class="btn-small" data-hd="label-prev"${L.i ? '' : ' disabled'}>◀ Prev</button>` +
      `<button type="button" class="btn-small" data-hd="label-next"${L.i < L.jumps.length - 1 ? '' : ' disabled'}>Next ▶</button>` +
      `<button type="button" class="btn-small" data-hd="label-todo">Next unlabelled</button></div>` +
      `<table class="hd-table"><thead><tr><th>Corner</th><th>Share</th><th>Peak g</th><th>Impulse g·s</th><th>Bed ms</th></tr></thead><tbody>${rows}</tbody></table>`;
  },

  async setLabel(x, y) {
    const L = this.label;
    if (!L) return;
    const j = L.jumps[L.i];
    const clamp = (v, m) => (Number.isFinite(v) ? Math.max(-m, Math.min(m, Math.round(v))) : null);
    j.x = clamp(x, HDC.frame.L / 2);
    j.y = clamp(y, HDC.frame.W / 2);
    j.labelledAt = j.x != null && j.y != null ? new Date().toISOString() : null;
    L.run.labelled = L.jumps.filter((k) => k.x != null && k.y != null).length;
    try {
      await DB.put('hdJumps', j);
      await DB.put('hdRuns', L.run);
      if (this.run && this.run.id === L.run.id) this.run.labelled = L.run.labelled;
    } catch (e) { console.warn('[hd] label save failed', e); toast("Couldn't save that label"); }
    this.renderLabel();
    this.renderRuns();
  },

  /** A tap on the review bed, in bed cm. */
  tapBed(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    this.setLabel(p.x, -p.y);
  },

  /* ---------- export ---------- */
  async exportRun(runId) {
    const run = await DB.get('hdRuns', runId);
    const jumps = (await DB.byIndex('hdJumps', 'runId', runId)).sort((a, b) => a.n - b.n);
    if (!run || !jumps.length) { toast('Nothing to export'); return; }
    const stamp = slug(run.startedAt);
    const files = [
      new File([this.summaryCsv(run, jumps)], `${slug(CONFIG.brandName)}-hd-${stamp}-landings.csv`, { type: 'text/csv' }),
      new File([this.waveCsv(run, jumps)], `${slug(CONFIG.brandName)}-hd-${stamp}-signals.csv`, { type: 'text/csv' }),
    ];
    if (isMobile() && navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: 'HD recording' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      await sleep(300);   // some browsers drop a second download fired in the same tick
    }
    toast('Saved 2 CSV files');
  },

  /** One row per landing: the label columns (x_cm, y_cm, blank until labelled)
      and, per corner, the board, its mount and its numbers. No comment lines,
      so it opens cleanly in a spreadsheet for labelling there. */
  summaryCsv(run, jumps) {
    const per = ['device', 'spring', 'spring_from', 'index', 'flightMs', 'contactMs', 'peakG', 'flags',
      'onsetIdx', 'takeoffIdx', 'peakS', 'peakS_ms', 'impulse_gs', 'meanS', 'dipS', 'peakV', 'share', 'complete'];
    const head = ['run_id', 'run_started', 'landing', 'time', 'x_cm', 'y_cm', 'share_basis'];
    for (const c of HD_CORNERS) for (const k of per) head.push(`c${c}_${k}`);
    const num = (v, dp) => (v == null || !Number.isFinite(v) ? '' : dp == null ? String(v) : v.toFixed(dp));
    const rows = [head.join(',')];
    for (const j of jumps) {
      const r = [run.id, run.startedAt, j.n, j.at, num(j.x), num(j.y), j.shares ? j.shares.basis : ''];
      for (const c of HD_CORNERS) {
        const m = j.corners[c], bd = (run.boards || {})[c] || {}, f = (m && m.feat) || {};
        if (!m) { r.push(csvCell(bd.name || ''), num(bd.spring), bd.edge || '', ...Array(per.length - 3).fill('')); continue; }
        r.push(csvCell(m.deviceName || bd.name || ''), num(bd.spring), bd.edge || '', m.index, num(m.flightMs, 1), num(m.contactMs, 1),
          num(m.peakG, 2), m.flags, num(m.onsetIdx, 2), num(m.takeoffIdx, 2), num(f.peakS, 4), num(f.peakSMs, 1),
          num(f.impulseGs, 5), num(f.meanS, 4), num(f.dipS, 4), num(f.peakV, 4),
          num(j.shares ? j.shares[c] : null, 4), m.complete ? 1 : 0);
      }
      rows.push(r.join(','));
    }
    return rows.join('\r\n') + '\r\n';
  },

  /** Every saved sample: one row per corner per sample, t_ms from that corner's
      landing onset. The run's setup is in # lines at the top. */
  waveCsv(run, jumps) {
    const head = [
      '# 2themoon HD recording: four-corner signals',
      `# run ${run.id} started ${run.startedAt} ended ${run.endedAt || ''}`,
      `# bed ${HDC.bed.L} x ${HDC.bed.W} cm (FIG); coords: ${run.coords}`,
      `# window: ${run.window.preMs} ms before onset to ${run.window.postMs} ms after takeoff`,
      '# v = vertical specific force (g, 1 at rest); s = v through the detector filter (smooth_ms), lag removed',
    ];
    for (const c of HD_CORNERS) {
      const b = (run.boards || {})[c] || {};
      head.push(`# corner ${c} (${HD_CORNER_NAME[c]}) at ${(b.pos || HD_CORNER_POS[c]).join(',')} cm: ${b.name || 'none'}` +
        `${b.main ? ' [main]' : ''}, spring ${b.spring ?? '?'} from the ${b.edge || '?'}, periodUs ${b.periodUs ?? '?'}, g0 ${(b.g0 || []).join(' ')}`);
      const ps = Object.entries(b.params || {}).map(([k, v]) => `${k}=${v}`).join(' ');
      if (ps) head.push(`# corner ${c} params: ${ps}`);
    }
    const rows = [...head, 'landing,corner,idx,t_ms,ax,ay,az,v,s'];
    const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : '');
    for (const j of jumps) {
      for (const c of HD_CORNERS) {
        const m = j.corners[c];
        if (!m || !m.win) continue;
        const w = m.win, per = m.periodUs / 1000;
        for (let k = 0; k < w.idx.length; k++) {
          rows.push(`${j.n},${c},${w.idx[k]},${((w.idx[k] - m.onsetIdx) * per).toFixed(2)},${f(w.ax[k])},${f(w.ay[k])},${f(w.az[k])},${f(w.v[k])},${f(w.s[k])}`);
        }
      }
    }
    return rows.join('\r\n') + '\r\n';
  },

  async deleteRun(runId) {
    if (!(await confirmDialog('Delete this HD recording?', 'Its landings, signals and labels are removed from this phone. Export the CSV first if you need it.'))) return;
    await DB.delByIndex('hdJumps', 'runId', runId);
    await DB.del('hdRuns', runId);
    if (this.label && this.label.run.id === runId) this.label = null;
    this.render();
  },

  /* ---------- events ---------- */
  wire() {
    const sw = document.getElementById('hd-switch');
    if (sw) sw.addEventListener('click', () => this.setOn(!this.on));
    const panel = document.getElementById('hd-panel');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const svg = e.target.closest('svg.hd-bed.tappable');
      if (svg) { this.tapBed(svg, e); return; }
      const btn = e.target.closest('[data-hd]');
      if (!btn) return;
      const c = Number(btn.dataset.c), run = Number(btn.dataset.run);
      const L = this.label;
      switch (btn.dataset.hd) {
        case 'connect':    this.connectBoard(c); break;
        case 'reconnect':  this.reconnectBoard(c); break;
        case 'disconnect': this.disconnectBoard(this.boards[c]); this.render(); this.renderLive(); break;
        case 'main':       this.useMain(c); break;
        case 'unmain':     this.cfg(c).name = null; this.save(); this.render(); this.renderLive(); break;
        case 'rec':        if (this.run) this.stop(); else this.start(); break;
        case 'label':      this.openLabel(run); break;
        case 'csv':        this.exportRun(run); break;
        case 'del':        this.deleteRun(run); break;
        case 'label-close': this.label = null; this.renderLabel(); break;
        case 'label-clear': this.setLabel(null, null); break;
        case 'label-prev': if (L && L.i > 0) { L.i--; this.renderLabel(); } break;
        case 'label-next': if (L && L.i < L.jumps.length - 1) { L.i++; this.renderLabel(); } break;
        case 'label-todo': {
          if (!L) break;
          const n = L.jumps.length;
          for (let k = 1; k <= n; k++) {
            const i = (L.i + k) % n;
            if (L.jumps[i].x == null || L.jumps[i].y == null) { L.i = i; this.renderLabel(); return; }
          }
          toast('Every landing in this recording is labelled');
          break;
        }
      }
    });

    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.hdSpring) {
        const v = parseInt(t.value, 10);
        this.cfg(Number(t.dataset.hdSpring)).spring = Number.isFinite(v) && v > 0 ? v : null;
        this.save();
      } else if (t.dataset.hdEdge) {
        this.cfg(Number(t.dataset.hdEdge)).edge = t.value === 'side' ? 'side' : 'end';
        this.save();
      } else if (t.dataset.hdXy && this.label) {
        const j = this.label.jumps[this.label.i];
        const val = t.value === '' ? null : Number(t.value);
        const x = t.dataset.hdXy === 'x' ? val : j.x, y = t.dataset.hdXy === 'y' ? val : j.y;
        this.setLabel(x, y);
      }
    });
  },
};
