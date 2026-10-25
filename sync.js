'use strict';
/* ==========================================================================
   Synchro — two trampolines side by side, one sensor each: how far apart
   were the two jumpers' landings, to the millisecond?

   How it hangs together:
   - Two slots, Left and Right. Each is either the main sensor (connected the
     usual way with "Connect sensor", so its jumps still feed the Live bars) or
     a board connected from the Synchro tab, which only ever feeds Synchro.
   - Each board's jumps are stamped by its own clock (timestampMs, ms since it
     booted), so the two can only be compared once each clock is tied to the
     phone's. That is the "z" ping (firmware link.h): send "z seq" at t1,
     the board answers Z,seq,rxMs,txMs, the reply lands at t4. Then
       offset = ((rxMs - t1) + (txMs - t4)) / 2      board clock minus phone clock
       delay  = (t4 - t1) - (txMs - rxMs)            round trip spent on the radio
     and the offset is off by at most delay / 2. Bluetooth delays jump around,
     so only the quickest replies of the last half-minute are trusted.
   - Older firmware ignores "z" (answers with help text). Then the offset falls
     back to the jumps themselves, as HD does: rougher, and shown as such.
   - Pairing is by count, Left leading: after Resync, Left's Nth landing goes
     with Right's Nth, however far apart they are. So a jumper a whole bounce
     (or two) behind still shows as "Right 1.52 s behind". The cost: a landing
     one sensor misses shifts every pair after it, so a gap that suddenly
     changes by about a bounce is flagged, and Resync puts it right.
   - Resync starts a new run: anything that landed before the button is
     ignored, so the next landing on each side is jump 1 again. Runs stay in
     memory until saved to History (IndexedDB store syncRuns) with Save.

   Its own tab, Synchro, and a Synchro list in History. Needs app.js
   (parsePacket, BLE, CONFIG, S, DB, JumpChart, secs, toast, confirmDialog).
   ========================================================================== */

const SYNCC = {
  storageKey: '2themoon-sync',
  burst: 8,               // pings straight after connecting, to get a good offset fast
  burstGapMs: 150,
  pingEveryMs: 1000,      // then one a second, to follow the two clocks drifting
  pingTimeoutMs: 1500,    // no answer by then: count it lost
  oldFirmwareAfter: 4,    // lost pings, with no Z ever, before deciding the firmware has no "z"
  keepMs: 30000,          // ping results the offset is worked out from
  nearBestMs: 4,          // ...those within this much of the quickest round trip are averaged
  sampleJitterMs: 1.25,   // half a sample period: how far the board's own clock read can be out
  staleMs: 5000,          // a J this far in the past is a backfill, not a landing just now
  dupMs: 150,             // a landing this close to that side's last one is the same landing again
  slipShare: 0.6,         // gap changing by this share of a bounce in one jump: a landing was likely missed
  keep: 500,              // pairs kept per run
  togetherMs: 10,         // shown as "together" below this
};

const SYNC_SLOTS = ['L', 'R'];
const SYNC_NAME = { L: 'Left', R: 'Right' };

/* -------------------------------------------------------------------------
   One side's board
   ------------------------------------------------------------------------- */
class SyncBoard {
  constructor(slot) {
    this.slot = slot;
    this.device = null; this.tx = null; this.rx = null; this.decoder = null;
    this.state = 'empty';       // empty | connecting | connected | reconnecting | lost
    this.userDisconnect = false;
    this.lineBuf = '';
    this.sendChain = Promise.resolve();
    this.onValue = (e) => this.feed(this.decoder.decode(e.target.value, { stream: true }), rxTime(e));   // rxTime: app.js
    this.onDisconnected = () => Sync.boardLost(this);
    this.clearClock();
  }
  clearClock() {
    this.seq = 0;
    this.waiting = null;        // { seq, t1 } of the ping in flight
    this.samples = [];          // { at, off, delay } per answered ping
    this.passive = [];          // fallback: (board landing ms - phone arrival ms) per jump
    this.firmware = 'unknown';  // unknown | ok | old
    this.itvl = null;           // BLE connection interval the board reports, ms
    this.lost = 0;
    this.burstLeft = SYNCC.burst;
    this.nextPingAt = 0;
  }
  feed(text, at) {
    this.lineBuf += text;
    let i;
    while ((i = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, i).replace(/\r$/, '');
      this.lineBuf = this.lineBuf.slice(i + 1);
      let p = null;
      try { p = parsePacket(line); } catch (e) { p = null; }
      if (p && p.kind === 'jump' && typeof Debug !== 'undefined') Debug.push(`[${this.slot}] ${line}`, 'in');
      if (p) Sync.handle(this, p, at);
    }
    if (this.lineBuf.length > 1024) this.lineBuf = '';
  }
}

