'use strict';
/* ==========================================================================
   Synchro — two trampolines side by side, one sensor each: how far apart
   were the two jumpers' landings, to the millisecond?

   How it hangs together:
   - Two slots, Left and Right. Each is either the main sensor (connected the
     usual way with "Connect sensor", so its jumps still feed the Live bars) or
     a board connected from the Synchro panel, which only ever feeds Synchro.
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
   - A landing from each side within matchTolMs of each other is one pair.
   - Resync starts a new run: anything that landed before the button is
     ignored, so the next landing on each side is jump 1 again. For when the
     jumpers drift so far apart that landings pair with the wrong bounce.
     Earlier runs are kept (in memory, until the page is left) for the CSV.

   Its own tab, Synchro. Needs app.js (parsePacket, BLE, CONFIG, S, secs, toast).
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
  matchTolMs: 400,        // landings ~1.5 s apart, so this can't pair neighbouring landings
  waitMs: 4000,           // a landing with no partner by then: the other side missed it
  staleMs: 5000,          // a J this far in the past is a backfill, not a landing just now
  keep: 200,              // pairs kept for the list
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
  open: [],                   // landings still waiting for the other side
  pairs: [],                  // this run's, newest last
  unpaired: { L: 0, R: 0 },
  last: { L: null, R: null }, // each side's latest jump this run
  runs: [],                   // earlier runs: { n, startedAt, pairs, unpaired }
  startedAt: new Date().toISOString(),
  resetAt: 0,                 // phone clock: landings before this belong to the last run
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
    this.wire();
    this.timer = setInterval(() => this.tick(), 100);
    this.render();
  },

  save() {
    try { localStorage.setItem(SYNCC.storageKey, JSON.stringify(this.settings)); } catch (e) { /* private mode */ }
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
    this.expire(now);
  },

  /* ---------- pairing the two sides' landings ---------- */
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
    this.last[s] = { flightMs: j.flightMs, contactMs: j.contactMs };
    this.renderBoardsSoon();
    const m = { slot: s, j, landAt, takeAt: j.timestamp - o.off, err: o.err, rough: o.rough, created: at };

    const other = s === 'L' ? 'R' : 'L';
    let bestI = -1, bestD = Infinity;
    this.open.forEach((x, i) => {
      const d = Math.abs(x.landAt - landAt);
      if (x.slot === other && d <= SYNCC.matchTolMs && d < bestD) { bestI = i; bestD = d; }
    });
    if (bestI < 0) { this.open.push(m); return; }
    const [x] = this.open.splice(bestI, 1);
    this.addPair(s === 'L' ? m : x, s === 'L' ? x : m);
  },

  addPair(L, R) {
    const err = L.err != null && R.err != null ? L.err + R.err : null;
    this.pairs.push({
      n: this.pairs.length ? this.pairs[this.pairs.length - 1].n + 1 : 1,
      at: new Date().toISOString(),
      landDiff: R.landAt - L.landAt,           // + = Right landed later (Left first)
      takeDiff: R.takeAt - L.takeAt,
      flightL: L.j.flightMs, flightR: R.j.flightMs,
      contactL: L.j.contactMs, contactR: R.j.contactMs,
      err, rough: L.rough || R.rough,
    });
    if (this.pairs.length > SYNCC.keep) this.pairs.shift();
    this.renderNow();
    this.renderPairs();
  },

  expire(now) {
    const before = this.open.length;
    this.open = this.open.filter((m) => {
      if (now - m.created < SYNCC.waitMs) return true;
      this.unpaired[m.slot]++;
      return false;
    });
    if (this.open.length !== before) this.renderNow();
  },

  /** Start again from jump 1. The run so far, if it has any jumps, is kept. */
  resync() {
    if (this.pairs.length) {
      this.runs.push({ n: this.runs.length + 1, startedAt: this.startedAt, pairs: this.pairs, unpaired: this.unpaired });
    }
    this.startNewRun();
    toast('Resynced. Start together: the next landing is jump 1.');
  },

  startNewRun() {
    this.pairs = [];
    this.open = [];
    this.unpaired = { L: 0, R: 0 };
    this.last = { L: null, R: null };
    this.startedAt = new Date().toISOString();
    this.resetAt = performance.now();
    this.render();
  },

  async clearAll() {
    if (!this.pairs.length && !this.runs.length) return;
    if (!(await confirmDialog('Clear all synchro jumps?', 'This run and every earlier one are removed. Export the CSV first to keep them.', 'Clear'))) return;
    this.runs = [];
    this.startNewRun();
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
  /** "Left first by 23 ms" for a landing difference (+ = Left first). */
  verdict(d) {
    const a = Math.abs(d);
    if (a < SYNCC.togetherMs) return { who: null, text: 'Together' };
    const who = d > 0 ? 'L' : 'R';
    return { who, text: `${SYNC_NAME[who]} first` };
  },
  ms(d) { return `${Math.round(Math.abs(d))} ms`; },
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
  render() {
    if (!this.ready || typeof S === 'undefined' || S.view !== 'sync') return;
    this.renderBoards();
    this.renderNow();
    this.renderPairs();
    this.renderRuns();
  },

  renderBoardsSoon() {
    if (this.boardsTimer) return;
    this.boardsTimer = setTimeout(() => { this.boardsTimer = null; if (S.view === 'sync') this.renderBoards(); }, 250);
  },

  /** Left and Right: which sensor, its clock, and that jumper's last jump. */
  renderBoards() {
    const el = document.getElementById('sync-boards');
    if (!el || S.view !== 'sync') return;
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
      const j = this.last[s];
      return `<div class="hd-slot sync-slot" data-state="${live ? 'on' : 'off'}" data-who="${s}">` +
        `<div class="hd-slot-head"><span class="hd-slot-num">${s}</span><span class="hd-slot-where">${SYNC_NAME[s]} trampoline</span>` +
        `${isMain ? '<span class="pill pill-demo">Main</span>' : ''}</div>` +
        `<div class="sync-times">` +
        `<div><span class="sync-t">${this.sec(j && j.flightMs)}</span><span class="sync-tl">Air s</span></div>` +
        `<div><span class="sync-t sync-t-bed">${this.sec(j && j.contactMs)}</span><span class="sync-tl">Bed s</span></div></div>` +
        `<div class="hd-slot-name">${esc(cfg.name ? splitDeviceName(cfg.name).label : '—')}</div>` +
        `<div class="hd-slot-state">${esc(label)}</div>` +
        `<div class="hd-slot-btns">${btns}</div></div>`;
    }).join('');
  },

  /** The last landing gap, big, and the recent ones as bars. */
  renderNow() {
    const el = document.getElementById('sync-now');
    if (!el || typeof S === 'undefined' || S.view !== 'sync') return;
    const n = SYNC_SLOTS.filter((s) => this.boardAt(s)).length;
    const last = this.pairs[this.pairs.length - 1];
    const recent = this.pairs.slice(-12);
    let big = `<p class="sync-wait">${n === 2 ? 'Waiting for both jumpers to land…' : 'Connect a sensor on each trampoline above.'}</p>`;
    if (last) {
      const v = this.verdict(last.landDiff);
      const pm = last.err != null ? ` <span class="sync-pm">±${Math.ceil(last.err)} ms</span>` : '';
      big = `<div class="sync-big"${v.who ? ` data-who="${v.who}"` : ''}>` +
        `<span class="sync-num">${this.ms(last.landDiff)}</span>` +
        `<span class="sync-who">${v.text}${pm}</span></div>`;
    }
    // Recent landings as bars out from the middle: left of centre = Left first.
    const scale = Math.max(50, ...recent.map((p) => Math.abs(p.landDiff)));
    const bars = recent.map((p) => {
      const w = Math.min(50, (Math.abs(p.landDiff) / scale) * 50);
      const side = p.landDiff > 0 ? 'L' : 'R';
      return `<div class="sync-row"><span class="sync-n">${p.n}</span><div class="sync-track">` +
        `<span class="sync-bar" data-who="${side}" style="${side === 'L' ? 'right' : 'left'}:50%;width:${w.toFixed(1)}%"></span></div>` +
        `<span class="sync-v">${Math.round(Math.abs(p.landDiff))}</span></div>`;
    }).join('');
    const mean = this.meanGap(recent);
    const rough = this.pairs.some((p) => p.rough);
    const missed = this.unpaired.L + this.unpaired.R;
    el.innerHTML =
      `<div class="hd-head"><div><p class="kicker">Run ${this.runs.length + 1} · landing gap</p>` +
      `<h2 class="hd-title">How together</h2></div>` +
      `<span class="hd-count${n === 2 ? ' all' : ''}">${n}/2 sensors</span></div>` +
      big +
      (recent.length ? `<div class="sync-axis"><span>◀ Left first</span><span>Right first ▶</span></div><div class="sync-list">${bars}</div>` : '') +
      `<p class="hd-note">${mean != null ? `Average over the last ${recent.length}: <b>${Math.round(mean)} ms</b> apart. ` : ''}` +
      `${missed ? `Unmatched landings: left ${this.unpaired.L}, right ${this.unpaired.R}. ` : ''}` +
      `${missed >= 3 ? '<span class="hd-soon">Still climbing? You\'re out of synch: press Resync.</span> ' : ''}` +
      `${rough ? '<span class="hd-soon">Rough timing: update the firmware on both sensors for ±ms accuracy.</span>' : ''}</p>`;
  },

  /** One row per jump: each side's air and bed time, then the landing gap. */
  pairsTable(pairs) {
    if (!pairs.length) return '<p class="dim">No paired landings yet.</p>';
    const side = (air, bed) => `<span class="sync-air">${this.sec(air)}</span> <span class="dim">${this.sec(bed)}</span>`;
    return `<table class="hd-table sync-table"><thead><tr><th>#</th><th>Left<br><span class="dim">air bed</span></th>` +
      `<th>Right<br><span class="dim">air bed</span></th><th>Landing gap</th></tr></thead><tbody>` +
      pairs.slice().reverse().map((p) => {
        const v = this.verdict(p.landDiff);
        return `<tr><td>${p.n}</td><td data-who="L">${side(p.flightL, p.contactL)}</td><td data-who="R">${side(p.flightR, p.contactR)}</td>` +
          `<td><b>${this.ms(p.landDiff)}</b>${v.who ? ` <span class="dim">${v.who}</span>` : ''}</td></tr>`;
      }).join('') + '</tbody></table>';
  },

  renderPairs() {
    const el = document.getElementById('sync-pairs');
    if (!el || typeof S === 'undefined' || S.view !== 'sync') return;
    el.innerHTML = this.pairsTable(this.pairs);
  },

  renderRuns() {
    const el = document.getElementById('sync-runs');
    if (!el) return;
    el.innerHTML = this.runs.length ? `<h2 class="dbg-h">Earlier runs</h2>` + this.runs.slice().reverse().map((r) => {
      const mean = this.meanGap(r.pairs);
      return `<details class="dbg-card sync-run"><summary><b>Run ${r.n}</b> · ${fmtTime(r.startedAt)} · ` +
        `${r.pairs.length} jump${r.pairs.length === 1 ? '' : 's'} · avg ${Math.round(mean)} ms apart</summary>` +
        this.pairsTable(r.pairs) + '</details>';
    }).join('') : '';
  },

  /* ---------- export ---------- */
  async exportCsv() {
    const runs = [...this.runs, { n: this.runs.length + 1, pairs: this.pairs }].filter((r) => r.pairs.length);
    if (!runs.length) { toast('Nothing to export'); return; }
    const head = 'run,jump,time,landing_diff_ms,takeoff_diff_ms,first,flight_left_ms,flight_right_ms,contact_left_ms,contact_right_ms,error_ms,rough';
    const f = (x, dp = 1) => (Number.isFinite(x) ? x.toFixed(dp) : '');
    const rows = runs.flatMap((r) => r.pairs.map((p) => {
      const v = this.verdict(p.landDiff);
      return [r.n, p.n, p.at, f(p.landDiff), f(p.takeDiff), v.who ? SYNC_NAME[v.who].toLowerCase() : 'together',
        f(p.flightL), f(p.flightR), f(p.contactL), f(p.contactR), f(p.err), p.rough ? 1 : 0].join(',');
    }));
    const file = new File([[head, ...rows].join('\r\n') + '\r\n'], `${slug(CONFIG.brandName)}-synchro-${slug(new Date().toISOString())}.csv`, { type: 'text/csv' });
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
        case 'clear':      this.clearAll(); break;
        case 'csv':        this.exportCsv(); break;
      }
    });
  },
};
