'use strict';
/* ==========================================================================
   CONFIG — everything you may need to change lives here.
   Values below are taken from the current firmware (config.h / link.h /
   detector.h). If the firmware changes, update this block and, if the line
   format changes, parsePacket() just below.
   ========================================================================== */
const CONFIG = {
  // Company / product name. Change it here; the page title, wordmark,
  // CSV file names and results card all pick it up. A leading number is
  // drawn in moonlight yellow and a "the" is set small, e.g. 2·the·moon.
  brandName: '2themoon',
  deviceLabel: 'moonlander1',   // fallback name, shown until a sensor tells us its own

  // --- Bluetooth (firmware: config.h, Nordic UART Service layout) ---------
  // Every sensor advertises BLE_NAME_PREFIX "-" LABEL, e.g. "moonlander1-7C3A".
  // The label defaults to the board's MAC tail and can be renamed from the app
  // ("Tramp 1"), which is how a club tells one trampoline's sensor from another.
  deviceNamePrefix: 'moonlander',                                // picker filter; firmware BLE_NAME_PREFIX starts with this
  deviceLabelMax: 12,                                            // BLE_LABEL_MAX in config.h
  serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',           // BLE_SVC_UUID (must be lower-case for Web Bluetooth)
  characteristicUUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',    // BLE_TX_UUID  (notify: text lines)
  commandCharacteristicUUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // BLE_RX_UUID (write: commands, used for backfill)

  // --- Packet types (firmware: link.h) --------------------------------------
  jumpType: 'J',          // J,index,flightMs,contactMs,peakG,timestampMs,flags
  idleType: 'S',          // S,sampleIdx,fromState,toState  — a state change line...
  idleState: 'REST',      // ...whose toState is REST means "trampoline went quiet" = end of turn
  deviceNameType: 'N',    // N,<name>  — the sensor reporting its own advertised BLE name

  // --- Chart ------------------------------------------------------------------
  barsVisible: 12,        // bars that fit across a portrait phone before it scrolls sideways

  // --- Turn / set logic -----------------------------------------------------
  // A SET is one burst of continuous jumping, ended by the firmware's REST line.
  // A TURN is one person's whole go: usually several sets with a rest between
  // them. Only the "Next jumper" button ends a turn — nothing is split on time.
  idleGraceMs: 0,         // wait this long after idle before closing the set (0 = close at once).
                          // A jump arriving during the grace period cancels it.
  setGapMs: 20000,        // safety net: if two jumps are this far apart by the sensor clock, the
                          // idle message was missed (e.g. while disconnected), so start a new set. 0 = off.
  newSessionAfterMs: 3 * 60 * 60 * 1000, // on connect, start a fresh training session if the current
                                         // one has had no activity for this long

  // --- Connection -----------------------------------------------------------
  reconnectAttempts: 5,                  // automatic reconnect tries after an unexpected disconnect
  backfillWindowMs: 10 * 60 * 1000,      // after (re)connecting, ask the sensor to resend jumps we
                                         // missed ("b N" command) if our last jump is this recent

  // --- Flags (firmware: detector.h JumpFlags). Shown next to the raw value. --
  flagLabels: {
    1: 'Standing start (bed time is the dip)',
    2: 'Hit sensor limit (peak G is a minimum)',
    4: 'Data gap just before this jump',
  },

  // --- Storage --------------------------------------------------------------
  dbName: 'trampoline-sensor-v1',
  dbVersion: 2,
};

/* ==========================================================================
   parsePacket(line) — the ONLY place that knows the wire format.
   Input: one text line (without the trailing newline).
   Returns one of:
     { kind: 'jump', type, index, flightMs, contactMs, peakG, timestamp, flags }
     { kind: 'idle', type }
     { kind: 'name', type, name }   // the sensor's advertised BLE name
     { kind: 'ignore', type }       // valid line we don't use (C, X, E, R, #, other S)
     null                           // could not parse — caller logs and drops it
   ========================================================================== */
function parsePacket(line) {
  const text = String(line).trim();
  if (!text) return { kind: 'ignore', type: '' };
  if (text.startsWith('#')) return { kind: 'ignore', type: '#' };   // firmware info/comment lines

  const f = text.split(',').map((s) => s.trim());
  const type = f[0];

  if (type === CONFIG.jumpType) {
    if (f.length !== 7) return null;
    const num = (s) => (s === '' ? NaN : Number(s));
    const index = num(f[1]), flightMs = num(f[2]), contactMs = num(f[3]);
    const peakG = num(f[4]), timestamp = num(f[5]), flags = num(f[6]);
    if (![index, flightMs, contactMs, peakG, timestamp, flags].every(Number.isFinite)) return null;
    if (flightMs < 0 || contactMs < 0 || flightMs > 60000 || contactMs > 60000) return null;
    return { kind: 'jump', type, index, flightMs, contactMs, peakG, timestamp, flags };
  }

  if (type === CONFIG.idleType) {
    if (f.length < 4) return null;
    return f[3] === CONFIG.idleState ? { kind: 'idle', type } : { kind: 'ignore', type };
  }

  if (type === CONFIG.deviceNameType) {
    const name = (f[1] || '').slice(0, 40);
    return name ? { kind: 'name', type, name } : null;
  }

  if (/^[A-Z]$/.test(type)) return { kind: 'ignore', type };   // other firmware line types
  return null;
}

/* ==========================================================================
   Small helpers
   ========================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secs = (ms) => (ms / 1000).toFixed(2);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const isMobile = () => (navigator.userAgentData ? navigator.userAgentData.mobile : /Android|Mobi/i.test(navigator.userAgent));

function flagText(flags) {
  if (!flags) return '';
  const parts = [];
  for (const [bit, label] of Object.entries(CONFIG.flagLabels)) if (flags & Number(bit)) parts.push(label);
  return parts.join('; ');
}

const LOGO_SVG = '<svg class="wm-logo" viewBox="0 0 40 36" aria-hidden="true"><defs> <radialGradient id="tmMoon" cx="40%" cy="36%" r="70%"><stop offset="0" stop-color="#F4F4F1"/><stop offset=".55" stop-color="#CDCDC8"/><stop offset="1" stop-color="#8F8F8B"/></radialGradient> </defs> <path d="M1.5 33.5 h11" stroke="#5CB8FF" stroke-width="2.4" stroke-linecap="round"/> <path d="M3 33.5 l-1 2.2 M11 33.5 l1 2.2" stroke="#5CB8FF" stroke-width="1.6" stroke-linecap="round"/> <path d="M7 31 Q9 15 19.5 13.5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-dasharray="0.1 3.2"/> <circle cx="29" cy="11" r="9.2" fill="url(#tmMoon)"/> <g fill="#6F6F6C" opacity=".45"> <path d="M24.5 6.5 c2-1.6 5-1.2 5.6.6 .5 1.6-1.4 2.4-2.8 3.2 -1.2.7-2.9 1.2-3.6.1 -.6-1.1-.2-2.9.8-3.9z"/> <path d="M30.5 11.5 c1.8-.8 4-.2 4.3 1.3 .3 1.7-1.5 2.3-2.9 3 -1.3.6-2.6.2-2.8-.9 -.2-1.3.3-2.8 1.4-3.4z"/> <ellipse cx="26" cy="14" rx="1.6" ry="1.1"/> </g> <g fill="none" stroke="#9A9A96" stroke-width=".45" opacity=".9"> <circle cx="33" cy="6.5" r="1"/><circle cx="25.5" cy="17" r=".8"/><circle cx="31" cy="17.5" r="1.2"/> </g> <circle cx="30.2" cy="18" r=".4" fill="#fff" opacity=".6"/> <path d="M8 4 l.9 2.2 2.2 .9 -2.2 .9 -.9 2.2 -.9 -2.2 -2.2 -.9 2.2 -.9z" fill="#fff"/> <circle cx="37.5" cy="30" r=".8" fill="#fff"/></svg>';
function wordmarkHTML() {
  const m = CONFIG.brandName.match(/^(\d*)(the)?(.*)$/i);
  const parts = `${m[1] ? `<span class="wm-num">${esc(m[1])}</span>` : ''}${m[2] ? `<span class="wm-the">${esc(m[2])}</span>` : ''}${esc(m[3])}`;
  return `${LOGO_SVG}<span class="wm-text" aria-label="${esc(CONFIG.brandName)}">${parts}</span>`;
}

function turnLabel(t) { return t.jumper || 'Unnamed turn'; }

/* ---------- The sensor's own name ----------
   Sensors are identical apart from this name, so it is what a club goes by.
   The fixed prefix before the first "-" is the product name; the rest is the
   editable label. Until a sensor introduces itself we fall back to CONFIG. */
const deviceName = () => S.deviceName || CONFIG.deviceLabel;
function splitDeviceName(name) {
  const cut = name.indexOf('-');
  return cut < 0 ? { prefix: '', label: name } : { prefix: name.slice(0, cut + 1), label: name.slice(cut + 1) };
}
function renderDeviceName() { $$('[data-device]').forEach((el) => { el.textContent = deviceName(); }); }

function computeStats(jumps) {
  const n = jumps.length;
  let tof = 0, best = 0, bed = 0, peak = 0;
  for (const j of jumps) {
    tof += j.flightMs; bed += j.contactMs;
    if (j.flightMs > best) best = j.flightMs;
    if (j.peakG > peak) peak = j.peakG;
  }
  return { n, tof, best, avgAir: n ? tof / n : 0, avgBed: n ? bed / n : 0, peak };
}

function statsHTML(jumps) {
  const s = computeStats(jumps);
  const dash = '–';
  const v = (ms) => (s.n ? `${secs(ms)}<small>s</small>` : dash);
  return `
    <div class="stat"><span class="stat-label">Jumps</span><span class="stat-value">${s.n}</span></div>
    <div class="stat hero"><span class="stat-label">Time of flight</span><span class="stat-value">${v(s.tof)}</span></div>
    <div class="stat air"><span class="stat-label">Best air</span><span class="stat-value">${v(s.best)}</span></div>
    <div class="stat air"><span class="stat-label">Avg air</span><span class="stat-value">${v(s.avgAir)}</span></div>
    <div class="stat bed"><span class="stat-label">Avg bed</span><span class="stat-value">${v(s.avgBed)}</span></div>
    <div class="stat"><span class="stat-label">Peak G</span><span class="stat-value">${s.n ? s.peak.toFixed(1) + '<small>g</small>' : dash}</span></div>`;
}

/* ==========================================================================
   Storage (IndexedDB). Stores: sessions, turns, sets, jumps, meta (key/value).
   A session holds turns (one person's go), a turn holds sets (one burst of
   continuous jumping), and a set holds jumps.
   ========================================================================== */
/** v1 kept one flat "turn" per burst of jumping. The model is now
    session -> turn -> set -> jump, so every old turn becomes a turn holding a
    single set with the same jumps in it. Nothing recorded under v1 is lost.
    This runs inside the versionchange transaction, so it is all callbacks:
    the transaction stays alive only while a request of its own is pending. */