/* -------------------------------------------------------------------------
   The Synchro module
   ------------------------------------------------------------------------- */
const Sync = {
  ready: false,
  settings: { slots: {} },    // slots[s] = { name } — remembered per browser
  boards: {},                 // slot -> SyncBoard (boards connected from this panel)
  mainBoard: null,            // the main sensor's clock state (no GATT of its own)
  run: null,                  // the run on now (see newRun)
  runs: [],                   // earlier runs this visit, oldest first
  queue: { L: [], R: [] },    // landings waiting for the other side's landing of the same count
  lastLand: { L: -Infinity, R: -Infinity },   // phone-clock landing, to drop repeats
  resetAt: 0,                 // phone clock: landings before this belong to the last run
  jumpId: 0,                  // ids for the charts' jumps
  charts: {},                 // slot -> JumpChart on the Synchro tab
  histCharts: [],             // JumpCharts in an open History run
  timer: null,

  /* ---------- lifecycle ---------- */
  init() {
    if (this.ready) return;
    this.ready = true;
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SYNCC.storageKey) || '{}')); } catch (e) { /* defaults */ }
    if (!this.settings.slots) this.settings.slots = {};
    for (const s of SYNC_SLOTS) this.boards[s] = new SyncBoard(s);
    this.mainBoard = new SyncBoard('main');
    delete this.settings.on;   // from when Synchro sat behind a Debug switch
    this.run = this.newRun();
    for (const s of SYNC_SLOTS) {
      const el = document.getElementById(`sync-chart-${s}`);
      if (el) this.charts[s] = new JumpChart(el, { live: true, emptyText: `<strong>No jumps yet</strong>${SYNC_NAME[s]} trampoline's jumps appear here.` });
    }
    this.wire();
    this.timer = setInterval(() => this.tick(), 100);
    this.render();
  },

  save() {
    try { localStorage.setItem(SYNCC.storageKey, JSON.stringify(this.settings)); } catch (e) { /* private mode */ }
  },

  /** A run: the jumps from one Resync to the next. */
  newRun() {
    return {
      n: this.runs.length + 1,
      startedAt: new Date().toISOString(),
      pairs: [],               // newest last
      jumps: { L: [], R: [] }, // every landing on each side, paired or not, for the bar charts
      savedId: null,           // its syncRuns id once saved
      dirty: false,            // jumps since the last save
    };
  },

  /* ---------- which board is where ---------- */
  mainConnected() { return typeof BLE !== 'undefined' && BLE.state === 'connected' && !S.demo; },
  /** The slot the main sensor is in, or null. Remembered by the sensor's name. */
  mainSlot() {
    if (!S.deviceName) return null;
    for (const s of SYNC_SLOTS) if (this.cfg(s).name === S.deviceName) return s;
    return null;
  },
  boardAt(s) {
    if (this.mainSlot() === s) return this.mainConnected() ? this.mainBoard : null;
    const b = this.boards[s];
    return b.state === 'connected' ? b : null;
  },
  slotOf(b) { return b === this.mainBoard ? this.mainSlot() : b.slot; },
  cfg(s) { return this.settings.slots[s] || (this.settings.slots[s] = { name: null }); },

  /* ---------- intake ---------- */
  /** Every line from the main sensor (app.js ingestLine). */
  mainLine(line, p) {
    if (!this.ready || !p) return;
    if (p.kind === 'name') {
      // A (re)connect, maybe after a reboot: its clock may have started again.
      this.mainBoard.clearClock();
      this.render();
      return;
    }
    if (!this.mainSlot()) return;
    this.handle(this.mainBoard, p, BLE.rxAt || performance.now());
  },

  handle(b, p, at) {
    if (p.kind === 'clock') this.onClock(b, p, at);
    else if (p.kind === 'jump') this.onJump(b, p, at);
    else if (p.kind === 'name' && b !== this.mainBoard) { this.cfg(b.slot).name = p.name; this.save(); this.render(); }
  },

  /* ---------- clocks ---------- */
  ping(b) {
    const rx = b === this.mainBoard ? (typeof BLE !== 'undefined' ? BLE.rx : null) : b.rx;
    if (!rx) return;
    const seq = ++b.seq;
    // One write at a time per board: Web Bluetooth refuses overlapping GATT operations.
    b.sendChain = b.sendChain.then(async () => {
      const data = new TextEncoder().encode(`z ${seq}\n`);
      const t1 = performance.now();
      b.waiting = { seq, t1 };
      try {
        if (rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(data);
        else await rx.writeValue(data);
      } catch (e) {
        // Busy with another write (backfill, rename…): just try again on the next tick.
        if (b.waiting && b.waiting.seq === seq) b.waiting = null;
      }
    });
  },

  onClock(b, p, t4) {
    const w = b.waiting;
    if (!w || p.seq !== w.seq) return;   // a late answer to a ping already written off
    b.waiting = null;
    b.firmware = 'ok';
    b.lost = 0;
    b.itvl = p.itvl;
    const delay = (t4 - w.t1) - (p.tx - p.rx);
    const off = ((p.rx - w.t1) + (p.tx - t4)) / 2;
    if (!(delay >= 0) || !Number.isFinite(off)) return;
    // An offset nowhere near the last one means the board rebooted: its clock started again.
    const est = this.offset(b);
    if (est && Math.abs(off - est.off) > 1000) b.samples = [];
    b.samples.push({ at: t4, off, delay });
    const cut = t4 - SYNCC.keepMs;
    while (b.samples.length > 1 && b.samples[0].at < cut) b.samples.shift();
    this.renderBoardsSoon();
  },

  /** Board clock minus phone clock, and how far out it may be. null = not known yet. */
  offset(b) {
    const ss = b.samples;
    if (ss.length) {
      const best = Math.min(...ss.map((x) => x.delay));
      const near = ss.filter((x) => x.delay <= best + SYNCC.nearBestMs);
      const off = near.reduce((a, x) => a + x.off, 0) / near.length;
      return { off, err: best / 2 + SYNCC.sampleJitterMs, rough: false };
    }
    if (b.passive.length) {
      // A J goes out once the next landing is confirmed, so it always arrives
      // late: the largest (board - phone) is the closest to the real offset.
      // Detection takes ~100 ms+ and varies with the bounce, hence "rough".
      return { off: Math.max(...b.passive), err: null, rough: true };
    }
    return null;
  },

  /** Ping each board when it is due. One in flight per board, so a slow answer
      can't be confused with the next one. */
  tick() {
    const now = performance.now();
    for (const s of SYNC_SLOTS) {
      const b = this.boardAt(s);
      if (!b || b.firmware === 'old') continue;
      if (b.waiting) {
        if (now - b.waiting.t1 < SYNCC.pingTimeoutMs) continue;
        b.waiting = null;
        if (++b.lost >= SYNCC.oldFirmwareAfter && b.firmware === 'unknown') {
          b.firmware = 'old';
          toast(`${SYNC_NAME[s]} sensor needs a firmware update for exact synchro. Using rough timing.`);
          this.render();
          continue;
        }
      }
      if (now < b.nextPingAt) continue;
      b.nextPingAt = now + (b.burstLeft > 0 ? SYNCC.burstGapMs : SYNCC.pingEveryMs);
      if (b.burstLeft > 0) b.burstLeft--;
      this.ping(b);
    }
  },


  /* ---------- pairing the two sides' landings, by count ---------- */
  onJump(b, j, at) {
    const s = this.slotOf(b);
    if (!s) return;
    const land = j.timestamp + j.flightMs;   // the landing this J was sent for, board clock
    // Feed the fallback offset (and keep it fresh) whatever the firmware.
    b.passive.push(land - at);
    if (b.passive.length > 20) b.passive.shift();
    const o = this.offset(b);
    if (!o) return;
    const landAt = land - o.off;              // phone clock
    if (at - landAt > SYNCC.staleMs) return;  // backfilled, not this bounce
    if (landAt < this.resetAt) return;        // landed before Resync: the last run's
    if (Math.abs(landAt - this.lastLand[s]) < SYNCC.dupMs) return;   // the same landing sent again
    this.lastLand[s] = landAt;

    const run = this.run;
    run.jumps[s].push({ id: ++this.jumpId, index: j.index, flightMs: j.flightMs, contactMs: j.contactMs, peakG: j.peakG, flags: j.flags });
    run.dirty = true;
    this.queue[s].push({ j, landAt, takeAt: j.timestamp - o.off, err: o.err, rough: o.rough });
    while (this.queue.L.length && this.queue.R.length) this.addPair(this.queue.L.shift(), this.queue.R.shift());
    this.renderBoardsSoon();
    this.renderCharts();
    this.renderSaveBtn();
  },

  addPair(L, R) {
    const pairs = this.run.pairs;
    const prev = pairs[pairs.length - 1];
    const landDiff = R.landAt - L.landAt;     // + = Right behind Left
    // A gap that moves by most of a bounce in one jump: one sensor missed (or
    // added) a landing and the count has slipped. Real drift is never that fast.
    const bounce = L.j.flightMs + L.j.contactMs;
    const slip = !!prev && Number.isFinite(bounce) && Math.abs(landDiff - prev.landDiff) > SYNCC.slipShare * bounce;
    pairs.push({
      n: prev ? prev.n + 1 : 1,
      at: new Date().toISOString(),
      landDiff,
      takeDiff: R.takeAt - L.takeAt,
      flightL: L.j.flightMs, flightR: R.j.flightMs,
      contactL: L.j.contactMs, contactR: R.j.contactMs,
      err: L.err != null && R.err != null ? L.err + R.err : null,
      rough: L.rough || R.rough,
      slip,
    });
    if (pairs.length > SYNCC.keep) pairs.shift();
    this.renderNow();
    this.renderPairs();
  },

  /** Start again from jump 1. The run so far, if it has any jumps, is kept below. */
  resync() {
    if (this.run.pairs.length || this.run.jumps.L.length || this.run.jumps.R.length) this.runs.push(this.run);
    this.startNewRun();
    toast('Resynced. Start together: the next landing is jump 1.');
  },

  startNewRun() {
    this.run = this.newRun();
    this.queue = { L: [], R: [] };
    this.resetAt = performance.now();
    for (const s of SYNC_SLOTS) if (this.charts[s]) this.charts[s].setJumps([], { resetView: true });
    this.render();
  },

  async clearAll() {
    const unsaved = [...this.runs, this.run].filter((r) => r.pairs.length && (!r.savedId || r.dirty)).length;
    if (!this.run.pairs.length && !this.runs.length) return;
    const msg = unsaved
      ? `This run and every earlier one are removed from this screen. ${unsaved} ${unsaved === 1 ? 'has' : 'have'} not been saved to History.`
      : 'This run and every earlier one are removed from this screen. Saved runs stay in History.';
    if (!(await confirmDialog('Clear all synchro jumps?', msg, 'Clear'))) return;
    this.runs = [];
    this.startNewRun();
  },

  /* ---------- saving to History ---------- */
  sideName(s) { const n = this.cfg(s).name; return n ? splitDeviceName(n).label : SYNC_NAME[s]; },

  async saveRun(run) {
    if (!run || !run.pairs.length) { toast('No paired jumps to save yet'); return; }
    const rec = {
      startedAt: run.startedAt,
      savedAt: new Date().toISOString(),
      names: run.names || (run.names = { L: this.sideName('L'), R: this.sideName('R') }),
      pairs: run.pairs,
      jumps: run.jumps,
    };
    if (run.savedId != null) rec.id = run.savedId;
    try {
      run.savedId = await DB.put('syncRuns', rec);
      run.dirty = false;
      toast(rec.id != null ? 'Synchro run updated in History' : 'Synchro run saved to History');
    } catch (e) {
      console.warn('[sync] save failed', e);
      toast("Couldn't save the run");
    }
    this.renderSaveBtn();
    this.renderRuns();
  },

  saveLabel(run) {
    if (run.savedId == null) return 'Save to History';
    return run.dirty ? 'Save changes' : 'Saved ✓';
  },

  /* ---------- the extra boards' own connections ---------- */
  async connectBoard(s) {
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
    if (BLE.device && device.id === BLE.device.id) { this.useMain(s); return; }
    for (const o of SYNC_SLOTS) {
      if (o !== s && this.boards[o].device && this.boards[o].device.id === device.id) this.disconnectBoard(this.boards[o], { forget: true });
    }
    await this.attach(this.boards[s], device);
  },

  /** Reconnect a remembered board without the picker, if the browser still has permission. */
  async reconnectBoard(s) {
    const name = this.cfg(s).name;
    if (navigator.bluetooth && navigator.bluetooth.getDevices && name) {
      try {
        const d = (await navigator.bluetooth.getDevices()).find((x) => x.name === name);
        if (d) { await this.attach(this.boards[s], d); return; }
      } catch (e) { /* fall through to the picker */ }
    }
    this.connectBoard(s);
  },

  async attach(b, device) {
    if (b.device && b.device !== device) this.disconnectBoard(b);
    b.device = device;
    b.userDisconnect = false;
    device.removeEventListener('gattserverdisconnected', b.onDisconnected);
    device.addEventListener('gattserverdisconnected', b.onDisconnected);
    const cfg = this.cfg(b.slot);
    if (device.name) cfg.name = device.name;
    if (cfg.name && cfg.name === S.deviceName && this.mainConnected()) { this.disconnectBoard(b); this.useMain(b.slot); return; }
    this.save();
    b.state = 'connecting';
    this.render();
    try { await this.setupBoard(b); }
    catch (e) {
      console.warn('[sync] connect failed', e);
      b.state = 'lost';
      toast(`Couldn't connect the ${SYNC_NAME[b.slot].toLowerCase()} sensor. Is it switched on and nearby?`);
      this.render();
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
    b.clearClock();
    tx.addEventListener('characteristicvaluechanged', b.onValue);
    await tx.startNotifications();
    b.state = 'connected';
    this.render();
  },

  async boardLost(b) {
    if (b.userDisconnect || !b.device) { b.state = 'empty'; this.render(); return; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      b.state = 'reconnecting';
      this.render();
      await sleep(1000 * attempt);
      if (b.userDisconnect) return;
      try { await this.setupBoard(b); return; } catch (e) { /* try again */ }
    }
    b.state = 'lost';
    toast(`${SYNC_NAME[b.slot]} sensor disconnected`);
    this.render();
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
    if (forget) { this.cfg(b.slot).name = null; this.save(); }
  },

  /** Put the main sensor (the one on "Connect sensor") on this side. */
  useMain(s) {
    if (!S.deviceName) { toast('Connect the main sensor on the Live screen first'); return; }
    for (const o of SYNC_SLOTS) if (this.cfg(o).name === S.deviceName) this.cfg(o).name = null;
    this.disconnectBoard(this.boards[s]);
    this.cfg(s).name = S.deviceName;
    this.mainBoard.clearClock();
    this.save();
    this.render();
  },


  /* ---------- words ---------- */
  /** Left leads: "Right 23 ms behind", "Right 1.24 s ahead", or together. */
  verdict(d) {
    if (Math.abs(d) < SYNCC.togetherMs) return { dir: null, short: '=', text: 'Together' };
    return d > 0 ? { dir: 'behind', short: 'behind', text: 'Right behind' } : { dir: 'ahead', short: 'ahead', text: 'Right ahead' };
  },
  ms(d) {
    const a = Math.abs(d);
    return a < 1000 ? `${Math.round(a)} ms` : `${(a / 1000).toFixed(2)} s`;
  },
  clockText(b) {
    if (!b) return '';
    if (b.firmware === 'old') return 'Old firmware · rough timing';
    const o = this.offset(b);
    if (!o) return 'Syncing clock…';
    if (o.rough) return 'Clock: rough (from jumps)';
    // The interval is what limits the ±: the board asks for 15 ms while pinged,
    // and a phone that won't go that fast shows up here.
    return `Clock synced · ±${o.err.toFixed(1)} ms${b.itvl ? ` · BLE ${Math.round(b.itvl)} ms` : ''}`;
  },
  /** Seconds at the app's chosen precision, or a dash. */
  sec(ms) { return Number.isFinite(ms) ? secs(ms) : '–'; },
  meanGap(pairs) { return pairs.length ? pairs.reduce((a, p) => a + Math.abs(p.landDiff), 0) / pairs.length : null; },

  /* ---------- the Synchro tab ---------- */
  onTab() { return this.ready && typeof S !== 'undefined' && S.view === 'sync'; },

  render() {
    if (!this.onTab()) return;
    this.renderBoards();
    this.renderNow();
    this.renderCharts(true);
    this.renderPairs();
    this.renderSaveBtn();
    this.renderRuns();
  },

  renderBoardsSoon() {
    if (this.boardsTimer) return;
    this.boardsTimer = setTimeout(() => { this.boardsTimer = null; this.renderBoards(); }, 250);
  },

  /** Left and Right: which sensor, its clock, and that jumper's last jump. */
  renderBoards() {
    const el = document.getElementById('sync-boards');
    if (!el || !this.onTab()) return;
    const mainS = this.mainSlot();
    el.innerHTML = SYNC_SLOTS.map((s) => {
      const cfg = this.cfg(s), b = this.boards[s];
      const isMain = mainS === s;
      const state = isMain ? (this.mainConnected() ? 'connected' : 'main-off') : b.state;
      const label = {
        connected: this.clockText(this.boardAt(s)), connecting: 'Connecting…', reconnecting: 'Reconnecting…',
        lost: 'Disconnected', empty: cfg.name ? 'Not connected' : 'No sensor', 'main-off': 'Main sensor not connected',
      }[state];
      const live = state === 'connected';
      let btns = '';
      if (isMain) btns = `<button type="button" class="btn-small" data-sync="unmain" data-s="${s}">Not here</button>`;
      else if (live) btns = `<button type="button" class="btn-small" data-sync="disconnect" data-s="${s}">Disconnect</button>`;
      else {
        btns = cfg.name
          ? `<button type="button" class="btn-small" data-sync="reconnect" data-s="${s}">Reconnect</button><button type="button" class="btn-small" data-sync="connect" data-s="${s}">Other…</button>`
          : `<button type="button" class="btn-small" data-sync="connect" data-s="${s}">Connect</button>`;
        if (this.mainConnected() && mainS !== s) btns += `<button type="button" class="btn-small" data-sync="main" data-s="${s}">Main here</button>`;
      }
      const js = this.run.jumps[s], j = js[js.length - 1];
      return `<div class="hd-slot sync-slot" data-state="${live ? 'on' : 'off'}" data-who="${s}">` +
        `<div class="hd-slot-head"><span class="hd-slot-num">${s}</span><span class="hd-slot-where">${SYNC_NAME[s]} trampoline</span>` +
        `${s === 'L' ? '<span class="pill sync-lead">Lead</span>' : ''}${isMain ? '<span class="pill pill-demo">Main</span>' : ''}</div>` +
        `<div class="sync-times">` +
        `<div><span class="sync-t">${this.sec(j && j.flightMs)}</span><span class="sync-tl">Air s</span></div>` +
        `<div><span class="sync-t sync-t-bed">${this.sec(j && j.contactMs)}</span><span class="sync-tl">Bed s</span></div></div>` +
        `<div class="hd-slot-name">${esc(cfg.name ? splitDeviceName(cfg.name).label : '—')}</div>` +
        `<div class="hd-slot-state">${esc(label)}</div>` +
        `<div class="hd-slot-btns">${btns}</div></div>`;
    }).join('');
  },

  /** Recent gaps as bars out from the middle: right of centre = Right behind. */
  gapBarsHTML(pairs) {
    if (!pairs.length) return '';
    const scale = Math.max(50, ...pairs.map((p) => Math.abs(p.landDiff)));
    return `<div class="sync-axis"><span>◀ Right ahead</span><span>Right behind ▶</span></div><div class="sync-list">` +
      pairs.map((p) => {
        const w = Math.min(50, (Math.abs(p.landDiff) / scale) * 50);
        const dir = p.landDiff > 0 ? 'behind' : 'ahead';
        return `<div class="sync-row"><span class="sync-n">${p.n}</span><div class="sync-track">` +
          `<span class="sync-bar" data-dir="${dir}" style="${dir === 'behind' ? 'left' : 'right'}:50%;width:${w.toFixed(1)}%"></span></div>` +
          `<span class="sync-v">${this.ms(p.landDiff).replace(' ', '&nbsp;')}${p.slip ? ' ⚠' : ''}</span></div>`;
      }).join('') + '</div>';
  },

  slipNote(pairs) {
    const s = pairs.filter((p) => p.slip).pop();
    return s ? `<span class="hd-soon">⚠ The gap jumped by about a bounce at jump ${s.n}: a landing may have been missed. If the numbers look wrong, stop and Resync.</span> ` : '';
  },

  /** The last landing gap, big, and the recent ones as bars. */
  renderNow() {
    const el = document.getElementById('sync-now');
    if (!el || !this.onTab()) return;
    const n = SYNC_SLOTS.filter((s) => this.boardAt(s)).length;
    const pairs = this.run.pairs;
    const last = pairs[pairs.length - 1];
    const recent = pairs.slice(-12);
    let big = `<p class="sync-wait">${n === 2 ? 'Waiting for both jumpers to land…' : 'Connect a sensor on each trampoline above.'}</p>`;
    if (last) {
      const v = this.verdict(last.landDiff);
      const pm = last.err != null ? ` <span class="sync-pm">±${Math.ceil(last.err)} ms</span>` : '';
      big = `<div class="sync-big"${v.dir ? ` data-dir="${v.dir}"` : ''}>` +
        `<span class="sync-num">${this.ms(last.landDiff)}</span>` +
        `<span class="sync-who">${v.text}${pm}</span></div>`;
    }
    // Whoever is ahead on count is waiting for the other's landing.
    const wait = this.queue.L.length - this.queue.R.length;
    const mean = this.meanGap(recent);
    const rough = pairs.some((p) => p.rough);
    el.innerHTML =
      `<div class="hd-head"><div><p class="kicker">Run ${this.run.n} · landing gap · Left leads</p>` +
      `<h2 class="hd-title">How together</h2></div>` +
      `<span class="hd-count${n === 2 ? ' all' : ''}">${n}/2 sensors</span></div>` +
      big + this.gapBarsHTML(recent) +
      `<p class="hd-note">${mean != null ? `Average over the last ${recent.length}: <b>${this.ms(mean)}</b> apart. ` : ''}` +
      `${Math.abs(wait) >= 2 ? `${wait > 0 ? 'Left' : 'Right'} is ${Math.abs(wait)} landings ahead on count. ` : ''}` +
      this.slipNote(recent) +
      `${rough ? '<span class="hd-soon">Rough timing: update the firmware on both sensors for ±ms accuracy.</span>' : ''}</p>`;
  },

  /** Each side's bar chart, like Live's. */
  renderCharts(force = false) {
    if (!this.onTab()) return;
    for (const s of SYNC_SLOTS) {
      const c = this.charts[s];
      if (c) c.setJumps(this.run.jumps[s], { animate: !force });
    }
  },

  /** One row per jump: each side's air and bed time, then the landing gap. */
  pairsTable(pairs) {
    if (!pairs.length) return '<p class="dim">No paired landings yet.</p>';
    const side = (air, bed) => `<span class="sync-air">${this.sec(air)}</span> <span class="dim">${this.sec(bed)}</span>`;
    return `<table class="hd-table sync-table"><thead><tr><th>#</th><th>Left<br><span class="dim">air bed</span></th>` +
      `<th>Right<br><span class="dim">air bed</span></th><th>Landing gap<br><span class="dim">Right vs Left</span></th></tr></thead><tbody>` +
      pairs.slice().reverse().map((p) => {
        const v = this.verdict(p.landDiff);
        return `<tr${p.slip ? ' class="sync-slip"' : ''}><td>${p.n}</td><td data-who="L">${side(p.flightL, p.contactL)}</td><td data-who="R">${side(p.flightR, p.contactR)}</td>` +
          `<td><b>${this.ms(p.landDiff)}</b> <span class="dim">${v.short}</span>${p.slip ? ' <span title="Possible missed landing">⚠</span>' : ''}</td></tr>`;
      }).join('') + '</tbody></table>';
  },

  renderPairs() {
    const el = document.getElementById('sync-pairs');
    if (!el || !this.onTab()) return;
    el.innerHTML = this.pairsTable(this.run.pairs);
  },

  renderSaveBtn() {
    const btn = document.querySelector('#view-sync [data-sync="save"]');
    if (!btn) return;
    btn.textContent = this.saveLabel(this.run);
    btn.disabled = !this.run.pairs.length || (this.run.savedId != null && !this.run.dirty);
  },

  renderRuns() {
    const el = document.getElementById('sync-runs');
    if (!el || !this.onTab()) return;
    el.innerHTML = this.runs.length ? `<h2 class="dbg-h">Earlier runs</h2>` + this.runs.slice().reverse().map((r) => {
      const mean = this.meanGap(r.pairs);
      const saved = r.savedId != null && !r.dirty;
      return `<details class="dbg-card sync-run"><summary><b>Run ${r.n}</b> · ${fmtTime(r.startedAt)} · ` +
        `${r.pairs.length} jump${r.pairs.length === 1 ? '' : 's'}${mean != null ? ` · avg ${this.ms(mean)} apart` : ''}${saved ? ' · saved' : ''}</summary>` +
        this.pairsTable(r.pairs) +
        (r.pairs.length ? `<div class="dbg-row"><button type="button" class="btn-small" data-sync="save-run" data-run="${r.n}"${saved ? ' disabled' : ''}>${this.saveLabel(r)}</button></div>` : '') +
        '</details>';
    }).join('') : '';
  },

  /* ---------- History → Synchro ---------- */
  histOpen: null,             // id of the saved run opened in History

  async historyCount() {
    try { return (await DB.all('syncRuns')).length; } catch (e) { return 0; }
  },

  async renderHistory(root) {
    for (const c of this.histCharts) c.ro.disconnect();
    this.histCharts = [];
    let recs = [];
    try { recs = await DB.all('syncRuns'); } catch (e) { recs = []; }
    recs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (!recs.length) {
      root.innerHTML = '<div class="empty"><strong>No synchro runs yet</strong>On the Synchro tab, press “Save to History” to keep a run here.</div>';
      return;
    }
    const days = [];
    for (const r of recs) {
      const k = dayKey(r.startedAt);
      if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, list: [] });
      days[days.length - 1].list.push(r);
    }
    root.innerHTML = days.map((d) => `<h2 class="section-label">${esc(dayLabel(d.key))}</h2>
      <ul class="list">${d.list.map((r) => this.historyCardHTML(r)).join('')}</ul>`).join('');
    const open = recs.find((r) => r.id === this.histOpen);
    if (open) {
      for (const s of SYNC_SLOTS) {
        const el = root.querySelector(`[data-sh-chart="${s}"]`);
        if (!el) continue;
        const c = new JumpChart(el, { emptyText: '<strong>No jumps</strong>' });
        c.setJumps((open.jumps && open.jumps[s]) || [], { resetView: true });
        this.histCharts.push(c);
      }
    }
  },

  historyCardHTML(r) {
    const mean = this.meanGap(r.pairs);
    const isOpen = r.id === this.histOpen;
    const names = r.names ? `${esc(r.names.L)} <span class="dim">vs</span> ${esc(r.names.R)}` : 'Synchro run';
    const card = `<button type="button" class="card-btn session-card" data-sh-open="${r.id}" aria-expanded="${isOpen}">
      <span class="session-name">${names}</span>
      <span class="chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${isOpen ? 'M5 9l7 7 7-7' : 'M9 5l7 7-7 7'}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="session-meta">${fmtTime(r.startedAt)} · ${r.pairs.length} jump${r.pairs.length === 1 ? '' : 's'}${mean != null ? ` · avg ${this.ms(mean)} apart` : ''}</span>
    </button>`;
    if (!isOpen) return `<li>${card}</li>`;
    return `<li class="sync-hist">${card}
      <div class="chart-card hd-card sync-card">${this.gapBarsHTML(r.pairs)}<p class="hd-note">${this.slipNote(r.pairs)}</p></div>
      ${SYNC_SLOTS.map((s) => `<h3 class="hd-sub">${SYNC_NAME[s]} · ${esc(r.names ? r.names[s] : SYNC_NAME[s])}</h3><div class="chart-card sync-chart" data-sh-chart="${s}"></div>`).join('')}
      <div class="dbg-card">${this.pairsTable(r.pairs)}
        <div class="dbg-row">
          <button type="button" class="btn-small" data-sh-csv="${r.id}">CSV</button>
          <button type="button" class="btn-small btn-outline btn-danger" data-sh-del="${r.id}">Delete</button>
        </div></div></li>`;
  },

  /** History's click handler offers every click here first; true = handled. */
  async historyClick(e) {
    const open = e.target.closest('[data-sh-open]');
    if (open) {
      const id = Number(open.dataset.shOpen);
      this.histOpen = this.histOpen === id ? null : id;
      renderHistory();
      return true;
    }
    const csv = e.target.closest('[data-sh-csv]');
    if (csv) {
      const r = await DB.get('syncRuns', Number(csv.dataset.shCsv));
      if (r) this.exportCsv([{ n: 1, pairs: r.pairs }], r.startedAt);
      return true;
    }
    const del = e.target.closest('[data-sh-del]');
    if (del) {
      const id = Number(del.dataset.shDel);
      if (await confirmDialog('Delete this synchro run?', 'It will be permanently deleted from this device.')) {
        await DB.del('syncRuns', id);
        for (const r of [...this.runs, this.run]) if (r.savedId === id) { r.savedId = null; r.dirty = true; }
        this.histOpen = null;
        renderHistory();
        toast('Synchro run deleted');
      }
      return true;
    }
    return false;
  },

  /* ---------- export ---------- */
  async exportCsv(runs, when = new Date().toISOString()) {
    runs = runs.filter((r) => r.pairs.length);
    if (!runs.length) { toast('Nothing to export'); return; }
    const head = 'run,jump,time,landing_gap_ms,takeoff_gap_ms,right_is,flight_left_ms,flight_right_ms,contact_left_ms,contact_right_ms,error_ms,rough,possible_missed_landing';
    const f = (x, dp = 1) => (Number.isFinite(x) ? x.toFixed(dp) : '');
    const rows = runs.flatMap((r) => r.pairs.map((p) => {
      const v = this.verdict(p.landDiff);
      return [r.n, p.n, p.at, f(p.landDiff), f(p.takeDiff), v.dir || 'together',
        f(p.flightL), f(p.flightR), f(p.contactL), f(p.contactR), f(p.err), p.rough ? 1 : 0, p.slip ? 1 : 0].join(',');
    }));
    const file = new File([[head, ...rows].join('\r\n') + '\r\n'], `${slug(CONFIG.brandName)}-synchro-${slug(when)}.csv`, { type: 'text/csv' });
    if (isMobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Synchro' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  /* ---------- events ---------- */
  wire() {
    const panel = document.getElementById('view-sync');
    if (!panel) return;
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sync]');
      if (!btn) return;
      const s = btn.dataset.s;
      switch (btn.dataset.sync) {
        case 'connect':    this.connectBoard(s); break;
        case 'reconnect':  this.reconnectBoard(s); break;
        case 'disconnect': this.disconnectBoard(this.boards[s]); this.render(); break;
        case 'main':       this.useMain(s); break;
        case 'unmain':     this.cfg(s).name = null; this.save(); this.render(); break;
        case 'resync':     this.resync(); break;
        case 'save':       this.saveRun(this.run); break;
        case 'save-run':   this.saveRun(this.runs.find((r) => r.n === Number(btn.dataset.run))); break;
        case 'clear':      this.clearAll(); break;
        case 'csv':        this.exportCsv([...this.runs, this.run]); break;
      }
    });
  },
};
