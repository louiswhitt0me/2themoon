'use strict';
/* ==========================================================================
   Debug screen — the serial monitor, the scope and the tuning panel.

   Why this exists: the detector's thresholds were compile-time constants, so
   checking them meant re-flashing, and the only view of the raw signal was
   400 Hz of text over USB. Neither is possible at a trampoline. This screen
   shows what the sensor actually measured, marks what the detector decided
   about it, and lets the thresholds be changed over Bluetooth.

   It is deliberately a separate file: none of it is needed to record a
   session, and app.js guards every call into here, so if this file fails to
   load the app still works.

   Firmware lines it consumes (see trampoline/link.h):
     D  block of packed raw samples      DH  dump starting      DG  dump gap
     DE dump finished                    DJ  a jump's edges     T   one setting
   plus S / X / E / C / J, which it draws on the plot as the detector's own
   account of what it thought was happening.
   ========================================================================== */

const DBG = {
  // Plot window. 2000 samples = 5 s at 400 Hz: about one jump and its
  // neighbours, which is the unit you actually read.
  defaultSpan: 2000,
  minSpan: 40,
  maxSpan: 48000,
  maxSamples: 24000,    // 60 s at 400 Hz, then the oldest are dropped
  maxLog: 600,          // lines of scrollback
  maxEvents: 400,
  trimChunk: 4000,
  storageKey: '2themoon-debug',
};

/* -------------------------------------------------------------------------
   Decoding
   ------------------------------------------------------------------------- */
/** One "D" line's payload: little-endian int16 triples of milli-g. */
function decodeBlock(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const n = Math.floor(bytes.length / 6);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = [
      dv.getInt16(i * 6, true) / 1000,
      dv.getInt16(i * 6 + 2, true) / 1000,
      dv.getInt16(i * 6 + 4, true) / 1000,
    ];
  }
  return out;
}

/** The detector's v: the projection of a onto the resting-g vector, so it
    reads 1.0 at rest whatever way up the sensor is mounted. Same formula as
    detector.cpp, which is the point — the plot has to show what it saw. */
function verticalG(ax, ay, az, g0) {
  if (!g0) return NaN;
  const m2 = g0[0] * g0[0] + g0[1] * g0[1] + g0[2] * g0[2];
  if (!(m2 > 0)) return NaN;
  return (ax * g0[0] + ay * g0[1] + az * g0[2]) / m2;
}

/** Time since boot for the cursor readout: "20m 08s 306ms", with hours
    added once a session runs past 60 minutes. */
function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const pad = (n, w) => String(n).padStart(w, '0');
  const tail = `${pad(s, 2)}s ${pad(t % 1000, 3)}ms`;
  return h ? `${h}h ${pad(m, 2)}m ${tail}` : `${m}m ${tail}`;
}

const lowerBound = (arr, n, x) => {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
};

/* -------------------------------------------------------------------------
   The screen
   ------------------------------------------------------------------------- */