function migrateV1ToV2(db, tx) {
  const sets = db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
  sets.createIndex('sessionId', 'sessionId');
  sets.createIndex('turnId', 'turnId');
  // Anything a half-finished v1 upgrade left out, so the app can always open.
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  if (!db.objectStoreNames.contains('sessions')) {
    db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true }).createIndex('createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains('turns')) {
    db.createObjectStore('turns', { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
  }
  if (!db.objectStoreNames.contains('jumps')) {
    const fresh = db.createObjectStore('jumps', { keyPath: 'id', autoIncrement: true });
    fresh.createIndex('setId', 'setId');
    fresh.createIndex('sessionId', 'sessionId');
    return;                       // empty store: nothing to carry over
  }
  const jumps = tx.objectStore('jumps');
  if (!jumps.indexNames.contains('sessionId')) jumps.createIndex('sessionId', 'sessionId');
  if (!jumps.indexNames.contains('setId')) jumps.createIndex('setId', 'setId');
  if (jumps.indexNames.contains('turnId')) jumps.deleteIndex('turnId');

  // One set per old turn, remembering which set each turn's jumps belong to.
  const setIdOfTurn = new Map();
  tx.objectStore('turns').openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (cur) {
      const t = cur.value;
      const add = sets.add({
        sessionId: t.sessionId, turnId: t.id, number: 1,
        startedAt: t.startedAt, endedAt: t.endedAt || null, demo: !!t.demo,
      });
      add.onsuccess = () => { setIdOfTurn.set(t.id, add.result); cur.continue(); };
      return;
    }
    // Then point every jump at its new set. A jump whose turn is gone is dropped.
    jumps.openCursor().onsuccess = (je) => {
      const jc = je.target.result;
      if (!jc) return;
      const j = jc.value;
      const setId = setIdOfTurn.get(j.turnId);
      if (setId == null) { jc.delete(); jc.continue(); return; }
      j.setId = setId;
      delete j.turnId;
      jc.update(j).onsuccess = () => jc.continue();
    };
  };
}

const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        const tx = req.transaction;   // the versionchange transaction: old data can be read and rewritten here
        // Migrations: add a new `if (e.oldVersion < N)` block for each schema version.
        if (e.oldVersion < 1) {
          // Nothing on this device yet: create the stores as they are today.
          db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true }).createIndex('createdAt', 'createdAt');
          db.createObjectStore('turns', { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
          const st = db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
          st.createIndex('sessionId', 'sessionId');
          st.createIndex('turnId', 'turnId');
          const j = db.createObjectStore('jumps', { keyPath: 'id', autoIncrement: true });
          j.createIndex('setId', 'setId');
          j.createIndex('sessionId', 'sessionId');
          db.createObjectStore('meta');
        } else if (e.oldVersion < 2) {
          migrateV1ToV2(db, tx);
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database blocked by another open tab'));
    });
  },
  _req(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      let result;
      const r = fn(tx.objectStore(store));
      if (r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  put(store, value, key) { return this._req(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))); },
  get(store, key) { return this._req(store, 'readonly', (s) => s.get(key)); },
  del(store, key) { return this._req(store, 'readwrite', (s) => s.delete(key)); },
  all(store) { return this._req(store, 'readonly', (s) => s.getAll()); },
  byIndex(store, index, key) { return this._req(store, 'readonly', (s) => s.index(index).getAll(key)); },
  delByIndex(store, index, key) {
    return this._req(store, 'readwrite', (s) => {
      const c = s.index(index).openKeyCursor(IDBKeyRange.only(key));
      c.onsuccess = () => { const cur = c.result; if (cur) { s.delete(cur.primaryKey); cur.continue(); } };
      return null;
    });
  },
  meta(key) { return this.get('meta', key); },
  setMeta(key, value) { return this.put('meta', value, key); },
};

/* ==========================================================================
   App state
   ========================================================================== */
const S = {
  session: null,          // current training session record
  turns: [],              // turns of the current session (ordered)
  sets: [],               // sets of the current session (ordered by turn, then set number)
  jumps: new Map(),       // setId -> jumps[] for the current session
  openTurn: null,         // the person who is up right now (ends on "Next jumper")
  openSet: null,          // the burst being jumped right now (ends when the trampoline is quiet)
  lastJump: null,         // most recent jump in the current session
  deviceName: null,       // BLE name of the sensor we last talked to, e.g. "moonlander1-Tramp 1"
  seen: new Set(),        // "index:timestamp" keys, to drop duplicates after backfill
  jumpers: [],            // [{name, lastUsed}] remembered across sessions
  view: 'live',
  viewSessionId: null,    // session shown on the Session screen (null = current)
  nameSheet: null,        // { mode: 'next' | 'current', summary } while the name sheet is up
  overlay: null,          // { kind: 'turn' | 'set', id } while the detail screen is up
  historyOpen: false,     // is the "Previous sessions" group expanded?
  demo: null,
};
let idleTimer = null;
let queue = Promise.resolve();
/** All packet handling runs through this queue so storage writes stay in order. */
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error('[app] packet handling failed', e));
  return queue;
}

/* ==========================================================================
   Sessions -> turns (one person's go) -> sets (one burst) -> jumps
   ========================================================================== */
function defaultSessionName(date, demo) {
  const d = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const t = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${demo ? 'Demo' : 'Training'} · ${d} ${t}`;
}

async function createSession({ demo = false } = {}) {
  await closeTurn();
  const now = new Date();
  const s = { name: defaultSessionName(now, demo), createdAt: now.toISOString(), demo };
  s.id = await DB.put('sessions', s);
  await setCurrentSession(s.id);
  return s;
}

async function setCurrentSession(id) {
  await DB.setMeta('currentSessionId', id ?? null);
  await loadCurrentSession(id);
}

async function loadCurrentSession(id) {
  S.session = null; S.turns = []; S.sets = []; S.jumps = new Map();
  S.openTurn = null; S.openSet = null; S.lastJump = null; S.seen = new Set();
  if (id == null) return;
  const session = await DB.get('sessions', id);
  if (!session) { await DB.setMeta('currentSessionId', null); return; }
  const { turns, sets, jumps } = await loadSessionData(id);
  S.session = session;
  S.turns = turns;
  S.sets = sets;
  S.jumps = jumps;
  for (const list of jumps.values()) for (const j of list) S.seen.add(`${j.index}:${j.timestamp}`);
  // A turn stays open until someone taps "Next jumper", so it is simply the one
  // with no end time; the same goes for the set inside it.
  S.openTurn = turns.find((t) => !t.endedAt) || null;
  S.openSet = S.openTurn ? sets.find((s) => s.turnId === S.openTurn.id && !s.endedAt) || null : null;
  let lastJump = null;
  for (const list of jumps.values()) for (const j of list) if (!lastJump || j.id > lastJump.id) lastJump = j;
  S.lastJump = lastJump;
}

const byNumber = (a, b) => a.number - b.number || a.id - b.id;

async function loadSessionData(sessionId) {
  const turns = (await DB.byIndex('turns', 'sessionId', sessionId)).sort(byNumber);
  const turnOrder = new Map(turns.map((t, i) => [t.id, i]));
  const sets = (await DB.byIndex('sets', 'sessionId', sessionId))
    .sort((a, b) => (turnOrder.get(a.turnId) ?? 0) - (turnOrder.get(b.turnId) ?? 0) || byNumber(a, b));
  const all = await DB.byIndex('jumps', 'sessionId', sessionId);
  const jumps = new Map(sets.map((s) => [s.id, []]));
  for (const j of all.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id))) {
    if (!jumps.has(j.setId)) jumps.set(j.setId, []);
    jumps.get(j.setId).push(j);
  }
  return { turns, sets, jumps };
}

function sessionLastActivity() {
  if (!S.session) return 0;
  return new Date(S.lastJump ? S.lastJump.receivedAt : S.session.createdAt).getTime();
}

/** Make sure there is a suitable current session for incoming data. */
async function ensureSession({ demo }) {
  const stale = S.session && Date.now() - sessionLastActivity() > CONFIG.newSessionAfterMs;
  if (!S.session || !!S.session.demo !== demo || stale) await createSession({ demo });
}

/* --- Turns and sets ------------------------------------------------------
   A set opens on the first jump and closes when the trampoline goes quiet.
   A turn collects every set one person did; only the "Next jumper" button (or
   a new session) ends it, so nothing is ever split on a timer. */

function setsOfTurn(turnId, sets = S.sets) { return sets.filter((s) => s.turnId === turnId); }
function jumpsOfSet(setId, jumps = S.jumps) { return jumps.get(setId) || []; }
function jumpsOfTurn(turnId, sets = S.sets, jumps = S.jumps) {
  return setsOfTurn(turnId, sets).flatMap((s) => jumpsOfSet(s.id, jumps));
}
/** Time actually spent jumping — the rests between sets are left out. */
function jumpingMs(jumps) { return jumps.reduce((a, j) => a + j.flightMs + j.contactMs, 0); }

async function openTurn({ jumper = null } = {}) {
  const number = S.turns.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  const t = { sessionId: S.session.id, number, jumper, startedAt: new Date().toISOString(), endedAt: null, demo: !!S.session.demo };
  t.id = await DB.put('turns', t);
  S.turns.push(t);
  S.openTurn = t;
  if (jumper) await rememberJumper(jumper);
  return t;
}

async function openSet() {
  if (!S.openTurn) await openTurn();
  const turn = S.openTurn;
  const number = setsOfTurn(turn.id).reduce((m, s) => Math.max(m, s.number), 0) + 1;
  const st = { sessionId: S.session.id, turnId: turn.id, number, startedAt: new Date().toISOString(), endedAt: null, demo: !!S.session.demo };
  st.id = await DB.put('sets', st);
  S.sets.push(st);
  S.jumps.set(st.id, []);
  S.openSet = st;
  return st;
}

async function handleJump(p) {
  const demo = !!S.demo;
  if (!S.session || !!S.session.demo !== demo) await ensureSession({ demo });
  const key = `${p.index}:${p.timestamp}`;
  if (S.seen.has(key)) { console.info('[sensor] duplicate jump ignored', key); return; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

  // Safety net for a missed idle message (e.g. it happened while disconnected).
  // This only ever starts a new SET — the jumper is assumed to be the same one.
  const prev = S.lastJump;
  if (S.openSet && prev && prev.setId === S.openSet.id && CONFIG.setGapMs > 0 &&
      p.timestamp > prev.timestamp && p.timestamp - prev.timestamp > CONFIG.setGapMs) {
    console.info('[app] long gap between jumps, starting a new set');
    await closeSet();
  }
  if (!S.openSet) await openSet();

  const set = S.openSet;
  const list = S.jumps.get(set.id);
  const now = new Date();
  const jump = {
    sessionId: S.session.id, setId: set.id,
    type: p.type, index: p.index, flightMs: p.flightMs, contactMs: p.contactMs, peakG: p.peakG,
    timestamp: p.timestamp, flags: p.flags,
    receivedAt: now.toISOString(), demo: !!S.session.demo,
  };
  // Backfilled jumps can arrive after newer live ones: keep sensor order within the set.
  let pos = list.length;
  while (pos > 0 && list[pos - 1].index > p.index && list[pos - 1].timestamp > p.timestamp) pos--;
  if (pos === list.length) jump.order = Math.max(Date.now() * 1000, (list[pos - 1]?.order ?? 0) + 1);
  else if (pos === 0) jump.order = list[0].order - 1;
  else jump.order = (list[pos - 1].order + list[pos].order) / 2;
  jump.id = await DB.put('jumps', jump);     // saved the moment it arrives
  list.splice(pos, 0, jump);
  S.seen.add(key);
  if (!S.lastJump || pos === list.length - 1) S.lastJump = jump;
  renderAfterData({ newJump: true });
}

function handleIdle() {
  if (!S.openSet) return;
  if (CONFIG.idleGraceMs > 0) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; enqueue(() => closeSet()); }, CONFIG.idleGraceMs);
  } else {
    return closeSet();
  }
}

/** End the current burst. A set nobody jumped in isn't worth keeping. */
async function closeSet() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const st = S.openSet;
  if (!st) return;
  S.openSet = null;
  const list = S.jumps.get(st.id) || [];
  if (!list.length) {
    await DB.del('sets', st.id);
    S.sets = S.sets.filter((x) => x.id !== st.id);
    S.jumps.delete(st.id);
  } else {
    st.endedAt = new Date().toISOString();
    await DB.put('sets', st);
  }
  renderAfterData({});
  return st;
}

/** End the person's go. Returns the turn, or null if nothing was recorded in it. */
async function closeTurn() {
  await closeSet();
  const t = S.openTurn;
  if (!t) return null;
  S.openTurn = null;
  if (!setsOfTurn(t.id).length) {      // named but never jumped — don't leave an empty turn behind
    await DB.del('turns', t.id);
    S.turns = S.turns.filter((x) => x.id !== t.id);
    renderAfterData({});
    return null;
  }
  t.endedAt = new Date().toISOString();
  await DB.put('turns', t);
  renderAfterData({});
  return t;
}

async function nameTurn(turnId, name) {
  const t = await findTurn(turnId);
  if (!t) return;
  t.jumper = name ? name.trim().slice(0, 40) : null;
  await DB.put('turns', t);
  if (t.jumper) await rememberJumper(t.jumper);
  const local = S.turns.find((x) => x.id === turnId);
  if (local) local.jumper = t.jumper;
  renderAfterData({});
}

async function findTurn(turnId) {
  return S.turns.find((x) => x.id === turnId) || (await DB.get('turns', turnId));
}

async function rememberJumper(name) {
  const key = name.toLocaleLowerCase();
  S.jumpers = S.jumpers.filter((j) => j.name.toLocaleLowerCase() !== key);
  S.jumpers.unshift({ name, lastUsed: new Date().toISOString() });
  S.jumpers = S.jumpers.slice(0, 30);
  await DB.setMeta('jumpers', S.jumpers);
}

/** Renumber a session's turns and their sets 1..n, dropping any turn left with no sets. */
async function normaliseSession(sessionId) {
  const turns = (await DB.byIndex('turns', 'sessionId', sessionId)).sort(byNumber);
  const sets = await DB.byIndex('sets', 'sessionId', sessionId);
  let n = 0;
  for (const t of turns) {
    const own = sets.filter((s) => s.turnId === t.id).sort(byNumber);
    if (!own.length && !(S.openTurn && S.openTurn.id === t.id)) { await DB.del('turns', t.id); continue; }
    n += 1;
    if (t.number !== n) { t.number = n; await DB.put('turns', t); }
    for (let i = 0; i < own.length; i++) {
      if (own[i].number !== i + 1) { own[i].number = i + 1; await DB.put('sets', own[i]); }
    }
  }
}

async function reloadIfCurrent(sessionId) {
  if (S.session && S.session.id === sessionId) await loadCurrentSession(sessionId);
}

async function deleteSet(setId) {
  const st = S.sets.find((x) => x.id === setId) || (await DB.get('sets', setId));
  if (!st) return;
  if (S.openSet && S.openSet.id === setId) S.openSet = null;
  await DB.delByIndex('jumps', 'setId', setId);
  await DB.del('sets', setId);
  await normaliseSession(st.sessionId);
  await reloadIfCurrent(st.sessionId);
  renderAfterData({});
}

async function deleteTurn(turnId) {
  const t = await findTurn(turnId);
  if (!t) return;
  if (S.openTurn && S.openTurn.id === turnId) { S.openTurn = null; S.openSet = null; }
  for (const st of await DB.byIndex('sets', 'turnId', turnId)) {
    await DB.delByIndex('jumps', 'setId', st.id);
    await DB.del('sets', st.id);
  }
  await DB.del('turns', turnId);
  await normaliseSession(t.sessionId);
  await reloadIfCurrent(t.sessionId);
  renderAfterData({});
}

/** This set and everything after it become a new turn — the fix for a missed "Next jumper" tap. */
async function splitTurnAtSet(setId) {
  const st = S.sets.find((x) => x.id === setId) || (await DB.get('sets', setId));
  if (!st) return null;
  const turn = await DB.get('turns', st.turnId);
  if (!turn) return null;
  const own = (await DB.byIndex('sets', 'turnId', turn.id)).sort(byNumber);
  const i = own.findIndex((x) => x.id === setId);
  if (i <= 0) return null;               // already the first set of its turn
  const moving = own.slice(i);
  const nt = {
    sessionId: turn.sessionId, number: turn.number + 0.5, jumper: null,
    startedAt: moving[0].startedAt, endedAt: turn.endedAt, demo: turn.demo,
  };
  nt.id = await DB.put('turns', nt);
  turn.endedAt = own[i - 1].endedAt || turn.endedAt;   // the old turn now ends with its last remaining set
  await DB.put('turns', turn);
  for (let k = 0; k < moving.length; k++) {
    moving[k].turnId = nt.id;
    moving[k].number = k + 1;
    await DB.put('sets', moving[k]);
  }
  if (S.openTurn && S.openTurn.id === turn.id) S.openTurn = null;   // the reload below works out which turn is open
  await normaliseSession(turn.sessionId);
  await reloadIfCurrent(turn.sessionId);
  renderAfterData({});
  return nt.id;
}

/** Fold a turn's sets into the turn above it, for when one person was split in two. */
async function mergeTurnIntoPrevious(turnId) {
  const turn = await DB.get('turns', turnId);
  if (!turn) return null;
  const turns = (await DB.byIndex('turns', 'sessionId', turn.sessionId)).sort(byNumber);
  const i = turns.findIndex((t) => t.id === turnId);
  if (i <= 0) return null;               // nothing above it
  const prev = turns[i - 1];
  let n = (await DB.byIndex('sets', 'turnId', prev.id)).length;
  for (const s of (await DB.byIndex('sets', 'turnId', turnId)).sort(byNumber)) {
    s.turnId = prev.id;
    s.number = ++n;
    await DB.put('sets', s);
  }
  prev.endedAt = turn.endedAt;
  if (!prev.jumper && turn.jumper) prev.jumper = turn.jumper;
  await DB.put('turns', prev);
  await DB.del('turns', turnId);
  if (S.openTurn && S.openTurn.id === turnId) S.openTurn = null;
  await normaliseSession(turn.sessionId);
  await reloadIfCurrent(turn.sessionId);
  renderAfterData({});
  return prev.id;
}

async function deleteSession(sessionId) {
  await DB.delByIndex('jumps', 'sessionId', sessionId);
  await DB.delByIndex('sets', 'sessionId', sessionId);
  await DB.delByIndex('turns', 'sessionId', sessionId);
  await DB.del('sessions', sessionId);
  if (S.session && S.session.id === sessionId) {
    if (S.demo) stopDemo({ restore: false });
    await setCurrentSession(null);
    S.nameSheet = null;
  }
  if ((await DB.meta('lastRealSessionId')) === sessionId) await DB.setMeta('lastRealSessionId', null);
  renderAfterData({});
}

async function renameSession(sessionId, name) {
  const s = await DB.get('sessions', sessionId);
  if (!s) return;
  s.name = name.trim().slice(0, 60) || s.name;
  await DB.put('sessions', s);
  if (S.session && S.session.id === sessionId) S.session.name = s.name;
  renderAfterData({});
}

/* ==========================================================================
   Incoming text → lines → parsePacket → handlers.
   Bluetooth notifications and demo mode both call feedText().
   BLE notifies are a byte stream: a line may be split across packets.
   ========================================================================== */
let lineBuf = '';
function resetLineBuffer() { lineBuf = ''; }
function feedText(text) {
  lineBuf += text;
  let i;
  while ((i = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, i).replace(/\r$/, '');
    lineBuf = lineBuf.slice(i + 1);
    ingestLine(line);
  }
  if (lineBuf.length > 1024) { console.warn('[sensor] discarding over-long partial line'); lineBuf = ''; }
}
function ingestLine(line) {
  let p = null;
  try { p = parsePacket(line); } catch (e) { p = null; }
  if (!p) { console.warn('[sensor] ignored packet that failed to parse:', JSON.stringify(line)); return; }
  if (p.kind === 'jump') enqueue(() => handleJump(p));
  else if (p.kind === 'idle') enqueue(() => handleIdle());
  else if (p.kind === 'name') handleDeviceName(p.name);
}

/** The sensor states its name on connect and after a rename. Demo names are
    never remembered, so stopping the demo brings the real sensor's name back. */
function handleDeviceName(name) {
  if (S.deviceName === name) return;
  S.deviceName = name;
  if (!S.demo) DB.setMeta('lastDeviceName', name);
  renderDeviceName();
  renderConnection();
}

/* ==========================================================================
   Screen Wake Lock — keep the screen on while connected / in demo.
   ========================================================================== */
const Wake = {
  sentinel: null, wanted: false,
  async enable() { this.wanted = true; await this.acquire(); },
  async acquire() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => { this.sentinel = null; });
    } catch (e) { console.info('[wake] not available:', e.message); }
  },
  disable() { this.wanted = false; if (this.sentinel) this.sentinel.release().catch(() => {}); this.sentinel = null; },
};
document.addEventListener('visibilitychange', () => { if (Wake.wanted && document.visibilityState === 'visible') Wake.acquire(); });

/* ==========================================================================
   Bluetooth
   ========================================================================== */
const BLE = {
  device: null, tx: null, rx: null,
  state: 'idle',           // idle | connecting | connected | reconnecting | lost
  userDisconnect: false,
  reconnecting: false,
  decoder: null,

  supported() { return !!(navigator.bluetooth && window.isSecureContext); },

  async connect() {
    if (!this.supported()) return;
    if (S.demo) { toast('Stop the demo first to connect the real sensor.'); return; }
    const svc = CONFIG.serviceUUID.toLowerCase();
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: CONFIG.deviceNamePrefix }, { services: [svc] }],
        optionalServices: [svc],
      });
    } catch (e) {
      if (e.name !== 'NotFoundError') { console.warn('[ble] requestDevice', e); toast("Couldn't open the sensor list. Is Bluetooth switched on?"); }
      return;   // NotFoundError = user closed the picker
    }
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.userDisconnect = false;
    this.setState('connecting');
    try {
      await this.setup();
    } catch (e) {
      console.warn('[ble] connect failed', e);
      this.setState('lost', "Couldn't connect to the sensor. Make sure it's switched on and nearby.");
    }
  },

  async setup() {
    const svc = CONFIG.serviceUUID.toLowerCase();
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(svc);
    const tx = await service.getCharacteristic(CONFIG.characteristicUUID.toLowerCase());
    let rx = null;
    try { rx = await service.getCharacteristic(CONFIG.commandCharacteristicUUID.toLowerCase()); } catch { rx = null; }
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this.onValue);
    this.tx = tx; this.rx = rx;
    this.decoder = new TextDecoder();
    resetLineBuffer();
    tx.addEventListener('characteristicvaluechanged', this.onValue);
    await tx.startNotifications();
    await enqueue(() => ensureSession({ demo: false }));
    this.setState('connected');
    Wake.enable();
    if (this.device.name) handleDeviceName(this.device.name);   // the sensor's N line confirms it
    await this.requestBackfill();
  },

  /** Ask the sensor to resend jumps we may have missed while disconnected. */
  async requestBackfill() {
    const last = S.lastJump;
    if (!this.rx || !last || last.demo) return;
    if (Date.now() - new Date(last.receivedAt).getTime() > CONFIG.backfillWindowMs) return;
    try {
      await this.rx.writeValue(new TextEncoder().encode(`b ${last.index + 1}\n`));
      console.info('[ble] requested backfill from jump', last.index + 1);
    } catch (e) { console.info('[ble] backfill request failed', e.message); }
  },

  /** Rename the sensor. It saves the label in NVS, applies it without rebooting
      (a reboot would reset the jump index a session is backfilling from) and
      replies with an N line, which is what actually updates the app. */
  async setLabel(label) {
    if (!this.rx) throw new Error('this sensor has no command channel');
    await this.rx.writeValue(new TextEncoder().encode(`n ${label}\n`));
  },

  onValue: (e) => {
    const text = BLE.decoder.decode(e.target.value, { stream: true });
    feedText(text);
  },

  onDisconnected: () => {
    if (BLE.userDisconnect) { BLE.setState('idle'); Wake.disable(); return; }
    BLE.autoReconnect();
  },

  async autoReconnect() {
    if (this.reconnecting || !this.device) return;
    this.reconnecting = true;
    for (let attempt = 1; attempt <= CONFIG.reconnectAttempts; attempt++) {
      this.setState('reconnecting', `Sensor disconnected. Reconnecting… (try ${attempt} of ${CONFIG.reconnectAttempts}). Your jumps are saved.`);
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      if (this.userDisconnect) break;
      try {
        await this.setup();
        this.reconnecting = false;
        toast(`${deviceName()} reconnected`);
        return;
      } catch (e) { console.info('[ble] reconnect attempt failed', e.message); }
    }
    this.reconnecting = false;
    if (!this.userDisconnect) this.setState('lost', 'Sensor disconnected. Your jumps are saved — tap Reconnect when the sensor is back in range.');
  },

  async manualReconnect() {
    if (!this.device) return this.connect();
    this.userDisconnect = false;
    this.setState('connecting');
    try { await this.setup(); toast(`${deviceName()} reconnected`); }
    catch (e) { console.warn('[ble] manual reconnect failed', e); this.setState('lost', "Still can't reach the sensor. Check it's switched on, then try again."); }
  },

  disconnect() {
    this.userDisconnect = true;
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else { this.setState('idle'); Wake.disable(); }
  },

  setState(state, message, soft = false) {
    this.state = state;
    this.message = message || '';
    if (S.view === 'session') renderSession();
    this.soft = soft;   // soft = friendly info banner rather than a red alert
    renderConnection();
  },
};

/* ==========================================================================
   Demo mode — realistic simulated firmware output, fed through feedText()
   exactly like Bluetooth notifications (including split lines).
   Speed up for testing with ?demospeed=10 in the URL.
   ========================================================================== */
class DemoSensor {
  constructor(speed = 1) {
    this.speed = speed; this.running = false; this.index = 0; this.sample = 0;
    this.clock = 30000 + Math.floor(Math.random() * 90000);   // "ms since boot"
    this.names = ['Ben', 'Amy', 'Sam', 'Mia', 'Joe', 'Ava'];
    this.lastName = null;                                     // so the same person never goes twice in a row
    this.target = 1.25;                                       // this jumper's typical air time (s)
  }
  rand(a, b) { return a + Math.random() * (b - a); }
  wait(ms) { return new Promise((r) => { this.timer = setTimeout(r, ms / this.speed); }); }
  emit(line) {
    // Split into 20-byte chunks like a default-MTU BLE link, to exercise reassembly.
    const text = line + '\n';
    for (let i = 0; i < text.length; i += 20) feedText(text.slice(i, i + 20));
  }
  state(from, to) { this.sample += Math.round(this.rand(40, 400)); this.emit(`S,${this.sample},${from},${to}`); }
  start() {
    this.running = true;
    this.emit(`# ble connected, ${CONFIG.deviceLabel}-demo`);
    this.emit(`N,${CONFIG.deviceLabel}-demo`);
    this.emit('C,2500.00,0.0120,-0.0310,0.9990');
    this.loop();
  }
  stop() { this.running = false; clearTimeout(this.timer); }
  /* One person's go is several bursts with a breather between them; the loop
     also plays the part of whoever taps "Next jumper" when they swap over. */
  async loop() {
    await this.wait(1200);
    while (this.running) {
      const others = this.names.filter((n) => n !== this.lastName);
      this.lastName = others[Math.floor(Math.random() * others.length)];
      await demoNextJumper(this.lastName);
      this.target = this.rand(1.1, 1.45);
      const sets = Math.round(this.rand(2, 4));
      for (let i = 0; i < sets && this.running; i++) {
        await this.set();
        if (!this.running) return;
        await this.wait(this.rand(4000, 8000));   // a rest, same jumper still on
      }
      if (!this.running) break;
      await this.wait(this.rand(4000, 8000));     // the next jumper climbs on
    }
  }
  async set() {
    const n = Math.round(this.rand(8, 22));
    const target = this.target;
    this.state('REST', 'CONTACT');
    for (let i = 0; i < n && this.running; i++) {
      const warm = i < 4 ? (4 - i) * 0.09 : 0;          // build-up jumps are lower
      const flight = Math.min(1.6, Math.max(0.9, target - warm + this.rand(-0.07, 0.07)));
      let contact = Math.min(0.35, Math.max(0.2, 0.2 + (flight - 0.9) * 0.12 + this.rand(-0.03, 0.05)));
      let flags = 0;
      if (i === 0) { flags |= 1; contact = this.rand(0.25, 0.35); }
      const peak = Math.min(7, Math.max(3, 3 + (flight - 0.9) * 5 + this.rand(-0.4, 0.4)));
      if (peak > 6.8 && Math.random() < 0.5) flags |= 2;
      if (Math.random() < 0.04) flags |= 4;
      await this.wait(contact * 1000);
      this.state('CONTACT', 'FLIGHT');
      await this.wait(flight * 1000);
      this.state('FLIGHT', 'CONTACT');
      this.clock += Math.round((contact + flight) * 1000);
      if (!this.running) return;
      this.emit(`J,${this.index++},${(flight * 1000).toFixed(1)},${(contact * 1000).toFixed(1)},${peak.toFixed(2)},${this.clock},${flags}`);
      if (Math.random() < 0.03) this.emit('J,oops,not-a-number');   // bad data must be ignored, never crash
      if (Math.random() < 0.05) this.emit(`X,${this.sample},short_contact`);
    }
    if (!this.running) return;
    await this.wait(1200);                  // quiet for a second -> firmware goes to REST
    this.clock += 4000;
    this.state('CONTACT', 'REST');
  }
}