const Debug = {
  enabled: false,
  ready: false,

  // raw scrollback
  log: [],
  paused: false,
  showBlocks: false,

  // signal
  d: { idx: [], ax: [], ay: [], az: [], v: [] },
  g0: null,
  periodUs: null,
  dumpMode: null,
  armed: false,    // trigger mode is on: the sensor sends a window when a jump happens
  blocksIn: 0,

  // the detector's own account, drawn over the signal
  events: [],      // {idx, type: 'state'|'reject'|'error'|'calib', text}
  states: [],      // {idx, to}
  marks: [],       // {index, onset, takeoff, land}
  gaps: [],        // {from, to} in sample indices

  // tuning
  params: new Map(),   // name -> {value, lo, hi, def}

  // view
  view: { start: 0, span: DBG.defaultSpan, follow: true, yMin: -1.5, yMax: 6 },
  show: { v: true, axes: false },
  cursor: null,

  /* ---------- lifecycle ---------- */
  init() {
    if (this.ready) return;
    this.ready = true;
    // Coming back to the tab: redraw at once rather than waiting for the next
    // line to arrive, so the screen is never stale in the hand.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.paint(); this.paintLog(); }
    });
    let on = false;
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('debug') === '1') localStorage.setItem(DBG.storageKey, '1');
      if (q.get('debug') === '0') localStorage.removeItem(DBG.storageKey);
      on = localStorage.getItem(DBG.storageKey) === '1';
    } catch (e) { /* private mode: stay off */ }
    this.canvas = document.getElementById('scope');
    this.wire();
    this.setEnabled(on, { quiet: true });
  },

  setEnabled(on, { quiet = false } = {}) {
    this.enabled = !!on;
    try {
      if (on) localStorage.setItem(DBG.storageKey, '1');
      else localStorage.removeItem(DBG.storageKey);
    } catch (e) { /* ignore */ }
    const tab = document.querySelector('.tab[data-tab="debug"]');
    if (tab) tab.hidden = !on;
    if (!on && typeof S !== 'undefined' && S.view === 'debug') showView('live');
    if (!quiet) toast(on ? 'Debug tools on' : 'Debug tools off');
  },

  /* ---------- the tap-to-reveal way in, for when the URL is inconvenient ---------- */
  tapCount: 0,
  tapTimer: null,
  secretTap() {
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => { this.tapCount = 0; }, 1200);
    if (++this.tapCount < 5) return;
    this.tapCount = 0;
    this.setEnabled(!this.enabled);
    if (this.enabled) showView('debug');
  },

  /* ---------- intake: every line the sensor sends ---------- */
  line(raw, p) {
    if (!this.enabled) return;
    const type = p && p.type ? p.type : String(raw).split(',')[0];
    if (type !== 'D') this.push(raw, 'in');
    else if (this.showBlocks) this.push(raw, 'in');

    if (!p) return;
    switch (p.kind) {
      case 'capture':     this.addBlock(p); break;
      case 'dumpHeader':  this.onHeader(p); break;
      case 'dumpGap':     this.gaps.push({ from: p.fromBlock, to: p.toBlock, at: this.lastIdx() }); break;
      case 'dumpEnd':     this.dumpMode = null; this.paint(); break;
      case 'jumpMarks':   this.keep(this.marks, p, DBG.maxEvents); this.paint(); break;
      case 'param':       this.params.set(p.name, { value: p.value, lo: p.lo, hi: p.hi, def: p.def }); this.renderParams(); break;
      case 'calib':       this.g0 = p.g0; this.periodUs = p.periodUs; this.addEvent(this.lastIdx(), 'calib', 'g0'); break;
      case 'reject':      this.addEvent(p.idx, 'reject', p.reason); break;
      case 'error':       this.addEvent(p.idx, 'error', p.reason); break;
      default: break;
    }
    if (p.type === 'S' && Number.isFinite(p.idx)) {
      this.keep(this.states, { idx: p.idx, to: p.to }, DBG.maxEvents);
      this.addEvent(p.idx, 'state', `${p.from}→${p.to}`);
    }
  },

  keep(arr, item, max) { arr.push(item); if (arr.length > max) arr.splice(0, arr.length - max); },
  addEvent(idx, type, text) {
    if (!Number.isFinite(idx)) return;
    this.keep(this.events, { idx, type, text }, DBG.maxEvents);
    this.paint();
  },
  lastIdx() { const d = this.d.idx; return d.length ? d[d.length - 1] : 0; },

  push(text, dir) {
    if (this.paused) return;
    this.log.push({ t: Date.now(), dir, text: String(text).slice(0, 400) });
    if (this.log.length > DBG.maxLog) this.log.splice(0, this.log.length - DBG.maxLog);
    this.paintLog();
  },

  // Rebuilding the scrollback is the one expensive thing here, and with the
  // capture blocks shown the sensor sends 20 lines a second. Coalesce into a
  // frame: nobody reads a live log line by line anyway.
  paintLog() { this.schedule('log', () => this.renderLog()); },

  onHeader(p) {
    this.g0 = p.g0;
    this.periodUs = p.periodUs;
    this.dumpMode = p.mode;
    this.renderStatus();
  },

  addBlock(p) {
    const rows = decodeBlock(p.b64);
    if (!rows.length) return;
    this.blocksIn++;
    const d = this.d;
    for (let i = 0; i < rows.length; i++) {
      const [ax, ay, az] = rows[i];
      d.idx.push(p.startIdx + i);
      d.ax.push(ax); d.ay.push(ay); d.az.push(az);
      d.v.push(verticalG(ax, ay, az, this.g0));
    }
    if (d.idx.length > DBG.maxSamples) {
      const cut = DBG.trimChunk;
      for (const k of ['idx', 'ax', 'ay', 'az', 'v']) d[k].splice(0, cut);
    }
    this.paint();
    this.renderStatus();
  },

  setArmed(on) {
    this.armed = on;
    this.paint();
    this.renderStatus();
  },

  clearSignal() {
    this.d = { idx: [], ax: [], ay: [], az: [], v: [] };
    this.events = []; this.states = []; this.marks = []; this.gaps = [];
    this.blocksIn = 0;
    this.view.follow = true;
    this.paint();
    this.renderStatus();
  },

  /* ---------- talking back ---------- */
  async send(cmd) {
    const line = String(cmd).trim();
    if (!line) return;
    if (typeof BLE === 'undefined' || !BLE.rx) { toast('Connect the sensor first'); return false; }
    try {
      await BLE.rx.writeValue(new TextEncoder().encode(line + '\n'));
      this.push(line, 'out');
      return true;
    } catch (e) {
      this.push(`! ${e.message}`, 'out');
      toast("Couldn't send that to the sensor");
      return false;
    }
  },

  /* ---------- redraw scheduling ---------- */
  // Coalesce redraws into a frame, but never depend on the frame arriving:
  // requestAnimationFrame does not fire in a hidden tab, which is exactly what
  // a phone in a pocket between turns looks like. Without the timer fallback
  // the "queued" flag would stay set for good and the screen would stay frozen
  // after coming back.
  _jobs: {},
  schedule(key, fn) {
    const job = this._jobs[key] || (this._jobs[key] = {});
    if (job.queued) return;
    job.queued = true;
    const run = () => {
      if (!job.queued) return;
      job.queued = false;
      cancelAnimationFrame(job.raf);
      clearTimeout(job.timer);
      fn();
    };
    job.raf = requestAnimationFrame(run);
    job.timer = setTimeout(run, 250);
  },

  /* ---------- the plot ---------- */
  paint() {
    if (!this.enabled) return;
    if (typeof S === 'undefined' || S.view !== 'debug') return;
    this.schedule('plot', () => this.draw());
  },

  draw() {
    const cv = this.canvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(cv.clientWidth * dpr));
    const H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const tok = (n, fb) => (css.getPropertyValue(n) || fb).trim();

    const d = this.d, n = d.idx.length;
    const view = this.view;
    if (view.follow && n) view.start = d.idx[n - 1] - view.span;
    const x0 = view.start, span = view.span;
    const { yMin, yMax } = view;
    const px = (sampleIdx) => ((sampleIdx - x0) / span) * W;
    const py = (g) => H - ((g - yMin) / (yMax - yMin)) * H;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = tok('--card-solid', '#141C48');
    ctx.fillRect(0, 0, W, H);

    if (!n) {
      ctx.fillStyle = tok('--text-2', '#AEB8E0');
      ctx.font = `${13 * dpr}px ${tok('--body', 'system-ui')}`;
      ctx.textAlign = 'center';
      // Nothing is drawn until the sensor sends a recording, so say which of
      // the two it is: waiting for a jump, or never asked for anything.
      ctx.fillText(this.armed
        ? 'Waiting for a jump — the plot fills in when one lands'
        : 'No signal yet — tap Stream, Trigger on jumps or Last 5 s below', W / 2, H / 2);
      return;
    }

    this.drawStateBands(ctx, px, W, H, dpr, tok);
    this.drawGrid(ctx, py, W, H, dpr, tok, yMin, yMax);
    this.drawThresholds(ctx, py, W, dpr, tok);

    const i0 = Math.max(0, lowerBound(d.idx, n, x0) - 1);
    const i1 = Math.min(n, lowerBound(d.idx, n, x0 + span) + 1);
    if (this.show.axes) {
      this.trace(ctx, d.idx, d.ax, i0, i1, px, py, '#FF6BD6', 1.1 * dpr, W);
      this.trace(ctx, d.idx, d.ay, i0, i1, px, py, '#7CF5C8', 1.1 * dpr, W);
      this.trace(ctx, d.idx, d.az, i0, i1, px, py, '#B79BFF', 1.1 * dpr, W);
    }
    if (this.show.v) this.trace(ctx, d.idx, d.v, i0, i1, px, py, tok('--moon', '#FFE17A'), 2.1 * dpr, W);

    this.drawMarks(ctx, px, H, dpr, tok);
    this.drawEvents(ctx, px, H, dpr, tok);
    this.drawCursor(ctx, px, py, W, H, dpr, tok, i0, i1);
  },

  drawGrid(ctx, py, W, H, dpr, tok, yMin, yMax) {
    ctx.strokeStyle = tok('--grid', 'rgba(176,192,255,.11)');
    ctx.fillStyle = tok('--text-2', '#AEB8E0');
    ctx.lineWidth = 1;
    ctx.font = `${10 * dpr}px ${tok('--body', 'system-ui')}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const step = (yMax - yMin) > 10 ? 2 : 1;
    for (let g = Math.ceil(yMin); g <= yMax; g += step) {
      const y = Math.round(py(g)) + 0.5;
      ctx.globalAlpha = g === 0 ? 0.55 : 0.28;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.globalAlpha = 0.75;
      ctx.fillText(`${g} g`, 3 * dpr, y - 2 * dpr);
    }
    ctx.globalAlpha = 1;
  },

  // land_t / onset_t / takeoff_t drawn where they actually sit, so you can see
  // at a glance whether a hump would have cleared them.
  drawThresholds(ctx, py, W, dpr, tok) {
    const lines = [
      ['land_t', tok('--danger', '#FF4D6A')],
      ['onset_t', tok('--bed', '#FF8A3D')],
      ['takeoff_t', tok('--air', '#5CB8FF')],
    ];
    ctx.save();
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.2 * dpr;
    ctx.font = `${10 * dpr}px ${tok('--body', 'system-ui')}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (const [name, colour] of lines) {
      const p = this.params.get(name);
      if (!p) continue;
      const y = Math.round(py(p.value)) + 0.5;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = colour;
      ctx.fillText(`${name} ${p.value}`, W - 4 * dpr, y - 2 * dpr);
    }
    ctx.restore();
  },

  // What state the detector believed it was in, as a wash behind the signal.
  drawStateBands(ctx, px, W, H, dpr, tok) {
    const colours = {
      FLIGHT: 'rgba(92,184,255,.16)',
      CONTACT: 'rgba(255,138,61,.16)',
      REST: 'rgba(255,255,255,.035)',
      UNKNOWN: 'rgba(255,77,106,.13)',
    };
    const st = this.states;
    for (let i = 0; i < st.length; i++) {
      const from = px(st[i].idx);
      const to = i + 1 < st.length ? px(st[i + 1].idx) : W;
      if (to < 0 || from > W) continue;
      ctx.fillStyle = colours[st[i].to] || 'transparent';
      ctx.fillRect(from, 0, Math.max(1, to - from), H);
    }
    for (const g of this.gaps) {
      const x = px(g.at);
      if (x < -10 || x > W + 10) continue;
      ctx.fillStyle = 'rgba(255,77,106,.35)';
      ctx.fillRect(x - 2 * dpr, 0, 4 * dpr, H);
    }
  },

  // The edges the detector actually chose for each jump: the answer to "is the
  // onset backtrack landing in the right place?".
  //
  // Labels are staggered onto three rows and dropped when they would collide,
  // because a run of close jumps otherwise turns the top of the plot into mush
  // exactly when there is most to read.
  drawMarks(ctx, px, H, dpr, tok) {
    ctx.save();
    ctx.lineWidth = 1.5 * dpr;
    ctx.font = `${9 * dpr}px ${tok('--body', 'system-ui')}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const bed = tok('--bed', '#FF8A3D');
    const air = tok('--air', '#5CB8FF');
    const kinds = [
      { key: 'onset', colour: bed, row: 0 },
      { key: 'takeoff', colour: air, row: 1 },
      { key: 'land', colour: bed, row: 2 },
    ];
    const lastLabelX = { onset: -Infinity, takeoff: -Infinity, land: -Infinity };
    const sorted = this.marks.slice().sort((a, b) => a.onset - b.onset);
    for (const m of sorted) {
      for (const { key, colour, row } of kinds) {
        const x = px(m[key]);
        if (x < 0 || x > ctx.canvas.width) continue;
        ctx.strokeStyle = colour;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        const w = ctx.measureText(key).width;
        if (x - lastLabelX[key] < w + 6 * dpr) continue;
        lastLabelX[key] = x;
        ctx.fillStyle = colour;
        ctx.fillText(key, x + 2 * dpr, (2 + row * 11) * dpr);
      }
    }
    ctx.restore();
  },

  drawEvents(ctx, px, H, dpr, tok) {
    ctx.save();
    ctx.font = `${9 * dpr}px ${tok('--body', 'system-ui')}`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (const e of this.events) {
      if (e.type !== 'reject' && e.type !== 'error') continue;
      const x = px(e.idx);
      if (x < 0 || x > ctx.canvas.width) continue;
      const colour = e.type === 'error' ? tok('--danger', '#FF4D6A') : tok('--warn', '#FFC83D');
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.fillText(e.text, x + 2 * dpr, H - 3 * dpr);
    }
    ctx.restore();
  },

  /** Min/max per pixel column once there is more than one sample per pixel —
      otherwise a 400 Hz signal aliases into something that looks calm. */
  trace(ctx, xs, ys, i0, i1, px, py, colour, width, W) {
    if (i1 - i0 < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    const perPixel = (i1 - i0) / W;
    if (perPixel > 1.5) {
      let col = Math.floor(px(xs[i0]));
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i < i1; i++) {
        const c = Math.floor(px(xs[i]));
        if (c !== col) {
          if (lo <= hi) { ctx.moveTo(col + 0.5, py(hi)); ctx.lineTo(col + 0.5, py(lo)); }
          col = c; lo = Infinity; hi = -Infinity;
        }
        const y = ys[i];
        if (Number.isFinite(y)) { if (y < lo) lo = y; if (y > hi) hi = y; }
      }
      if (lo <= hi) { ctx.moveTo(col + 0.5, py(hi)); ctx.lineTo(col + 0.5, py(lo)); }
    } else {
      let started = false;
      for (let i = i0; i < i1; i++) {
        const y = ys[i];
        if (!Number.isFinite(y)) { started = false; continue; }
        const X = px(xs[i]), Y = py(y);
        if (started) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); started = true; }
      }
    }
    ctx.stroke();
  },

  drawCursor(ctx, px, py, W, H, dpr, tok, i0, i1) {
    if (this.cursor == null) return;
    const d = this.d;
    const target = this.view.start + (this.cursor / this.canvas.clientWidth) * this.view.span;
    const i = Math.min(d.idx.length - 1, Math.max(0, lowerBound(d.idx, d.idx.length, target)));
    if (i < 0) return;
    const x = px(d.idx[i]);
    ctx.strokeStyle = tok('--text', '#F3F5FF');
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.globalAlpha = 1;
    const read = document.getElementById('scope-read');
    if (read) {
      const clock = this.periodUs ? fmtClock((d.idx[i] * this.periodUs) / 1000) : '?';
      read.innerHTML =
        `<b>#${d.idx[i]}</b> <span class="dim">${clock}</span> · ` +
        `v <b>${d.v[i].toFixed(3)}</b> · x ${d.ax[i].toFixed(2)} y ${d.ay[i].toFixed(2)} z ${d.az[i].toFixed(2)}`;
    }
  },

  /* ---------- view controls ---------- */
  zoom(factor, anchorFrac = 0.5) {
    const v = this.view;
    const anchor = v.start + v.span * anchorFrac;
    v.span = Math.max(DBG.minSpan, Math.min(DBG.maxSpan, Math.round(v.span * factor)));
    v.start = Math.round(anchor - v.span * anchorFrac);
    v.follow = false;
    this.paint();
    this.renderStatus();
  },
  pan(samples) { this.view.start += samples; this.view.follow = false; this.paint(); this.renderStatus(); },
  follow() { this.view.follow = true; this.paint(); this.renderStatus(); },
  fitY() {
    const d = this.d, n = d.idx.length;
    if (!n) return;
    const i0 = Math.max(0, lowerBound(d.idx, n, this.view.start));
    const i1 = Math.min(n, lowerBound(d.idx, n, this.view.start + this.view.span));
    let lo = Infinity, hi = -Infinity;
    const series = this.show.axes ? ['v', 'ax', 'ay', 'az'] : ['v'];
    for (const k of series) {
      for (let i = i0; i < i1; i++) {
        const y = d[k][i];
        if (!Number.isFinite(y)) continue;
        if (y < lo) lo = y; if (y > hi) hi = y;
      }
    }
    if (!(lo < hi)) return;
    const pad = (hi - lo) * 0.12 || 0.5;
    this.view.yMin = lo - pad;
    this.view.yMax = hi + pad;
    this.paint();
  },

  /* ---------- panels ---------- */
  renderStatus() {
    const el = document.getElementById('scope-status');
    if (!el || !this.enabled) return;
    const n = this.d.idx.length;
    const secs = this.periodUs ? ((this.view.span * this.periodUs) / 1e6).toFixed(2) : '?';
    const mode = this.dumpMode ? `<b>${esc(this.dumpMode)}</b>` : this.armed ? 'waiting for a jump' : 'idle';
    el.innerHTML =
      `${mode} · ${n} samples · window ${secs} s · ` +
      `${this.view.follow ? 'following' : 'held'}${this.gaps.length ? ` · <span class="bad">${this.gaps.length} gap${this.gaps.length === 1 ? '' : 's'}</span>` : ''}`;
  },

  renderLog() {
    if (!this.enabled || typeof S === 'undefined' || S.view !== 'debug') return;
    const el = document.getElementById('dbg-log');
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = this.log.map((l) => {
      const cls = l.dir === 'out' ? 'out' : `in t-${esc(String(l.text).split(',')[0]).slice(0, 2)}`;
      return `<div class="ln ${cls}">${l.dir === 'out' ? '&gt; ' : ''}${esc(l.text)}</div>`;
    }).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  },

  renderParams() {
    if (!this.enabled || typeof S === 'undefined' || S.view !== 'debug') return;
    const el = document.getElementById('dbg-params');
    if (!el) return;
    if (!this.params.size) {
      el.innerHTML = '<p class="dim">Connect the sensor and tap Reload to see its settings.</p>';
      return;
    }
    const rows = [];
    for (const [name, p] of this.params) {
      const changed = Math.abs(p.value - p.def) > 1e-9;
      rows.push(
        `<div class="prow${changed ? ' changed' : ''}">` +
        `<label for="p-${esc(name)}">${esc(name)}</label>` +
        `<input id="p-${esc(name)}" type="number" step="any" inputmode="decimal" value="${p.value}" data-param="${esc(name)}">` +
        `<span class="pmeta">default ${p.def}<br><span class="dim">${p.lo} – ${p.hi}</span></span>` +
        `</div>`);
    }
    el.innerHTML = rows.join('');
  },

  render() {
    this.renderLog();
    this.renderParams();
    this.renderStatus();
    this.paint();
  },

  /* ---------- saving a capture ---------- */
  async save() {
    const n = this.d.idx.length;
    if (!n) { toast('Nothing recorded yet'); return; }
    const params = {};
    for (const [k, v] of this.params) params[k] = v.value;
    const rec = {
      startedAt: new Date().toISOString(),
      deviceName: (typeof S !== 'undefined' && S.deviceName) || null,
      // Tagged with the settings that were live. Without this a day of
      // recordings is a pile of waveforms nobody can attribute to anything.
      params,
      g0: this.g0,
      periodUs: this.periodUs,
      n,
      idx: Int32Array.from(this.d.idx),
      ax: Float32Array.from(this.d.ax),
      ay: Float32Array.from(this.d.ay),
      az: Float32Array.from(this.d.az),
      events: this.events.slice(),
      marks: this.marks.slice(),
      states: this.states.slice(),
      gaps: this.gaps.slice(),
    };
    try {
      await DB.put('captures', rec);
      toast(`Saved ${n} samples`);
      this.renderCaptures();
    } catch (e) {
      console.warn('[debug] save failed', e);
      toast("Couldn't save the capture");
    }
  },

  async renderCaptures() {
    const el = document.getElementById('dbg-captures');
    if (!el || !this.enabled) return;
    let all = [];
    try { all = await DB.all('captures'); } catch (e) { /* store may not exist yet */ }
    all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (!all.length) { el.innerHTML = '<p class="dim">No saved captures yet.</p>'; return; }
    el.innerHTML = all.slice(0, 20).map((c) =>
      `<div class="crow"><span>${esc(fmtTime(c.startedAt))} · ${c.n} samples</span>` +
      `<span class="crow-btns">` +
      `<button type="button" class="btn-small" data-cap-csv="${c.id}">CSV</button>` +
      `<button type="button" class="btn-small" data-cap-del="${c.id}">Delete</button>` +
      `</span></div>`).join('');
  },

  /** The file the offline replay harness eats: the raw signal, plus the
      settings it was recorded under as comment lines. */
  captureCsv(c) {
    const head = [
      `# 2themoon raw capture`,
      `# recorded: ${c.startedAt}`,
      `# sensor: ${c.deviceName || 'unknown'}`,
      `# periodUs: ${c.periodUs}`,
      `# g0: ${(c.g0 || []).join(' ')}`,
    ];
    for (const [k, v] of Object.entries(c.params || {})) head.push(`# param ${k}: ${v}`);
    for (const m of c.marks || []) head.push(`# jump ${m.index}: onset ${m.onset} takeoff ${m.takeoff} land ${m.land}`);
    for (const e of c.events || []) head.push(`# event ${e.idx} ${e.type} ${e.text}`);
    const rows = [...head, 'idx,ax,ay,az,v'];
    for (let i = 0; i < c.n; i++) {
      const v = verticalG(c.ax[i], c.ay[i], c.az[i], c.g0);
      rows.push(`${c.idx[i]},${c.ax[i].toFixed(4)},${c.ay[i].toFixed(4)},${c.az[i].toFixed(4)},${Number.isFinite(v) ? v.toFixed(4) : ''}`);
    }
    return rows.join('\r\n') + '\r\n';
  },

  async exportCapture(id) {
    const c = await DB.get('captures', id);
    if (!c) return;
    const name = `${slug(CONFIG.brandName)}-capture-${slug(c.startedAt)}.csv`;
    const file = new File([this.captureCsv(c)], name, { type: 'text/csv' });
    if (isMobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Saved ${name}`);
  },

  /* ---------- events ---------- */
  wire() {
    const view = document.getElementById('view-debug');
    if (!view) return;

    view.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-dbg]');
      if (!btn) return;
      switch (btn.dataset.dbg) {
        // Only trigger mode stays on after its window is sent; the firmware
        // drops it for any other d command.
        case 'stream':   if (await this.send('d')) this.setArmed(false); break;
        case 'trigger':  if (await this.send('d t')) this.setArmed(true); break;
        case 'once':     if (await this.send('d !')) this.setArmed(false); break;
        case 'stop':     if (await this.send('d 0')) { this.dumpMode = null; this.setArmed(false); } break;
        case 'reload':   this.send('t'); break;
        case 'save-nvs': this.send('t save'); break;
        case 'reset':
          if (await confirmDialog('Reset the sensor to firmware defaults?',
              'Every threshold goes back to the value the firmware shipped with, and the saved settings are cleared.', 'Reset', false)) this.send('t reset');
          break;
        case 'clear':    this.clearSignal(); break;
        case 'clear-log': this.log = []; this.renderLog(); break;
        case 'pause':    this.paused = !this.paused; btn.textContent = this.paused ? 'Resume' : 'Pause'; break;
        case 'blocks':   this.showBlocks = !this.showBlocks; btn.setAttribute('aria-pressed', String(this.showBlocks)); break;
        case 'axes':     this.show.axes = !this.show.axes; btn.setAttribute('aria-pressed', String(this.show.axes)); this.paint(); break;
        case 'zoom-in':  this.zoom(0.5); break;
        case 'zoom-out': this.zoom(2); break;
        case 'follow':   this.follow(); break;
        case 'fit':      this.fitY(); break;
        case 'save':     this.save(); break;
        case 'off':      this.setEnabled(false); break;
      }
      const csv = e.target.closest('[data-cap-csv]');
      if (csv) this.exportCapture(Number(csv.dataset.capCsv));
      const del = e.target.closest('[data-cap-del]');
      if (del) { await DB.del('captures', Number(del.dataset.capDel)); this.renderCaptures(); }
    });

    // Tuning: commit on Enter or on leaving the field, and always re-read the
    // sensor's answer rather than assuming the write landed.
    const params = document.getElementById('dbg-params');
    if (params) {
      const commit = (input) => {
        const name = input.dataset.param;
        const p = this.params.get(name);
        if (!p || input.value === '' || Number(input.value) === p.value) return;
        this.send(`t ${name} ${input.value}`);
      };
      params.addEventListener('change', (e) => { if (e.target.dataset.param) commit(e.target); });
      params.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.param) { e.preventDefault(); commit(e.target); e.target.blur(); } });
    }

    const form = document.getElementById('dbg-cmd-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('dbg-cmd');
        this.send(input.value);
        input.value = '';
      });
    }

    this.wireScope();
  },

  wireScope() {
    const cv = this.canvas;
    if (!cv) return;
    const pointers = new Map();
    let dragFrom = null, pinchFrom = null;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, e.clientX);
      if (pointers.size === 1) dragFrom = { x: e.clientX, start: this.view.start };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchFrom = { dist: Math.abs(a - b), span: this.view.span, start: this.view.start };
        dragFrom = null;
      }
    });

    cv.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) {
        this.cursor = e.clientX - cv.getBoundingClientRect().left;
        this.paint();
        return;
      }
      pointers.set(e.pointerId, e.clientX);
      if (pinchFrom && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.max(10, Math.abs(a - b));
        const span = Math.max(DBG.minSpan, Math.min(DBG.maxSpan, Math.round(pinchFrom.span * (pinchFrom.dist / dist))));
        const mid = (a + b) / 2 - cv.getBoundingClientRect().left;
        const frac = mid / cv.clientWidth;
        const anchor = pinchFrom.start + pinchFrom.span * frac;
        this.view.span = span;
        this.view.start = Math.round(anchor - span * frac);
        this.view.follow = false;
        this.paint(); this.renderStatus();
      } else if (dragFrom) {
        const dx = e.clientX - dragFrom.x;
        this.view.start = Math.round(dragFrom.start - (dx / cv.clientWidth) * this.view.span);
        this.view.follow = false;
        this.paint(); this.renderStatus();
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchFrom = null;
      if (pointers.size === 0) dragFrom = null;
    };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', release);
    cv.addEventListener('pointerleave', () => { this.cursor = null; this.paint(); });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const frac = (e.clientX - cv.getBoundingClientRect().left) / cv.clientWidth;
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, frac);
    }, { passive: false });
  },
};