/** The demo taps "Next jumper" for you, so a demo session shows real turns and sets. */
async function demoNextJumper(name) {
  if (!S.demo) return;
  await enqueue(() => closeTurn());
  if (S.session) await enqueue(() => openTurn({ jumper: name }));
  renderAfterData({});
}

async function startDemo({ resume = false } = {}) {
  if (BLE.state === 'connected' || BLE.state === 'reconnecting') { toast('Disconnect the sensor before starting the demo.'); return; }
  if (S.demo) return;
  const speed = Math.max(0.1, Number(new URLSearchParams(location.search).get('demospeed')) || 1);
  if (!resume || !S.session || !S.session.demo) {
    if (S.session && !S.session.demo) await DB.setMeta('lastRealSessionId', S.session.id);
    await enqueue(() => createSession({ demo: true }));
  }
  S.demo = new DemoSensor(speed);
  resetLineBuffer();
  await DB.setMeta('demoActive', true);
  S.demo.start();
  Wake.enable();
  renderConnection();
  renderAfterData({});
  if (!resume) toast('Demo started — simulated jumps go into a separate Demo session.');
}

async function stopDemo({ restore = true } = {}) {
  if (!S.demo) return;
  S.demo.stop();
  S.demo = null;
  Wake.disable();
  await DB.setMeta('demoActive', false);
  await enqueue(() => closeTurn());
  closeNameSheet();
  S.deviceName = (await DB.meta('lastDeviceName')) || null;   // drop the demo's name
  renderDeviceName();
  if (restore) {
    const back = await DB.meta('lastRealSessionId');
    const exists = back != null && (await DB.get('sessions', back));
    await setCurrentSession(exists ? back : null);
  }
  renderConnection();
  renderAfterData({});
}

/* ==========================================================================
   JumpChart — one stacked bar per jump (bed at the bottom, air on top, height = air + bed). SVG, hand-built.
   Scroll mode: fixed bar width, horizontal scroll, fixed y-axis.
   Fit mode (results card): squeezes every jump into the available width.
   ========================================================================== */
let chartUid = 0;
class JumpChart {
  constructor(root, { live = false, fit = false, showDetail = true, showSets = false, emptyText = '' } = {}) {
    this.root = root; this.live = live; this.fit = fit; this.showDetail = showDetail && !fit;
    this.showSets = showSets;   // draw a divider and a "SET n" label where one burst ends and the next begins
    this.emptyText = emptyText;
    this.uid = ++chartUid;
    this.jumps = []; this.pinned = true; this.selected = null; this.newFrom = Infinity;
    root.innerHTML = `
      <div class="chart-top">
        <div class="legend" aria-hidden="true"><span><i class="sw sw-air"></i>Air</span><span><i class="sw sw-bed"></i>Bed</span></div>
        <span class="chart-hint">Bar = air + bed${fit ? '' : ' · tap for details'}</span>
      </div>
      <div class="chart-body">
        <svg class="y-axis" aria-hidden="true"></svg>
        <div class="scroller" ${fit ? '' : 'tabindex="0"'} role="group" aria-label="One bar per jump. Bar height is the total of air plus bed. Blue top part is air, striped orange bottom part is bed.">
          <svg class="plot"></svg>
        </div>
        ${fit ? '' : '<button type="button" class="to-latest" hidden>Jump to latest ›</button>'}
        <div class="chart-empty" hidden></div>
      </div>
      ${this.showDetail ? '<div class="chart-detail" aria-live="polite"></div>' : ''}`;
    this.body = $('.chart-body', root);
    this.yAxis = $('.y-axis', root);
    this.scroller = $('.scroller', root);
    this.plot = $('.plot', root);
    this.empty = $('.chart-empty', root);
    this.detail = $('.chart-detail', root);
    this.latestBtn = $('.to-latest', root);

    if (this.fit) this.scroller.style.overflowX = 'hidden';
    this.scroller.addEventListener('scroll', () => {
      if (this.programmatic) { if (!this.atEnd()) return; this.programmatic = false; }
      this.pinned = this.atEnd();
      if (this.pinned && this.latestBtn) this.latestBtn.hidden = true;
    }, { passive: true });
    if (this.latestBtn) this.latestBtn.addEventListener('click', () => { this.pinned = true; this.latestBtn.hidden = true; this.scrollToEnd(true); });
    this.plot.addEventListener('click', (e) => {
      const g = e.target.closest('.jump');
      if (g) this.select(Number(g.dataset.i));
    });
    this.plot.addEventListener('keydown', (e) => {
      const g = e.target.closest('.jump');
      if (!g) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(Number(g.dataset.i)); }
    });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.body);
    this.renderDetail();
  }

  atEnd() { const s = this.scroller; return s.scrollLeft + s.clientWidth >= s.scrollWidth - 12; }

  scrollToEnd(smooth) {
    const s = this.scroller;
    const animate = smooth && !reducedMotion();
    if (animate) {   // ignore the in-between scroll events of a smooth scroll
      this.programmatic = true;
      clearTimeout(this.progTimer);
      this.progTimer = setTimeout(() => { this.programmatic = false; }, 700);
    }
    s.scrollTo({ left: s.scrollWidth, behavior: animate ? 'smooth' : 'auto' });
  }

  setJumps(jumps, { animate = false, resetView = false } = {}) {
    const prev = this.jumps.length;
    const grew = jumps.length > prev;
    if (resetView || jumps.length < prev) { this.selected = null; this.pinned = true; if (this.latestBtn) this.latestBtn.hidden = true; }
    this.jumps = jumps.slice();
    this.newFrom = animate && grew && !resetView ? prev : Infinity;
    this.render();
    this.newFrom = Infinity;
    if (!this.fit) {
      if (resetView) { if (this.live) this.scrollToEnd(false); else this.scroller.scrollLeft = 0; }
      else if (grew && this.live) {
        if (this.pinned) this.scrollToEnd(false);
        else if (this.latestBtn) this.latestBtn.hidden = false;
      }
    }
    this.renderDetail();
  }

  select(i) {
    this.selected = this.selected === i ? null : i;
    $$('.jump', this.plot).forEach((g) => g.classList.toggle('sel', Number(g.dataset.i) === this.selected));
    this.renderDetail();
  }

  renderDetail() {
    if (!this.detail) return;
    const j = this.selected != null ? this.jumps[this.selected] : null;
    if (!j) {
      this.detail.innerHTML = this.jumps.length ? '<span>Tap any bar to see that jump.</span>' : '';
      return;
    }
    const ft = flagText(j.flags);
    this.detail.innerHTML = `
      <span class="d-title">Jump ${this.selected + 1}</span>
      <span class="d-total">Total <b>${secs(j.flightMs + j.contactMs)} s</b></span>
      <span class="d-air">Air <b>${secs(j.flightMs)} s</b></span>
      <span class="d-bed">Bed <b>${secs(j.contactMs)} s</b></span>
      <span>Peak <b>${j.peakG.toFixed(1)} g</b></span>
      ${j.flags ? `<span class="d-flag" title="${esc(ft)}">Flags ${j.flags}${ft ? ' · ' + esc(ft) : ''}</span>` : ''}
      <span class="d-raw">Sensor #${j.index}</span>`;
  }

  render() {
    const n = this.jumps.length;
    const scrollerW = this.scroller.clientWidth;
    if (!scrollerW) return;   // hidden

    // Horizontal geometry
    let groupW, barW;
    if (this.fit) {
      groupW = Math.max(3, (scrollerW - 6) / Math.max(n, 8));
      barW = Math.max(1.5, groupW * 0.72);
    } else {
      // Fit 12 bars across the visible width (a portrait phone), capped on wide
      // screens so a desktop shows more jumps. Longer turns scroll sideways.
      groupW = Math.min(64, Math.max(22, (scrollerW - 16) / CONFIG.barsVisible));
      barW = Math.round(groupW * 0.8);
    }
    // A turn is several sets (bursts) with a rest between them. Leave a gap and
    // a divider at each set boundary so one person's go still reads as one chart.
    const showSets = this.showSets && !this.fit;
    const gapW = showSets ? Math.max(12, groupW * 0.5) : 0;
    const xs = new Array(n);
    const starts = [];          // index of the first jump of each set
    let gaps = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || (showSets && this.jumps[i].setId !== this.jumps[i - 1].setId)) {
        if (i > 0) gaps++;
        starts.push(i);
      }
      xs[i] = i * groupW + gaps * gapW;
    }
    const contentW = this.fit ? scrollerW : Math.max(scrollerW, n * groupW + gaps * gapW + 16);
    this.plot.setAttribute('width', contentW);

    // Vertical geometry (read after width is set so a scrollbar is accounted for)
    const H = this.scroller.clientHeight;
    this.plot.setAttribute('height', H);
    this.yAxis.setAttribute('height', H);
    const labels = !this.fit || groupW >= 46;
    const top = labels ? 26 : 22, bottom = showSets && starts.length > 1 ? 48 : 30;
    const plotH = Math.max(40, H - top - bottom);

    let maxS = 0;
    for (const j of this.jumps) maxS = Math.max(maxS, (j.flightMs + j.contactMs) / 1000);
    const step = maxS > 2.5 ? 0.5 : 0.25;
    const yMax = Math.max(1.75, Math.ceil((maxS + 0.001) / step) * step);
    const y = (s) => top + plotH - (s / yMax) * plotH;

    // Y axis (fixed, outside the scroller)
    let ya = `<text class="tick-unit" x="4" y="${top - 10}">SEC</text>`;
    let grid = '';
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const yy = y(v).toFixed(1);
      ya += `<text class="tick" x="40" y="${yy}" dy="5" text-anchor="end">${v.toFixed(2)}</text>`;
      if (v > 0) grid += `<line class="gridline" x1="0" x2="${contentW}" y1="${yy}" y2="${yy}"/>`;
    }
    this.yAxis.innerHTML = ya;

    const hatch = `hatch${this.uid}`;
    let out = `<defs><pattern id="${hatch}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="3" height="7" fill="rgba(255,255,255,.45)"/></pattern></defs>${grid}`;
    const base = y(0);
    const labelEvery = this.fit ? Math.ceil(26 / groupW) : 1;
    for (let i = 0; i < n; i++) {
      const j = this.jumps[i];
      const gx = xs[i] + (this.fit ? 3 : 8);
      // One stacked bar per jump: bed (push-off contact) at the bottom, air on top.
      // Its height is the whole jump: flightMs + contactMs.
      const x0 = gx + (groupW - barW) / 2;
      const cx = (x0 + barW / 2).toFixed(1);
      const totalMs = j.flightMs + j.contactMs;
      const yBed = y(j.contactMs / 1000), yTop = y(totalMs / 1000);
      const rx = Math.min(5, barW / 3);
      const bedH = base - yBed, airH = yBed - yTop;
      const isNew = i >= this.newFrom;
      const ft = flagText(j.flags);
      const w = barW.toFixed(1);
      // air segment: rounded top corners only
      const airPath = `M${x0.toFixed(1)} ${yBed.toFixed(1)} V${(yTop + rx).toFixed(1)} q0 ${-rx} ${rx} ${-rx} h${(barW - 2 * rx).toFixed(1)} q${rx} 0 ${rx} ${rx} V${yBed.toFixed(1)} z`;
      out += `<g class="jump${isNew ? ' new' : ''}${this.selected === i ? ' sel' : ''}" data-i="${i}"${this.fit ? '' : ' tabindex="0" role="button"'}
          aria-label="Jump ${i + 1}: total ${secs(totalMs)} seconds, air ${secs(j.flightMs)}, bed ${secs(j.contactMs)}${j.flags ? ', flagged' : ''}">
        <rect class="hit" x="${gx}" y="${top - 24}" width="${groupW}" height="${plotH + 24 + bottom}" rx="8"/>
        <g class="bar">
          <path class="bar-air" d="${airPath}"/>
          <rect class="bar-bed" x="${x0.toFixed(1)}" y="${yBed.toFixed(1)}" width="${w}" height="${bedH.toFixed(1)}"/>
          <rect class="bar-bed-hatch" x="${x0.toFixed(1)}" y="${yBed.toFixed(1)}" width="${w}" height="${bedH.toFixed(1)}" fill="url(#${hatch})"/>
          ${barW >= 6 ? `<line class="bar-split" x1="${x0.toFixed(1)}" x2="${(x0 + barW).toFixed(1)}" y1="${yBed.toFixed(1)}" y2="${yBed.toFixed(1)}"/>` : ''}
        </g>
        ${labels ? `<text class="val val-total${groupW < 34 ? ' val-sm' : ''}" x="${cx}" y="${(yTop - 6).toFixed(1)}">${secs(totalMs)}</text>
        ${barW >= 30 && airH >= 22 ? `<text class="val val-in-air" x="${cx}" y="${(yBed - 7).toFixed(1)}">${secs(j.flightMs)}</text>` : ''}
        ${barW >= 30 && bedH >= 20 ? `<text class="val val-in-bed" x="${cx}" y="${(base - 6).toFixed(1)}">${secs(j.contactMs)}</text>` : ''}` : ''}
        ${i % labelEvery === 0 || i === n - 1 ? `<text class="xlab" x="${(gx + groupW / 2).toFixed(1)}" y="${(base + 20).toFixed(1)}">${i + 1}</text>` : ''}
        ${j.flags ? `<path class="flag-mark" d="M${(gx + groupW / 2).toFixed(1)} ${(top - 16).toFixed(1)} l4 7 h-8 z"><title>Flags ${j.flags}${ft ? ': ' + esc(ft) : ''}</title></path>` : ''}
      </g>`;
    }
    // Set brackets under the x labels, and a divider between one set and the next.
    if (showSets && starts.length > 1) {
      for (let k = 0; k < starts.length; k++) {
        const first = starts[k];
        const last = (k + 1 < starts.length ? starts[k + 1] : n) - 1;
        const x0 = xs[first] + 8, x1 = xs[last] + groupW + 8;
        if (k > 0) {
          const dx = (x0 - gapW / 2).toFixed(1);
          out += `<line class="set-divider" x1="${dx}" x2="${dx}" y1="${top - 18}" y2="${(base + 30).toFixed(1)}"/>`;
        }
        out += `<line class="set-rule" x1="${(x0 + 3).toFixed(1)}" x2="${(x1 - 3).toFixed(1)}" y1="${(base + 30).toFixed(1)}" y2="${(base + 30).toFixed(1)}"/>
          <text class="set-lab" x="${((x0 + x1) / 2).toFixed(1)}" y="${(base + 44).toFixed(1)}">SET ${k + 1}</text>`;
      }
    }
    out += `<line class="baseline" x1="0" x2="${contentW}" y1="${base}" y2="${base}"/>`;
    this.plot.innerHTML = out;

    this.empty.hidden = n > 0 || !this.emptyText;
    if (!this.empty.hidden) this.empty.innerHTML = this.emptyText;
  }
}

/* ==========================================================================
   Rendering
   ========================================================================== */
let liveChart, overlayChart, resultsChart;
let liveTurnId = null;   // which turn the live chart is showing

function renderAfterData({ newJump = false } = {}) {
  renderLive({ newJump });
  if (S.view === 'session') renderSession();
  if (S.view === 'history') renderHistory();
  if (S.overlay) renderOverlay();
}

function renderConnection() {
  const el = $('#conn-status');
  let state = BLE.state, label;
  if (S.demo) { state = 'demo'; label = 'Demo running'; }
  else label = { idle: 'Not connected', connecting: 'Connecting…', connected: `${deviceName()} connected`, reconnecting: 'Reconnecting…', lost: 'Disconnected' }[state];
  el.dataset.state = state;
  $('.conn-label', el).textContent = label;

  $('#demo-banner').hidden = !S.demo;
  const banner = $('#conn-banner');
  const showBanner = !S.demo && (state === 'reconnecting' || state === 'lost');
  banner.hidden = !showBanner;
  banner.dataset.tone = state === 'reconnecting' || BLE.soft ? 'info' : '';
  $('.conn-banner-msg', banner).textContent = BLE.message;
  $('#reconnect-btn').hidden = state !== 'lost';

  const connected = state === 'connected' || state === 'reconnecting';
  $('#connect-panel').hidden = connected || !!S.demo;
  const cbtn = $('#connect-btn');
  cbtn.disabled = !BLE.supported() || state === 'connecting';
  $('.btn-main', cbtn).textContent = state === 'connecting' ? 'Connecting…' : 'Connect sensor';
  el.setAttribute('aria-label', connected ? `${label}. Tap for sensor settings.` : label);
}

function renderLive({ newJump = false } = {}) {
  const turn = S.openTurn || S.turns[S.turns.length - 1] || null;
  const turnChanged = (turn ? turn.id : null) !== liveTurnId;
  liveTurnId = turn ? turn.id : null;
  const sets = turn ? setsOfTurn(turn.id) : [];
  const jumps = turn ? jumpsOfTurn(turn.id) : [];      // the whole go, not just the burst on now
  const kicker = $('#live-kicker'), title = $('#live-title');
  const nameBtn = $('#live-name-btn');

  if (!turn) {
    kicker.innerHTML = S.session ? esc(S.session.name) : '';
    title.textContent = S.session ? 'Waiting for first jump' : 'Ready for liftoff';
  } else {
    const demoPill = S.session.demo ? ' <span class="pill pill-demo">Demo</span>' : '';
    const nSets = `${sets.length} set${sets.length === 1 ? '' : 's'}`;
    if (S.openSet) kicker.innerHTML = `<span class="pill pill-live">Live</span> Turn ${turn.number} · set ${sets.length}${demoPill}`;
    else if (S.openTurn) kicker.innerHTML = `<span class="pill pill-done">Resting</span> Turn ${turn.number} · ${nSets} so far${demoPill}`;
    else kicker.innerHTML = `<span class="pill pill-done">Landed</span> Turn ${turn.number} · ${nSets} · waiting for the next jumper${demoPill}`;
    title.textContent = turn.jumper || (S.openTurn ? 'Tap to add a name' : turnLabel(turn));
  }
  nameBtn.disabled = !S.openTurn;
  nameBtn.classList.toggle('unnamed', !!turn && !turn.jumper);
  $('#next-jumper-btn').hidden = !S.openTurn;
  $('#live-stats').innerHTML = statsHTML(jumps);
  liveChart.setJumps(jumps, { animate: newJump && !turnChanged, resetView: turnChanged });
}

function sparkHTML(jumps) {
  const maxF = Math.max(1, ...jumps.map((j) => j.flightMs));
  const w = 100 / Math.max(jumps.length, 12);
  const bars = jumps.map((j, i) => `<rect x="${(i * w + w * 0.15).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" y="${(22 - (j.flightMs / maxF) * 22).toFixed(1)}" height="${((j.flightMs / maxF) * 22).toFixed(1)}"/>`).join('');
  return `<svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

/** One person's go: a heading with their combined numbers, then a row per set. */
function turnGroupHTML(t, sets, jumps, openTurnId, openSetId) {
  const all = sets.flatMap((s) => jumpsOfSet(s.id, jumps));
  const st = computeStats(all);
  const isOpen = t.id === openTurnId;
  return `<li class="turn-group">
    <button type="button" class="card-btn turn-card${isOpen ? ' open' : ''}" data-turn="${t.id}">
      <span class="turn-num">${t.number}</span>
      <span class="turn-who${t.jumper ? '' : ' unnamed'}">${esc(turnLabel(t))}</span>
      <span class="turn-tof">${secs(st.tof)}<small>s air</small></span>
      <span class="turn-meta">${isOpen ? '<span class="pill pill-live">On now</span> ' : ''}${fmtTime(t.startedAt)} · ${sets.length} set${sets.length === 1 ? '' : 's'} · ${st.n} jump${st.n === 1 ? '' : 's'}</span>
    </button>
    ${sets.length ? `<ol class="set-list">${sets.map((s) => setCardHTML(s, jumpsOfSet(s.id, jumps), s.id === openSetId)).join('')}</ol>`
      : '<p class="set-empty">Waiting for the first jump of this turn.</p>'}
  </li>`;
}

function setCardHTML(st, jumps, isOpen) {
  const s = computeStats(jumps);
  return `<li><button type="button" class="card-btn set-card${isOpen ? ' open' : ''}" data-set="${st.id}">
    <span class="set-label">Set ${st.number}</span>
    <span class="set-tof">${secs(s.tof)}<small>s air</small></span>
    <span class="set-meta">${isOpen ? '<span class="pill pill-live">Jumping</span> ' : ''}${fmtTime(st.startedAt)} · ${s.n} jump${s.n === 1 ? '' : 's'}</span>
    ${sparkHTML(jumps)}
  </button></li>`;
}

async function renderSession() {
  const root = $('#session-content');
  const viewingId = S.viewSessionId ?? (S.session ? S.session.id : null);
  if (viewingId == null) {
    root.innerHTML = `<div class="page-head"><h1 id="session-title" class="page-title">This session</h1></div>
      <div class="empty"><strong>No session yet</strong>Connect the sensor (or try the demo) and each turn will appear here.</div>`;
    return;
  }
  const isCurrent = S.session && viewingId === S.session.id;
  let session, turns, sets, jumps;
  if (isCurrent) { session = S.session; turns = S.turns; sets = S.sets; jumps = S.jumps; }
  else {
    session = await DB.get('sessions', viewingId);
    if (!session) { S.viewSessionId = null; return renderSession(); }
    ({ turns, sets, jumps } = await loadSessionData(viewingId));
  }
  const all = sets.flatMap((s) => jumpsOfSet(s.id, jumps));
  const tot = computeStats(all);
  const openTurnId = isCurrent && S.openTurn ? S.openTurn.id : null;
  const openSetId = isCurrent && S.openSet ? S.openSet.id : null;
  const main = $('main'); const scroll = main.scrollTop;
  root.innerHTML = `
    ${S.viewSessionId != null ? '<button type="button" class="btn-back back-link" data-action="back-history"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>History</button>' : ''}
    <div class="page-head">
      <p class="page-meta">${isCurrent ? '<span class="pill pill-current">Current session</span>' : ''}${session.demo ? '<span class="pill pill-demo">Demo data</span>' : ''}<span>${fmtDate(session.createdAt)} · ${fmtTime(session.createdAt)}</span></p>
      <div class="page-title-row">
        <h1 id="session-title" class="page-title">${esc(session.name)}</h1>
        <button type="button" class="icon-btn" data-action="rename-session" aria-label="Rename session"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg></button>
      </div>
      <p class="page-meta"><span>${turns.length} turn${turns.length === 1 ? '' : 's'}</span><span>${sets.length} set${sets.length === 1 ? '' : 's'}</span><span>${tot.n} jumps</span><span>${secs(tot.tof)} s total air</span></p>
    </div>
    <div class="toolbar">
      <button type="button" class="btn-small btn-outline" data-action="csv-session">Export CSV</button>
      ${isCurrent ? '<button type="button" class="btn-small btn-outline" data-action="new-session">Start new session</button>' : ''}
      ${isCurrent && BLE.state === 'connected' ? '<button type="button" class="btn-small btn-outline" data-action="disconnect">Disconnect sensor</button>' : ''}
      <button type="button" class="btn-small btn-outline btn-danger" data-action="delete-session">Delete session</button>
    </div>
    <h2 class="section-label">Turns</h2>
    ${turns.length ? `<ol class="list turn-list">${turns.map((t) => turnGroupHTML(t, setsOfTurn(t.id, sets), jumps, openTurnId, openSetId)).join('')}</ol>`
      : '<div class="empty"><strong>No turns yet</strong>A turn holds everything one person jumps. Each burst between rests is a set; tap “Next jumper” when someone swaps.</div>'}`;
  root.dataset.sessionId = session.id;
  main.scrollTop = scroll;
}

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  if (key === today) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === dayKey(y.toISOString())) return 'Yesterday';
  return fmtDate(`${key}T12:00:00`);
}
/** How much of the device's storage this app is using, or null if the browser won't say. */
async function storageUsed() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return typeof e.usage === 'number' ? e.usage : null;
  } catch (err) { return null; }
}
function fmtBytes(b) {
  if (b == null) return '';
  return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function sessionCardHTML(s, setCounts, turnCounts) {
  const turns = turnCounts.get(s.id) || 0;
  const sets = setCounts.get(s.id) || 0;
  return `<li><button type="button" class="card-btn session-card" data-session="${s.id}">
    <span class="session-name">${esc(s.name)}${s.demo ? ' <span class="pill pill-demo">Demo</span>' : ''}${S.session && S.session.id === s.id ? ' <span class="pill pill-current">Current</span>' : ''}</span>
    <span class="chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <span class="session-meta">${fmtTime(s.createdAt)} · ${turns} turn${turns === 1 ? '' : 's'} · ${sets} set${sets === 1 ? '' : 's'}</span>
  </button></li>`;
}

async function renderHistory() {
  const root = $('#history-content');
  const sessions = (await DB.all('sessions')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const turnCounts = new Map(), setCounts = new Map();
  for (const t of await DB.all('turns')) turnCounts.set(t.sessionId, (turnCounts.get(t.sessionId) || 0) + 1);
  for (const s of await DB.all('sets')) setCounts.set(s.sessionId, (setCounts.get(s.sessionId) || 0) + 1);
  const hasDemo = sessions.some((s) => s.demo);
  const today = dayKey(new Date().toISOString());
  const todays = sessions.filter((s) => dayKey(s.createdAt) === today);
  const older = sessions.filter((s) => dayKey(s.createdAt) !== today);
  const used = await storageUsed();

  // Older sessions are grouped by the day they happened on.
  const days = [];
  for (const s of older) {
    const k = dayKey(s.createdAt);
    if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, list: [] });
    days[days.length - 1].list.push(s);
  }

  root.innerHTML = `
    <div class="page-head"><h1 id="history-title" class="page-title">History</h1>
      <p class="page-meta"><span>${sessions.length} session${sessions.length === 1 ? '' : 's'} saved on this device</span>${used != null ? `<span>${fmtBytes(used)} used</span>` : ''}</p></div>
    <div class="toolbar">
      ${sessions.length ? '<button type="button" class="btn-small btn-outline" data-action="csv-all">Export everything (CSV)</button>' : ''}
      ${hasDemo ? '<button type="button" class="btn-small btn-outline btn-danger" data-action="delete-demo">Delete all demo data</button>' : ''}
    </div>
    ${sessions.length ? '' : '<div class="empty"><strong>Nothing saved yet</strong>Your training sessions will be listed here, newest first.</div>'}
    ${todays.length ? `<h2 class="section-label">Today</h2>
      <ul class="list">${todays.map((s) => sessionCardHTML(s, setCounts, turnCounts)).join('')}</ul>` : ''}
    ${older.length ? `
      <div class="group-head">
        <button type="button" class="group-toggle" data-action="toggle-older" aria-expanded="${S.historyOpen}">
          <svg class="group-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>Previous sessions</span>
          <span class="group-count">${older.length}</span>
        </button>
        <button type="button" class="btn-small btn-outline btn-danger" data-action="clear-older">Clear</button>
      </div>
      ${S.historyOpen ? days.map((d) => `<h3 class="day-label">${esc(dayLabel(d.key))}</h3>
        <ul class="list">${d.list.map((s) => sessionCardHTML(s, setCounts, turnCounts)).join('')}</ul>`).join('')
        : '<p class="group-hint">Everything from before today. Tap to open.</p>'}` : ''}`;
}

function showView(view, { sessionId = null } = {}) {
  S.view = view;
  if (view === 'session') S.viewSessionId = sessionId;
  for (const v of ['live', 'session', 'history']) $(`#view-${v}`).hidden = v !== view;
  $$('.tab').forEach((t) => (t.dataset.tab === view ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  $('main').scrollTop = 0;
  if (view === 'live') renderLive({});
  if (view === 'session') renderSession();
  if (view === 'history') renderHistory();
}

/* ---------- Turn / set detail overlay ---------- */
async function openOverlay(kind, id) {
  S.overlay = { kind, id };
  $('#turn-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  await renderOverlay(true);
  $('[data-close-turn]').focus();
}
function closeOverlay() {
  S.overlay = null;
  $('#turn-overlay').hidden = true;
  document.body.style.overflow = '';
}

/** A whole turn with its sets and their jumps, from memory if it is the current session. */
async function getTurnData(turnId) {
  if (S.session && S.turns.some((t) => t.id === turnId)) {
    return { turn: S.turns.find((t) => t.id === turnId), sets: setsOfTurn(turnId), jumps: S.jumps, session: S.session };
  }
  const turn = await DB.get('turns', turnId);
  if (!turn) return null;
  const sets = (await DB.byIndex('sets', 'turnId', turnId)).sort(byNumber);
  const jumps = new Map();
  for (const s of sets) jumps.set(s.id, (await DB.byIndex('jumps', 'setId', s.id)).sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id)));
  return { turn, sets, jumps, session: await DB.get('sessions', turn.sessionId) };
}
/** The same, plus the one set being looked at and its jumps. */
async function getSetData(setId) {
  const set = (S.session && S.sets.find((s) => s.id === setId)) || (await DB.get('sets', setId));
  if (!set) return null;
  const data = await getTurnData(set.turnId);
  if (!data) return null;
  return Object.assign({}, data, { set, list: jumpsOfSet(setId, data.jumps) });
}
async function getOverlayData(kind, id) {
  const data = kind === 'turn' ? await getTurnData(id) : await getSetData(id);
  if (!data) return null;
  data.isTurn = kind === 'turn';
  data.list = data.isTurn ? data.sets.flatMap((s) => jumpsOfSet(s.id, data.jumps)) : data.list;
  return data;
}

async function renderOverlay(first = false) {
  if (!S.overlay) return;
  const showing = S.overlay;
  const data = await getOverlayData(showing.kind, showing.id);
  if (S.overlay !== showing) return;    // switched screens while we were reading
  if (!data) { closeOverlay(); return; }
  const { turn, sets, session, set, list, isTurn } = data;
  const liveTurn = !!(S.openTurn && S.openTurn.id === turn.id);
  const liveSet = !isTurn && !!(S.openSet && S.openSet.id === set.id);
  const where = `${esc(session ? session.name : '')} · ${fmtTime(isTurn ? turn.startedAt : set.startedAt)}`;

  $('#turn-overlay-kicker').innerHTML = isTurn
    ? `${liveTurn ? '<span class="pill pill-live">On now</span> ' : ''}Turn ${turn.number} · ${sets.length} set${sets.length === 1 ? '' : 's'} · ${where}`
    : `${liveSet ? '<span class="pill pill-live">Jumping</span> ' : ''}Turn ${turn.number} · ${esc(turnLabel(turn))} · ${where}`;
  $('#turn-overlay-title').textContent = isTurn ? turnLabel(turn) : `Set ${set.number}`;
  $('#turn-overlay-stats').innerHTML = statsHTML(list);
  overlayChart.live = isTurn ? liveTurn : liveSet;
  overlayChart.showSets = isTurn;             // a turn's chart is divided set by set
  overlayChart.setJumps(list, { resetView: first, animate: !first });

  const setIndex = isTurn ? -1 : sets.findIndex((s) => s.id === set.id);
  const isLive = isTurn ? liveTurn : liveSet;
  $('#turn-overlay-actions').innerHTML = [
    '<button type="button" class="btn-primary" data-act="results">Results card</button>',
    isTurn ? '<button type="button" class="btn-outline" data-act="rename">Name / rename</button>' : '',
    !isTurn && setIndex > 0 ? '<button type="button" class="btn-outline" data-act="split">Start a new turn here</button>' : '',
    isTurn && turn.number > 1 ? `<button type="button" class="btn-outline" data-act="merge">Merge into turn ${turn.number - 1}</button>` : '',
    '<button type="button" class="btn-outline" data-act="csv">Export CSV</button>',
    `<button type="button" class="btn-outline btn-danger" data-act="delete"${isLive ? ' disabled title="Still going — tap Next jumper first"' : ''}>Delete ${isTurn ? 'turn' : 'set'}</button>`,
  ].filter(Boolean).join('');
}

/* ---------- Results card ---------- */
async function openResults(kind, id) {
  const data = await getOverlayData(kind, id);
  if (!data) return;
  const { turn, sets, session, set, list, isTurn } = data;
  const s = computeStats(list);
  $('#rc-date').textContent = fmtDate(isTurn ? turn.startedAt : set.startedAt);
  $('#rc-name').textContent = turnLabel(turn);
  $('#rc-session').textContent = `${session ? session.name : ''} · Turn ${turn.number} · ${isTurn ? `${sets.length} set${sets.length === 1 ? '' : 's'}` : `set ${set.number}`}`;
  $('#rc-tof').innerHTML = `${secs(s.tof)}<small>s</small>`;
  // Time actually spent jumping: the rests between a turn's sets don't count.
  const durS = Math.round(jumpingMs(list) / 1000);
  const cell = (cls, label, val) => `<div class="rc-stat ${cls}"><span>${label}</span><b>${val}</b></div>`;
  $('#rc-grid').innerHTML =
    cell('', 'Jumps', s.n) +
    cell('air', 'Best air', `${secs(s.best)}<small>s</small>`) +
    cell('air', 'Avg air', `${secs(s.avgAir)}<small>s</small>`) +
    cell('', 'Jumping', `${Math.floor(durS / 60)}:${String(durS % 60).padStart(2, '0')}`) +
    cell('bed', 'Avg bed', `${secs(s.avgBed)}<small>s</small>`) +
    cell('', 'Peak G', `${s.peak.toFixed(1)}<small>g</small>`);
  $('#results').hidden = false;
  document.body.style.overflow = 'hidden';
  resultsChart.setJumps(list, { resetView: true });
  requestAnimationFrame(() => resultsChart.render());
  $('#results-close').focus();
}
function closeResults() {
  $('#results').hidden = true;
  if (!S.overlay) document.body.style.overflow = '';
}

/* ---------- "Who's up?" sheet ----------
   'next'    = the go that just ended, so name the one about to start
   'current' = put a name on the go that is on now                        */
function openNameSheet(mode, { summary = '', exclude = '' } = {}) {
  S.nameSheet = { mode, summary, exclude };
  renderNameSheet();
}
function closeNameSheet() { S.nameSheet = null; renderNameSheet(); }
function chipsHTML(exclude = '') {
  return S.jumpers.slice(0, 8)
    .filter((j) => j.name !== exclude)
    .map((j) => `<button type="button" class="chip" data-name="${esc(j.name)}">${esc(j.name)}</button>`).join('');
}
function renderNameSheet() {
  const sheet = $('#name-sheet');
  if (!S.nameSheet || !S.session) { sheet.hidden = true; return; }
  $('#name-sheet-title').textContent = S.nameSheet.mode === 'next' ? "Who's up?" : "Who's jumping?";
  $('#name-sheet-sub').textContent = S.nameSheet.summary;
  $('#name-sheet-chips').innerHTML = chipsHTML(S.nameSheet.exclude);   // whoever just finished isn't up next
  const wasHidden = sheet.hidden;
  sheet.hidden = false;
  if (wasHidden) $('#name-sheet-input').value = '';
}
async function answerNameSheet(name) {
  const mode = S.nameSheet ? S.nameSheet.mode : 'current';
  S.nameSheet = null;
  $('#name-sheet-input').value = '';
  $('#name-sheet').hidden = true;
  const clean = name ? name.trim().slice(0, 40) : null;
  if (clean && S.session) {
    if (mode === 'next') {
      // Open the turn straight away so the live screen can show who is on.
      await enqueue(() => openTurn({ jumper: clean }));
    } else {
      const t = S.openTurn || S.turns[S.turns.length - 1];
      if (t) await nameTurn(t.id, clean);
    }
  }
  renderAfterData({});
}

/** The "Next jumper" tap: end this person's go, then ask who is on next. */
async function nextJumper() {
  const t = await enqueue(() => closeTurn());
  let summary = 'Nothing was recorded for the last turn.';
  if (t) {
    const s = computeStats(jumpsOfTurn(t.id));
    summary = `${turnLabel(t)} finished · ${s.n} jump${s.n === 1 ? '' : 's'} · ${secs(s.tof)} s air`;
  }
  openNameSheet('next', { summary, exclude: t && t.jumper ? t.jumper : '' });
}

/* ---------- Dialogs ---------- */
function confirmDialog(title, msg, okLabel = 'Delete', danger = okLabel === 'Delete') {
  const dlg = $('#confirm-dlg');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = msg;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-ok').classList.toggle('btn-danger-solid', danger);
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}
/** Sensor settings: rename the connected sensor, or disconnect it. The name is
    what tells one trampoline's sensor from the next in the Bluetooth picker, so
    it is worth setting once per device at a club. */
async function openSensorDialog() {
  const dlg = $('#sensor-dlg');
  const { prefix, label } = splitDeviceName(deviceName());
  const input = $('#sensor-label-input');
  const canRename = BLE.state === 'connected' && !!BLE.rx && !S.demo;

  $('#sensor-prefix').textContent = prefix;
  $('#sensor-prefix').hidden = !prefix;
  input.maxLength = CONFIG.deviceLabelMax;
  input.value = label;
  input.disabled = !canRename;
  $('#sensor-save').hidden = !canRename;
  $('#sensor-sub').textContent = canRename
    ? 'Name it after its trampoline, so it is easy to pick from the list.'
    : S.demo ? 'This is the demo sensor — there is nothing to rename.'
             : 'Connect the sensor to change its name.';

  dlg.returnValue = '';
  dlg.showModal();
  if (canRename) input.select();
  const ok = await new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
  if (!ok || !canRename) return;

  // Match what the firmware will accept, so what they typed is what they get.
  const wanted = input.value.replace(/[^\x20-\x7E]|,/g, '').trim().slice(0, CONFIG.deviceLabelMax).trim();
  if (!wanted || wanted === label) return;
  try {
    await BLE.setLabel(wanted);
    toast('Renaming the sensor…');
  } catch (e) {
    console.warn('[ble] rename failed', e);
    toast("Couldn't rename the sensor — is it still connected?");
  }
}

function nameDialog(title, initial, { chips = false } = {}) {
  const dlg = $('#rename-dlg');
  $('#rename-title').textContent = title;
  const input = $('#rename-input');
  input.value = initial || '';
  $('#rename-chips').innerHTML = chips ? chipsHTML(initial) : '';
  $('#rename-chips').hidden = !chips || !S.jumpers.length;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true }));
}

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) $('button', el).addEventListener('click', () => { el.hidden = true; action.fn(); });
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3500);
}

/* ==========================================================================
   CSV export
   ========================================================================== */
const CSV_COLUMNS = ['session_name', 'session_date', 'turn_number', 'jumper_name', 'set_number', 'type', 'index', 'flightMs', 'contactMs', 'peakG', 'timestamp', 'flags', 'received_time'];
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function buildCsv({ sessionId = null, turnId = null, setId = null } = {}) {
  let sessions = await DB.all('sessions');
  let turns = await DB.all('turns');
  let sets = await DB.all('sets');
  let jumps = await DB.all('jumps');
  if (sessionId != null) sessions = sessions.filter((s) => s.id === sessionId);
  if (turnId != null) turns = turns.filter((t) => t.id === turnId);
  if (setId != null) sets = sets.filter((s) => s.id === setId);
  const sById = new Map(sessions.map((s) => [s.id, s]));
  const tById = new Map(turns.filter((t) => sById.has(t.sessionId)).map((t) => [t.id, t]));
  const stById = new Map(sets.filter((s) => tById.has(s.turnId)).map((s) => [s.id, s]));
  jumps = jumps.filter((j) => stById.has(j.setId));
  jumps.sort((a, b) => {
    const sa = stById.get(a.setId), sb = stById.get(b.setId);
    const ta = tById.get(sa.turnId), tb = tById.get(sb.turnId);
    return ta.sessionId - tb.sessionId || ta.number - tb.number || sa.number - sb.number || (a.order ?? a.id) - (b.order ?? b.id);
  });
  const rows = [CSV_COLUMNS.join(',')];
  for (const j of jumps) {
    const st = stById.get(j.setId), t = tById.get(st.turnId), s = sById.get(t.sessionId);
    rows.push([s.name, s.createdAt, t.number, t.jumper || '', st.number, j.type, j.index, j.flightMs, j.contactMs, j.peakG, j.timestamp, j.flags, j.receivedAt].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
async function exportCsv(opts, filenamePart) {
  const csv = await buildCsv(opts);
  const name = `${slug(CONFIG.brandName)}-${slug(filenamePart)}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (isMobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; console.info('[csv] share failed, downloading instead', e); }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${name}`);
}

/* ==========================================================================
   Events
   ========================================================================== */
function wireEvents() {
  $('#connect-btn').addEventListener('click', () => BLE.connect());
  $('#conn-status').addEventListener('click', async () => {
    if (S.demo) { if (await confirmDialog('Stop the demo?', 'Simulated jumps stop. The demo session stays in History until you delete it.', 'Stop demo')) stopDemo(); return; }
    if (BLE.state === 'connected' || BLE.state === 'reconnecting') return openSensorDialog();
    if (BLE.state === 'lost') BLE.manualReconnect();
  });
  $('#reconnect-btn').addEventListener('click', () => BLE.manualReconnect());
  $('#sensor-disconnect').addEventListener('click', async () => {
    $('#sensor-dlg').close('cancel');
    if (await confirmDialog('Disconnect the sensor?', 'Everything recorded so far is saved. You can connect again at any time.', 'Disconnect')) BLE.disconnect();
  });
  $('#demo-btn').addEventListener('click', () => startDemo());
  $('#demo-stop').addEventListener('click', () => stopDemo());
  $('#next-jumper-btn').addEventListener('click', () => nextJumper());
  $('#live-name-btn').addEventListener('click', () => {
    if (!S.openTurn) return;
    openNameSheet('current', { summary: `Turn ${S.openTurn.number} · on the trampoline now` });
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.tab)));

  // Name sheet
  $('#name-sheet-chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) answerNameSheet(c.dataset.name); });
  $('#name-sheet-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#name-sheet-input').value.trim(); if (v) answerNameSheet(v); else $('#name-sheet-input').focus(); });
  $('#name-sheet-skip').addEventListener('click', () => answerNameSheet(null));

  $$('[data-dlg-cancel]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('cancel')));
  // Rename dialog chips fill the input and save
  $('#rename-chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { $('#rename-input').value = c.dataset.name; $('#rename-dlg').close('ok'); } });

  // Session screen
  $('#session-content').addEventListener('click', async (e) => {
    const setCard = e.target.closest('[data-set]');
    if (setCard) return openOverlay('set', Number(setCard.dataset.set));
    const turnCard = e.target.closest('[data-turn]');
    if (turnCard) return openOverlay('turn', Number(turnCard.dataset.turn));
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const sid = Number($('#session-content').dataset.sessionId);
    const session = S.session && S.session.id === sid ? S.session : await DB.get('sessions', sid);
    switch (btn.dataset.action) {
      case 'back-history': showView('history'); break;
      case 'disconnect': BLE.disconnect(); break;
      case 'rename-session': { const n = await nameDialog('Rename session', session.name); if (n) await renameSession(sid, n); break; }
      case 'csv-session': await exportCsv({ sessionId: sid }, session.name); break;
      case 'new-session':
        if (await confirmDialog('Start a new session?', 'The current session is saved in History. The turn on now is closed and new ones go into a fresh session.', 'Start new')) {
          await enqueue(() => createSession({ demo: !!S.demo }));
          renderAfterData({}); toast('New session started');
        }
        break;
      case 'delete-session':
        if (await confirmDialog('Delete this session?', `“${session.name}” and all its turns, sets and jumps will be permanently deleted from this device.`)) {
          await enqueue(() => deleteSession(sid));
          showView(S.viewSessionId != null ? 'history' : 'session');
          toast('Session deleted');
        }
        break;
    }
  });

  // History screen
  $('#history-content').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-session]');
    if (card) { const id = Number(card.dataset.session); return showView('session', { sessionId: S.session && S.session.id === id ? null : id }); }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'csv-all') await exportCsv({}, 'all-sessions');
    if (btn.dataset.action === 'toggle-older') { S.historyOpen = !S.historyOpen; return renderHistory(); }
    if (btn.dataset.action === 'clear-older') {
      const today = dayKey(new Date().toISOString());
      const older = (await DB.all('sessions')).filter((s) => dayKey(s.createdAt) !== today);
      if (!older.length) return;
      if (await confirmDialog('Clear previous sessions?',
        `${older.length} session${older.length === 1 ? '' : 's'} from before today will be permanently deleted from this device. Export everything first if you want to keep the numbers.`, 'Clear')) {
        for (const s of older) await enqueue(() => deleteSession(s.id));
        renderHistory(); toast(`Cleared ${older.length} session${older.length === 1 ? '' : 's'}`);
      }
    }
    if (btn.dataset.action === 'delete-demo') {
      if (await confirmDialog('Delete all demo data?', 'Every session marked “Demo” will be deleted. Your real training data is not touched.')) {
        const demos = (await DB.all('sessions')).filter((s) => s.demo);
        for (const s of demos) await enqueue(() => deleteSession(s.id));
        renderHistory(); toast(`Deleted ${demos.length} demo session${demos.length === 1 ? '' : 's'}`);
      }
    }
  });

  // Turn / set detail overlay
  $('[data-close-turn]').addEventListener('click', closeOverlay);
  $('#turn-overlay-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !S.overlay) return;
    const { kind, id } = S.overlay;
    const data = await getOverlayData(kind, id);
    if (!data) return;
    const { turn, session, set, list, isTurn } = data;
    const where = session ? session.name : 'session';
    switch (btn.dataset.act) {
      case 'results': return openResults(kind, id);
      case 'rename': {
        const n = await nameDialog('Who was jumping?', turn.jumper || '', { chips: true });
        if (n !== null) { await nameTurn(turn.id, n); renderOverlay(); }
        break;
      }
      case 'split':
        if (await confirmDialog('Start a new turn here?',
          `Set ${set.number} and every set after it in this turn become a turn of their own, so you can put a different name on them. No jumps are lost.`, 'Split', false)) {
          const newId = await enqueue(() => splitTurnAtSet(set.id));
          if (newId) { S.overlay = { kind: 'turn', id: newId }; await renderOverlay(true); toast('Split into a new turn'); }
          else closeOverlay();
        }
        break;
      case 'merge':
        if (await confirmDialog(`Merge into turn ${turn.number - 1}?`,
          'This turn\u2019s sets are added to the end of the one above it, and that turn\u2019s name is kept. No jumps are lost.', 'Merge', false)) {
          const target = await enqueue(() => mergeTurnIntoPrevious(turn.id));
          if (target) { S.overlay = { kind: 'turn', id: target }; await renderOverlay(true); toast('Turns merged'); }
          else closeOverlay();
        }
        break;
      case 'csv':
        await exportCsv(
          isTurn ? { turnId: turn.id, sessionId: turn.sessionId } : { setId: set.id, turnId: turn.id, sessionId: turn.sessionId },
          isTurn ? `${where}-turn-${turn.number}-${turnLabel(turn)}` : `${where}-turn-${turn.number}-set-${set.number}`);
        break;
      case 'delete': {
        const what = isTurn
          ? `Turn ${turn.number} (${turnLabel(turn)}, ${data.sets.length} set${data.sets.length === 1 ? '' : 's'}, ${list.length} jumps)`
          : `Set ${set.number} of turn ${turn.number} (${list.length} jumps)`;
        if (await confirmDialog(isTurn ? 'Delete this turn?' : 'Delete this set?', `${what} will be permanently deleted.`)) {
          await enqueue(() => (isTurn ? deleteTurn(turn.id) : deleteSet(set.id)));
          closeOverlay(); toast(isTurn ? 'Turn deleted' : 'Set deleted');
          if (S.view === 'session') renderSession();
        }
        break;
      }
    }
  });

  // Results
  $('#results-close').addEventListener('click', closeResults);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!$('#results').hidden) closeResults();
    else if (S.overlay) closeOverlay();
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
async function checkSupport() {
  const box = $('#unsupported');
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let html = '';
  if (!window.isSecureContext) {
    html = `<h2>Open this page over https</h2><p>Bluetooth only works on a secure (https://) address, or on localhost while testing.</p>`;
  } else if (!navigator.bluetooth) {
    html = ios
      ? `<h2>iPhone &amp; iPad: use the app</h2><p>Safari can't talk to Bluetooth sensors. A ${esc(CONFIG.brandName)} app for iPhone is on the way. In the meantime you can try the demo and look at saved sessions here.</p>`
      : `<h2>This browser can't connect to the sensor</h2><p>Please use <strong>Chrome on an Android phone or tablet</strong>, or <strong>Chrome or Edge on a computer</strong> (Windows, Mac or Chromebook). You can still try the demo and look at saved sessions here.</p>`;
  } else if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability().catch(() => true))) {
    html = `<h2>Bluetooth is off</h2><p>Switch on Bluetooth on this device, then tap Connect sensor.</p>`;
  }
  box.innerHTML = html;
  box.hidden = !html;
}

async function boot() {
  document.title = CONFIG.brandName;
  $$('[data-wordmark]').forEach((el) => { el.innerHTML = wordmarkHTML(); });
  renderDeviceName();

  liveChart = new JumpChart($('#live-chart'), { live: true, showSets: true, emptyText: `${LOGO_SVG.replace('wm-logo', 'empty-moon')}<strong>Every jump launches a bar</strong>Striped orange bed time at the bottom, blue air time on top.` });
  overlayChart = new JumpChart($('#turn-overlay-chart'), { showSets: true, emptyText: '<strong>No jumps</strong>' });
  resultsChart = new JumpChart($('#rc-chart'), { fit: true });
  wireEvents();

  try {
    await DB.open();
  } catch (e) {
    console.error(e);
    $('#unsupported').innerHTML = `<h2>Can't save data</h2><p>This browser is blocking on-device storage (private mode?). Jumps won't be kept.</p>`;
    $('#unsupported').hidden = false;
    return;
  }
  if (navigator.storage && navigator.storage.persist && !(await DB.meta('persistAsked'))) {
    navigator.storage.persist().then((ok) => console.info('[storage] persistent:', ok)).catch(() => {});
    await DB.setMeta('persistAsked', true);
  }
  S.jumpers = (await DB.meta('jumpers')) || [];
  S.deviceName = (await DB.meta('lastDeviceName')) || null;
  renderDeviceName();
  await loadCurrentSession(await DB.meta('currentSessionId'));
  await checkSupport();
  renderConnection();
  renderLive({});
  // The app is up and storing jumps. index.html watches this: if it is still
  // unset after a few seconds the page reloads past the cache, which rescues a
  // browser left holding one new file and one old one after an upload.
  window.__booted = true;

  // Reload-safe demo: carry on simulating into the same demo session.
  if (await DB.meta('demoActive')) await startDemo({ resume: true });

  // If the browser remembers a permitted sensor (Chrome with persistent
  // Bluetooth permissions), offer a one-tap reconnect after a reload.
  if (BLE.supported() && navigator.bluetooth.getDevices && !S.demo) {
    try {
      const devices = await navigator.bluetooth.getDevices();
      const known = devices.filter((x) => (x.name || '').startsWith(CONFIG.deviceNamePrefix));
      // With a sensor on every trampoline, only offer one we can name with
      // confidence: the one we were last on, or the only one there is.
      const d = known.find((x) => x.name === S.deviceName) || (known.length === 1 ? known[0] : null);
      if (d) {
        BLE.device = d;
        d.addEventListener('gattserverdisconnected', BLE.onDisconnected);
        BLE.setState('lost', `Tap Reconnect to pick up where you left off with ${d.name}.`, true);
      } else if (known.length > 1) {
        console.info('[ble] several sensors permitted; waiting for the user to choose one');
      }
    } catch (e) { console.info('[ble] getDevices unavailable', e.message); }
  }
  window.__app = { S, DB, CONFIG, parsePacket, feedText, BLE };   // handy for debugging in the console
}

document.addEventListener('DOMContentLoaded', boot);
