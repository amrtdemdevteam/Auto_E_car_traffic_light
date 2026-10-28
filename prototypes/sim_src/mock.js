// T3 junction simulator + mock web API for the click-through demo.
// The page runs the real web UI (app.js / led.js / app.css ... copied in by tools/build_t3_simulator.py);
// this file replaces the Pi: it answers /api/* and runs a JS copy of the controller rules
// (raspberry_pi/trafficlight/t3/controller.py, sensors.py, docs/T3_DESIGN.md) against virtual
// sensors, USB ports and display boards.
'use strict';
(function () {
  const EXAMPLE = window.__T3_EXAMPLE__;      // config/settings.t3.example.json
  const DEFAULTS = window.__T3_DEFAULTS__;    // trafficlight.t3.config.DEFAULTS
  const MAP_SVG = window.__T3_MAP__;
  const FW = window.__T3_FW__ || 't3-1.4.0';  // esp32_display_t3/platformio.ini FIRMWARE_VERSION
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const now = () => performance.now() / 1000;
  const wall = () => Date.now() / 1000;
  window.confirm = () => true;          // artifact frame has no native confirm()

  // ------------------------------------------------------------ virtual hardware
  // Two Waveshare USB TO 4CH RS485 boxes; six TF Mini Plus wired as on site
  // (docs/drawing_src/README.md: C1.1 U1 CH4, C1.2 U1 CH3, C2 U1 CH2, C3 U1 CH1, C4 U2 CH4, C5 U2 CH3).
  const PORTS = [];
  // 2026-10-28: lane 3 off, its sensor (U1 CH1) moved to lane 2 as C2.2; the old C2 is C2.1
  const WIRED = {'1.4': 'C1.1', '1.3': 'C1.2', '1.2': 'C2.1', '1.1': 'C2.2', '2.4': 'C4', '2.3': 'C5'};
  [1, 2].forEach((b) => [0, 1, 2, 3].forEach((c) => PORTS.push({
    path: `/dev/serial/by-path/platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.${b + 1}:1.${c}-port0`,
    label: `USB-485 #${b} · ช่อง ${c + 1}`,
    wired: WIRED[`${b}.${c + 1}`] || null,
    base: [812, 790, 640, 655, 0, 0, 701, 688][(b - 1) * 4 + c],   // floor seen by each wired TF Mini
    covered: false, hold: false, broken: false,
  })));
  PORTS.forEach((p) => { p.connected = true; });   // all 8 channels show up on the Pi; unwired ones give no frames
  function portCm(p, t) {
    if (!p.connected || !p.wired || p.broken) return null;
    const jitter = Math.round(Math.sin(t * 3 + p.base) * 3);
    return (p.covered || p.hold) ? 118 + jitter : p.base + jitter;
  }
  // Display boards B1..B5: online once flashed, powered, and off the USB flashing cable.
  // B6/B7 never exist (the UI lists up to 7 displays).
  const BOARDS = {};
  [1, 2, 3, 4, 5].forEach((n) => { BOARDS[n] = {flashed: false, power: true}; });
  // USB flashing cable: plugged into the next board by itself ~2 s after the wizard opens / after each burn,
  // so the wizard sees a new port (★) and selects it. LAN is always connected: a burnt board comes online.
  const HW = {usbAt: 0};
  const usbIn = () => true;    // all 5 display boards are plugged into the Pi by USB (hardware assembled)
  const DISPLAYS = {};
  function refreshDisplays() {
    for (let n = 1; n <= 7; n++) {
      const b = BOARDS[n];
      DISPLAYS[n] = !!(b && b.flashed && b.power);
    }
  }
  refreshDisplays();

  // ------------------------------------------------------------ server-side data
  let USERS = {};
  let session = null;
  let cfg;                      // saved settings.json
  let versions = [];            // newest first
  let audit = [];
  let layout = {lanes: {}};
  let otaJobs = [];
  function blankCfg() { const c = clone(EXAMPLE); c.lanes = []; c.sensors = {}; return c; }
  // T3 as on site since 2026-10-28: lane 3 off (display stays, dark), C2 -> C2.1, C3 -> C2.2 (lane 2 follow sensor)
  function siteCfg() {
    const c = clone(EXAMPLE);
    c.sensors['C2.1'] = c.sensors.C2 || {}; c.sensors['C2.2'] = c.sensors.C3 || {}; delete c.sensors.C2; delete c.sensors.C3;
    c.lanes.forEach((l) => {
      if (l.id === 2) { l.sensor = 'C2.1'; l.follow_sensor = 'C2.2'; }
      if (l.id === 3) { l.enabled = false; delete l.sensor; }
    });
    return c;
  }

  const merge = (a, b) => { Object.keys(b || {}).forEach((k) => { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = clone(b[k]); }); return a; };
  function withDefaults(c) { return merge(clone(DEFAULTS), c || {}); }
  function kind(l) { return l.type === 'auto' ? 'auto' : (l.type === 'special' || l.mode === 'hand') ? 'special' : 'manual'; }
  function sensorsOf(l) { return (kind(l) === 'auto' ? [l.near_sensor, l.far_sensor] : [l.sensor, l.follow_sensor]).filter(Boolean); }
  const LANE_KEYS = {auto: ['auto_clear_s', 'auto_ticket_expiry_s', 'min_green_s', 'auto_far_merge_s'],
    manual: ['manual_clear_s', 'manual_max_pending', 'min_green_s', 'follow_max_per_round', 'follow_arrive_s'],
    special: ['special_green_s', 'hold_s', 'grace_ms', 'confirm_show_s', 'rearm_clear_s', 'max_pending_per_lane']};
  const validMask = (m) => Number.isInteger(m) && m >= 1 && m <= 31;
  function validate(c) {
    const e = [];
    const lanes = c.lanes || [];
    if (!lanes.length) e.push('ยังไม่มีเลน');
    const disp = new Set(), ports = new Set();
    let autos = 0;
    lanes.forEach((l) => {
      const n = `เลน ${l.id}`;
      if (!['auto', 'manual', 'special'].includes(l.type)) { e.push(`${n}: ประเภทต้องเป็น Auto หรือ Manual`); return; }
      if (kind(l) === 'auto') autos++;
      if (!l.display) e.push(`${n}: ยังไม่ได้เลือกจอ`);
      else if (disp.has(l.display)) e.push(`${n}: จอ B${l.display} ถูกใช้ซ้ำ`);
      disp.add(l.display);
      if ('green_mask' in l && !validMask(l.green_mask)) e.push(`${n}: ทิศลูกศรไฟเขียวต้องเลือกอย่างน้อยหนึ่งทิศ`);
      if (l.follow_sensor && kind(l) !== 'manual') e.push(`${n}: เซนเซอร์ต่อคิวใช้ได้เฉพาะเลน Manual แบบจับรถ`);
      if (l.enabled !== false && kind(l) !== 'auto' && !l.sensor) e.push(`${n}: ต้องเลือกเซนเซอร์`);
      Object.entries(l.params || {}).forEach(([k, v]) => {
        if (!LANE_KEYS[kind(l)].includes(k)) e.push(`${n}: ค่า ${k} ใช้กับเลนประเภทนี้ไม่ได้`);
        else if (!(typeof v === 'number' && v >= 0)) e.push(`${n}: ${k} ต้องเป็นตัวเลขไม่ติดลบ`);
      });
      sensorsOf(l).forEach((sid) => {
        const p = ((c.sensors || {})[sid] || {}).port;
        if (!p) e.push(`${n}: เซนเซอร์ ${sid} ยังไม่ได้เลือกพอร์ต`);
        else if (ports.has(p)) e.push(`${n}: เซนเซอร์ ${sid} ใช้พอร์ตซ้ำกับเลนอื่น`);
        ports.add(p);
      });
    });
    if (autos > 1) e.push('มีเลน Auto ได้ไม่เกินหนึ่งเลน');
    const t = withDefaults(c).timing;
    ['min_green_s', 'auto_far_merge_s'].forEach((k) => { if (!(typeof t[k] === 'number' && t[k] >= 0)) e.push(`timing.${k} ต้องเป็นตัวเลขไม่ติดลบ`); });
    if (t.switch_all_red_s < 0.5) e.push('ช่วงสลับเลนต้องไม่น้อยกว่า 0.5 s');
    if (t.display_fault_timeout_s < t.display_link_timeout_s + 1) e.push('เวลาเผื่อจอเสียต้องไม่น้อยกว่า อายุคำสั่งจอ + 1 s (จอต้องเลิกเขียวเองแน่นอนก่อนเปิดเลนอื่น)');
    return e;
  }
  function flat(d, p = '', o = {}) {
    if (Array.isArray(d)) d.forEach((v, i) => flat(v, p + (v && v.id !== undefined ? v.id : i) + '.', o));
    else if (d && typeof d === 'object') Object.keys(d).forEach((k) => { if (!k.startsWith('_')) flat(d[k], p + k + '.', o); });
    else o[p.slice(0, -1)] = d;
    return o;
  }
  function diff(a, b) {
    const fa = flat(a), fb = flat(b);
    return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()
      .filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map((k) => ({key: k, old: fa[k], new: fb[k]}));
  }
  const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19);
  function logAudit(user, action, detail) { audit.push({t: stamp(), user, action, detail: detail || {}}); audit = audit.slice(-60); }
  function saveCfg(next, user, note) {
    if (!versions.length) versions.unshift({version: 1, user: 'installer', time: stamp(), note: 'ค่าก่อนแก้จากหน้าเว็บ', changes: [], cfg: clone(cfg)});
    const n = versions[0].version + 1;
    const c = clone(next);
    c._version = n;
    versions.unshift({version: n, user, time: stamp(), note, changes: diff(cfg, c), cfg: clone(c)});
    cfg = c;
    logAudit(user, 'config_saved', {version: n, note});
    return n;
  }

  // ------------------------------------------------------------ controller simulation
  class Sensor {
    constructor(id, port, p) { Object.assign(this, {id, port, p}); this.online = false; this.raw = false; this.occupied = false; this.cm = null; this.strength = null; this.lastFrame = null; this.rawSince = null; this.lastRaw = null; this.recoverSince = null; this.ever = false; this.lastClear = null; this.events = []; }
    fresh(t) { return this.lastFrame != null && t - this.lastFrame <= this.p.fresh_timeout_s; }
    step(t) {
      const pt = PORTS.find((x) => x.path === this.port);
      const cm = pt ? portCm(pt, t) : null;
      if (cm != null) {
        if (this.lastFrame != null && t - this.lastFrame > this.p.fresh_timeout_s) { this.recoverSince = null; this.rawSince = null; if (this.occupied) this.lastRaw = t; }   // data gap: debounce / gap hold start again
        this.lastFrame = t; this.cm = cm; this.strength = 900;
        const raw = cm >= this.p.min_detect_cm && cm <= this.p.max_detect_cm;
        this.raw = raw;
        if (!this.online) {
          if (this.recoverSince == null) this.recoverSince = t;
          if (t - this.recoverSince >= this.p.recover_stable_s) {
            this.online = true; this.occupied = false; this.rawSince = null; this.lastRaw = null;
            this.events.push(this.ever ? 'recovered' : 'online'); this.ever = true;
          } else return;
        }
        if (raw) { this.lastRaw = t; if (this.rawSince == null) this.rawSince = t; if (!this.occupied && t - this.rawSince >= this.p.debounce_ms / 1000) { this.occupied = true; this.events.push('rising'); } }
        else this.rawSince = null;
      }
      if (this.online && (this.lastFrame == null || t - this.lastFrame > this.p.offline_timeout_s)) {
        this.online = false; this.occupied = false; this.raw = false; this.recoverSince = null; this.events.push('offline'); return;
      }
      if (this.online && this.occupied && this.fresh(t) && !this.raw && this.lastRaw != null && t - this.lastRaw > this.p.gap_hold_s) {   // clear needs a fresh frame showing nothing
        this.occupied = false; this.lastClear = t; this.prevClear = t; this.events.push('clear');
      }
    }
  }

  let C = null;           // running controller
  function evt(text) { C.events.push({t: wall(), text}); C.events = C.events.slice(-40); }
  function sensorParams(c, sid, l) {
    const own = {...(c.sensors[sid] || {})}; delete own.port;
    const manual = (l.type === 'manual' || l.type === 'special') && sid === l.sensor;   // follow sensor keeps gap_hold_s (1.2 s)
    return {...c.sensor_defaults, ...(manual && !('gap_hold_s' in own) ? {gap_hold_s: c.sensor_defaults.manual_gap_hold_s} : {}), ...own};
  }
  function startController() {
    const c = withDefaults(cfg);
    const errors = validate(cfg);
    C = {cfg: c, errors, state: errors.length ? 'CONFIG_ERROR' : 'STARTING', started: now(), lanes: [], sensors: {}, queue: [], tid: 0,
      active: null, svc: null, barrier: 0, exit: false, events: [], ident: {}, lastServed: null, version: cfg._version || null};
    if (errors.length) return;
    c.lanes.forEach((l) => {
      const p = {...c.timing, ...c.hand, ...(l.params || {})};
      const lane = {id: l.id, name: l.name || '', kind: kind(l), display: l.display, green: l.green_frame || 'GO',
        mask: validMask(l.green_mask) ? l.green_mask : null, p, roundCount: 0,
        follow: kind(l) === 'manual' ? (l.follow_sensor || null) : null,
        near: kind(l) === 'auto' ? l.near_sensor : null, far: kind(l) === 'auto' ? l.far_sensor : null, sensor: kind(l) === 'auto' ? null : l.sensor,
        reasons: new Set(l.enabled === false ? ['config_disabled'] : []), pendingMaint: false, test: 0,
        hand: {phase: 'idle', start: null, seen: null, until: 0}, prio: l.priority || 0};
      lane.sids = [lane.near, lane.far, lane.sensor, lane.follow].filter(Boolean);
      lane.sids.forEach((sid) => { C.sensors[sid] = new Sensor(sid, ((c.sensors[sid] || {}).port) || '', sensorParams(c, sid, l)); });
      C.lanes.push(lane);
    });
    evt('เริ่มระบบควบคุม T3');
  }
  const laneOf = (sid) => C.lanes.find((l) => l.sids.includes(sid));
  const dispOk = (l) => DISPLAYS[l.display];
  const laneOk = (l) => l && !l.reasons.size && dispOk(l);
  function addTicket(lane, k, src, matched = true, expires = null, follow = false) {
    C.queue.push({id: ++C.tid, lane: lane.id, kind: k, created: now(), matched, expires, source: src, follow});
  }
  function ordered() {   // queue.py: Auto first, follower behind its lane's ticket (or next after Auto), priority, age
    const key = (t) => {
      if (t.follow) {
        const own = C.queue.filter((o) => o.lane === t.lane && !o.follow).sort((a, b) => a.id - b.id)[0];
        if (own) return key(own).slice(0, -1).concat([t.id]);
      }
      const prio = C.lanes.find((l) => l.id === t.lane).prio;
      return [t.kind === 'auto' ? 0 : 1, t.follow ? 0 : 1, -prio, t.created, t.id];
    };
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    return C.queue.slice().sort((a, b) => cmp(key(a), key(b)));
  }
  function head(ok) { return ordered().find((t) => ok(C.lanes.find((l) => l.id === t.lane))) || null; }
  function drop(lane) { C.queue = C.queue.filter((t) => t.lane !== lane.id); }
  function disable(lane, r, dropQ) { if (lane.reasons.has(r)) return; lane.reasons.add(r); if (dropQ) drop(lane); lane.hand.phase = 'idle'; evt(`ปิดเลน ${lane.id} (${r})`); }
  function enable(lane, r) { if (lane.reasons.delete(r)) evt(`เปิดเลน ${lane.id} กลับ (${r} หาย)`); }

  function endGreen(reason) {
    const lane = C.lanes.find((l) => l.id === C.active);
    evt(`เลน ${lane.id} จบไฟเขียว (${reason})`);
    C.active = null; C.svc = null; C.state = 'IDLE';
    if (!C.queue.some((q) => q.lane === lane.id)) lane.roundCount = 0;
    if (lane.pendingMaint) { lane.pendingMaint = false; disable(lane, 'maintenance', true); }
  }

  function tick() {
    const t = now();
    refreshDisplays();
    if (!C) return;
    if (C.state === 'CONFIG_ERROR') return;
    // sensors
    Object.values(C.sensors).forEach((s) => {
      s.step(t);
      s.events.splice(0).forEach((kindEv) => onSensor(s, kindEv, t));
    });
    // hands (HandDetector: HOLD for the first half of hold_s, HAND1 "1/2" for the second half, then HANDOK)
    C.lanes.filter((l) => l.kind === 'special' && C.sensors[l.sensor]).forEach((l) => {   // a lane switched off may have no sensor
      const s = C.sensors[l.sensor], h = l.hand;
      if (!s.online) { h.phase = 'idle'; return; }
      const seen = s.raw && s.fresh(t);          // stale frames are never a hand
      if (seen) h.seen = t;
      const accept = !l.reasons.size && C.state !== 'STARTING' && C.queue.filter((q) => q.lane === l.id).length < l.p.max_pending_per_lane;
      if (h.phase === 'idle') { if (seen && accept) { h.phase = 'track'; h.start = t; } }
      else if (h.phase === 'track') {
        if (!(h.seen != null && t - h.seen <= l.p.grace_ms / 1000) || !accept) h.phase = 'idle';
        else if (t - h.start >= l.p.hold_s) { h.phase = 'confirmed'; h.until = t + l.p.confirm_show_s; addTicket(l, 'special', l.sensor); evt(`เลน ${l.id} ค้างมือครบ → ได้ตั๋ว`); }
      } else if (h.phase === 'confirmed') { if (t >= h.until) h.phase = 'rearm'; }
      else if (h.phase === 'rearm') { if (h.seen == null || t - h.seen >= l.p.rearm_clear_s) h.phase = 'idle'; }
    });
    // ticket expiry
    C.queue = C.queue.filter((q) => { if (q.expires && !q.matched && t >= q.expires) { evt(`ตั๋ว Auto #${q.id} หมดอายุ (เซนเซอร์ใกล้ไม่เจอรถ)`); return false; } return true; });
    // display health
    if (C.state !== 'STARTING') C.lanes.forEach((l) => {
      if (dispOk(l)) { enable(l, 'display'); return; }
      if (C.state === 'GREEN' && C.active === l.id) {   // green lane's display stopped answering: stop now, hold others
        endGreen('display_lost');
        C.dispHold = Math.max(C.dispHold || 0, t + C.cfg.timing.display_fault_timeout_s);
        evt(`จอ B${l.display} ไม่ตอบ ปิดเลน ${l.id} · เลนอื่นรอ ${C.cfg.timing.display_fault_timeout_s} s`);
      }
      disable(l, 'display', false);
    });

    if (C.state === 'STARTING' && t - C.started >= C.cfg.timing.startup_min_s) {
      C.lanes.forEach((l) => l.sids.forEach((sid) => { if (!C.sensors[sid].online && !(l.kind === 'auto' && sid === l.far) && sid !== l.follow) disable(l, 'sensor:' + sid, true); }));
      C.state = 'IDLE';
      C.lanes.forEach((l) => { if (l.reasons.size) return; if (l.kind === 'manual' && C.sensors[l.sensor].occupied) { addTicket(l, 'manual', l.sensor); l.roundCount = 1; } if (l.kind === 'auto' && C.sensors[l.near].occupied) addTicket(l, 'auto', l.near); });
      evt('ระบบพร้อม');
    }
    if (C.dispHold && t >= C.dispHold) { C.dispHold = 0; evt('ครบเวลาเผื่อจอเสีย เลนอื่นทำงานต่อได้'); }
    if (C.state === 'GREEN') tickGreen(t);
    if (C.state === 'IDLE' && !C.exit) {
      const h = head(laneOk);
      if (h && !(h.kind === 'auto' && !h.matched)) { C.state = 'SWITCHING'; C.barrier = t; evt(`สลับเลน → เลน ${h.lane} (ทุกจอ X)`); }
    }
    if (C.state === 'SWITCHING' && t - C.barrier >= C.cfg.timing.switch_all_red_s && t >= (C.dispHold || 0)) {
      const h = head(laneOk);
      if (!h || (h.kind === 'auto' && !h.matched)) C.state = 'IDLE';
      else {
        const lane = C.lanes.find((l) => l.id === h.lane);
        C.queue = C.queue.filter((q) => q !== h);
        C.active = lane.id; C.state = 'GREEN';
        C.svc = {started: t, clearSince: null, served: 1, end: lane.kind === 'special' ? t + lane.p.special_green_s : null, arrived: !h.follow};
        evt(`เลน ${lane.id} เขียว (ตั๋ว #${h.id})`);
      }
    }
    if (C.exit && ['IDLE', 'STARTING'].includes(C.state)) { startController(); }
  }
  function tickGreen(t) {
    const lane = C.lanes.find((l) => l.id === C.active), svc = C.svc;
    let done;
    if (lane.kind === 'special') done = t >= svc.end;
    else {
      const s = C.sensors[lane.kind === 'auto' ? lane.near : lane.sensor];
      if (!svc.arrived) {   // follower still driving up to the stop line
        if (s.occupied) svc.arrived = true;
        else { if (t - svc.started >= lane.p.follow_arrive_s) endGreen('follow_not_arrived'); return; }
      }
      if (s.occupied && lane.kind !== 'manual') svc.clearSince = null;      // Auto: the next car keeps the green
      else if (!s.occupied && svc.clearSince == null) svc.clearSince = Math.max(svc.started, s.lastClear || svc.started);
      const hold = lane.kind === 'auto' ? lane.p.auto_clear_s : lane.p.manual_clear_s;
      done = svc.clearSince != null && t - svc.clearSince >= hold;
      if (done && t - svc.started < lane.p.min_green_s) done = false;   // minimum green, even when the sensor lost the vehicle
    }
    if (!done) return;
    if (lane.pendingMaint || lane.reasons.size) { endGreen('lane_closed'); return; }
    const h = head((l) => laneOk(l) || l.id === lane.id);
    if (h && h.lane === lane.id && lane.kind !== 'manual') {      // manual lanes never chain: one vehicle per green
      if (h.kind === 'auto' && !h.matched) return;
      C.queue = C.queue.filter((q) => q !== h);
      svc.served++;
      if (lane.kind === 'special') svc.end = t + lane.p.special_green_s; else { svc.clearSince = null; svc.started = t; }
      evt(`เลน ${lane.id} เขียวต่อ (คันถัดไปของเลนเดิม)`);
      return;
    }
    endGreen('done');
  }
  function onSensor(s, k, t) {
    const lane = laneOf(s.id);
    if (!lane) return;
    const r = 'sensor:' + s.id;
    if (s.id === lane.follow) {   // follow sensor: never closes the lane
      if (k === 'offline') { evt(`เซนเซอร์ต่อคิว ${s.id} เสีย เลน ${lane.id} ใช้ ${lane.sensor} ตัวเดียว`); return; }
      if (k !== 'rising' || lane.reasons.size || C.state === 'STARTING') return;
      const mine = C.queue.filter((q) => q.lane === lane.id);
      if (!mine.length && C.active !== lane.id) return;                                       // lane idle: C2.1 makes the ticket
      if (lane.roundCount >= lane.p.follow_max_per_round || mine.some((q) => q.follow)) return;
      addTicket(lane, 'manual', s.id, true, null, true); lane.roundCount++;
      evt(`${s.id} เจอคันถัดไป → เลน ${lane.id} ได้คิวต่อ`);
      return;
    }
    if (k === 'offline') {
      if (lane.kind === 'auto' && s.id === lane.far) { evt(`${s.id} เสีย เลน ${lane.id} ใช้ ${lane.near} แทรกคิวแทน`); C.queue = C.queue.filter((q) => !(q.lane === lane.id && !q.matched)); return; }
      if (C.state === 'GREEN' && C.active === lane.id && lane.kind !== 'special') {
        endGreen('sensor_fault');          // only this lane stops; the others carry on
        evt(`เซนเซอร์ ${s.id} เสียขณะเลน ${lane.id} เขียว → เลนนี้หยุด เลนอื่นทำงานต่อ`);
      }
      disable(lane, r, true); return;
    }
    if (k === 'recovered' || k === 'online') { if (k === 'recovered') evt(`เซนเซอร์ ${s.id} กลับมาทำงาน`); enable(lane, r); return; }
    if (k !== 'rising' || lane.reasons.size || C.state === 'STARTING') return;
    if (lane.kind === 'manual') { if (C.queue.filter((q) => q.lane === lane.id).length < lane.p.manual_max_pending) { addTicket(lane, 'manual', s.id); lane.roundCount = 1; evt(`${s.id} เจอรถ → เลน ${lane.id} เข้าคิว`); } }
    else if (lane.kind === 'auto' && s.id === lane.far) {
      const expires = t + lane.p.auto_ticket_expiry_s;
      const waiting = C.queue.find((q) => q.lane === lane.id && !q.matched);
      if (waiting) { waiting.expires = Math.max(waiting.expires || 0, expires); return; }   // same Auto seen again: one ticket only
      if (s.lastClear != null && t - s.lastClear < lane.p.auto_far_merge_s) return;        // dolly / body gap: same vehicle
      addTicket(lane, 'auto', s.id, false, expires); evt(`${s.id} เจอ Auto → แทรกหน้าคิว`);
    } else if (lane.kind === 'auto' && s.id === lane.near) {
      const tk = C.queue.find((q) => q.lane === lane.id && !q.matched);
      const serving = C.state === 'GREEN' && C.active === lane.id;
      if (tk) { tk.matched = true; if (serving) { C.queue = C.queue.filter((q) => q !== tk); C.svc.served++; } }
      else if (!serving) addTicket(lane, 'auto', s.id);
    }
  }
  function frameFor(l, t) {
    if (C.state === 'STARTING') return ['START', ''];
    if (C.state === 'GREEN' && C.active === l.id) return l.mask != null ? ['ARROW', String(l.mask)] : [l.green, ''];
    if (l.reasons.has('config_disabled')) return ['MAINT', 'DARK'];   // lane switched off: dark panel
    if (l.reasons.has('maintenance')) return ['MAINT', ''];
    const bad = [...l.reasons].filter((r) => r.startsWith('sensor:')).map((r) => r.slice(7)).sort();
    if (bad.length) return ['SENSOR', bad[0]];
    if (l.test > t) return ['TEST', 'B' + l.display];
    if (l.kind === 'special') {
      const h = l.hand;
      if (h.phase === 'track') return [t - h.start < l.p.hold_s / 2 ? 'HOLD' : 'HAND1', ''];
      if (h.phase === 'confirmed') return ['HANDOK', ''];
      if ((C.cfg.frames.enabled_reserve || []).includes('STOPHINT')) return ['STOPHINT', ''];
    }
    if (C.queue.some((q) => q.lane === l.id)) return ['STOP', 'Q'];   // X + blue dot: waiting its turn
    return ['STOP', ''];
  }
  function command(cmd) {
    const t = now();
    const user = cmd.user;
    if (cmd.cmd === 'identify') {
      const n = cmd.display;
      if (C.state !== 'CONFIG_ERROR') {
        const owner = C.lanes.find((l) => l.display === n);
        if (owner && (C.active === owner.id || C.state === 'SWITCHING')) return 'จอนี้กำลังใช้งานอยู่ ทดสอบได้เมื่อเลนนั้นไม่เขียว';
        if (owner) { owner.test = t + 5; return `จอ B${n} แสดง TEST`; }
      }
      C.ident[n] = t + 5; return `จอ B${n} แสดง TEST`;
    }
    if (cmd.cmd === 'apply_config' || cmd.cmd === 'restart') {
      if (C.state === 'CONFIG_ERROR') { startController(); return 'เริ่มใหม่'; }
      C.exit = true; evt(`${user} สั่ง${cmd.cmd === 'apply_config' ? 'ใช้ค่าใหม่' : 'รีสตาร์ต'} รอให้แยกว่าง`); return 'จะรีสตาร์ตเมื่อแยกว่าง';
    }
    const lane = C.lanes.find((l) => l.id === cmd.lane);
    if (!lane) return 'ไม่รู้จักเลน';
    if (cmd.cmd === 'maintenance') {
      if (cmd.on) { if (C.active === lane.id) { lane.pendingMaint = true; return 'จะปิดเมื่อจบไฟเขียว'; } disable(lane, 'maintenance', true); }
      else { lane.pendingMaint = false; enable(lane, 'maintenance'); }
      return 'ok';
    }
    if (cmd.cmd === 'clear_queue') { const n = C.queue.filter((q) => q.lane === lane.id).length; drop(lane); evt(`${user} เคลียร์คิว ${n} ใบ`); return 'ok'; }
    if (cmd.cmd === 'test_display') { lane.test = t + 5; return 'ok'; }
    return 'ไม่รู้จักคำสั่ง';
  }
  function status() {
    const t = now();
    const ports = PORTS.filter((p) => p.connected).map((p) => {
      const sid = C && C.sensors ? Object.values(C.sensors).find((s) => s.port === p.path) : null;
      const cm = portCm(p, t);
      return {path: p.path, label: p.label, sensor: sid ? sid.id : null, cm, strength: cm == null ? null : 900, age_s: cm == null ? null : 0.1};
    });
    const base = {junction_id: cfg.junction_id, junction_name: cfg.junction_name, config_version: C.version, ports};
    if (C.state === 'CONFIG_ERROR') {
      return {...base, state: 'CONFIG_ERROR', errors: C.errors, lanes: [], queue: [], sensors: [], events: []};
    }
    return {...base, state: C.state, active_lane: C.active, green_served: C.svc ? C.svc.served : 0, exit_requested: C.exit,
      lanes: C.lanes.map((l) => { const [f, a] = frameFor(l, t); return {id: l.id, name: l.name, type: l.kind, display: l.display, sensors: l.sids, follow_sensor: l.follow,
        enabled: !l.reasons.size, reasons: [...l.reasons].sort(), frame: f, arg: a, green: C.active === l.id,
        tickets: C.queue.filter((q) => q.lane === l.id).length, hand: l.kind === 'special' ? l.hand.phase : null,
        display_online: dispOk(l), display_ack_age_s: dispOk(l) ? 0.2 : null, display_fw: dispOk(l) ? FW : null}; }),
      queue: ordered().map((q) => ({id: q.id, lane: q.lane, kind: q.kind, matched: q.matched, follow: !!q.follow, source: q.source, age_s: +(t - q.created).toFixed(1)})),
      sensors: Object.values(C.sensors).map((s) => ({id: s.id, online: s.online, raw: s.raw, occupied: s.occupied, distance_cm: s.cm, strength: s.strength})),
      events: C.events.slice(-20)};
  }
  // what each physical display B1..B5 shows right now (drawn in the simulator panel)
  function physical(n, t) {
    if (!DISPLAYS[n]) return null;
    if (C.state !== 'CONFIG_ERROR') {
      const l = C.lanes.find((x) => x.display === n);
      if (l) return frameFor(l, t);
    }
    const u = C.ident[n] || 0;
    if (u > t) return ['TEST', 'B' + n];
    return (cfg.displays || {})[String(n)] ? ['CONFIG', ''] : ['LINKWAIT', ''];
  }
  setInterval(tick, 50);

  // ------------------------------------------------------------ mock HTTP API
  // JS mirror of raspberry_pi/trafficlight/t3/flowstats.py (the real one runs in the web service)
  const SimFlow = (() => {
    const blank = () => ({greens: 0, green_s: 0, green_max_s: 0, green_min_s: null, requests: 0, served: 0, expired: 0, wait_sum_s: 0, wait_max_s: 0, queue_peak: 0, queued_s: 0, unavailable_s: 0, faults: 0});
    let F, prev = null, prevT = null, greenSince = null, tickets = {}, faulted = new Set();
    const reset = (t) => { F = {since: t, total_s: 0, allred_s: 0, fault_s: 0, idle_s: 0, gaps: 0, lanes: {}}; prev = null; prevT = null; greenSince = null; tickets = {}; faulted = new Set(); };
    const ln = (id) => (F.lanes[id] = F.lanes[id] || blank());
    const endGreen = (now) => { const p = prev && prev.active_lane; if (p != null && greenSince != null) { const d = Math.max(0, now - greenSince), l = ln(p); l.green_max_s = Math.max(l.green_max_s, d); l.green_min_s = l.green_min_s == null ? d : Math.min(l.green_min_s, d); } greenSince = null; };
    function feed(st, now) {
      let dt = prevT == null ? 0 : Math.max(0, now - prevT);
      if (dt > 5) { F.gaps++; dt = 0; endGreen(prevT); tickets = {}; prev = null; }
      if (st.state === 'CONFIG_ERROR') dt = 0;
      F.total_s += dt;
      if (st.state === 'SWITCHING') F.allred_s += dt; else if (st.state === 'FAULT_HOLD') F.fault_s += dt; else if (st.state === 'IDLE' && !(st.queue || []).length) F.idle_s += dt;
      const active = st.active_lane, pa = prev ? prev.active_lane : null;
      if (active !== pa) { if (pa != null) endGreen(now); if (active != null) { greenSince = now; ln(active).greens++; } }
      if (active != null) ln(active).green_s += dt;
      const seen = new Set(), pq = {};
      (st.queue || []).forEach((t) => { seen.add(t.id); pq[t.lane] = (pq[t.lane] || 0) + 1; if (!tickets[t.id]) { tickets[t.id] = {lane: t.lane, age: t.age_s || 0}; ln(t.lane).requests++; } else tickets[t.id].age = t.age_s || 0; });
      Object.keys(tickets).filter((k) => !seen.has(Number(k))).forEach((k) => { const r = tickets[k]; delete tickets[k]; const l = ln(r.lane); if (active === r.lane || pa === r.lane) { l.served++; l.wait_sum_s += r.age; l.wait_max_s = Math.max(l.wait_max_s, r.age); } else l.expired++; });
      Object.entries(pq).forEach(([id, n]) => { const l = ln(id); l.queue_peak = Math.max(l.queue_peak, n); l.queued_s += dt; });
      (st.lanes || []).forEach((x) => { const l = ln(x.id), rs = x.reasons || []; if (x.enabled === false || rs.length) l.unavailable_s += dt; rs.forEach((r) => { if (r === 'maintenance') return; const key = x.id + '|' + r; if (!faulted.has(key)) { faulted.add(key); l.faults++; } }); faulted.forEach((k) => { const [i, r] = k.split('|'); if (i == x.id && !rs.includes(r)) faulted.delete(k); }); });
      prev = st; prevT = now;
    }
    function summary() {
      const hours = F.total_s / 3600, all = Object.values(F.lanes).reduce((a, l) => a + l.green_s, 0), out = {};
      Object.entries(F.lanes).forEach(([id, l]) => { out[id] = {greens: l.greens, green_s: l.green_s, green_avg_s: l.greens ? l.green_s / l.greens : null, green_min_s: l.green_min_s, green_max_s: l.green_max_s, green_share: F.total_s ? l.green_s / F.total_s : 0, green_of_all: all ? l.green_s / all : 0, requests: l.requests, served: l.served, expired: l.expired, wait_avg_s: l.served ? l.wait_sum_s / l.served : null, wait_max_s: l.wait_max_s, queue_peak: l.queue_peak, queued_s: l.queued_s, unavailable_s: l.unavailable_s, faults: l.faults, served_per_hour: hours > 0.01 ? Math.round(l.served / hours * 10) / 10 : null}; });
      return {since: F.since, total_s: F.total_s, allred_s: F.allred_s, fault_s: F.fault_s, idle_s: F.idle_s, gaps: F.gaps, lanes: out};
    }
    reset(Date.now() / 1000);
    return {feed, summary, reset};
  })();
  const J = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}}));
  // ---- first-run wizard (web/flasher.py runs esptool on the Pi; here the USB cable is a panel switch)
  const WZ_PORTS = [0, 1, 2, 3, 4].map((i) => ({path: `/dev/ttyACM${i}`, label: `usb-Espressif_USB_JTAG_serial_debug_unit_F4:12:FA:5C:21:0${i}-if00`}));
  const WZ_PORT = WZ_PORTS[0];
  let wzJob = null, wzDone = false;
  const wzFlashed = {};
  const wzPorts = () => WZ_PORTS;
  const wzStatus = () => ({show_wizard: !wzDone && !((cfg.lanes || []).length), done: wzDone, flashed: wzFlashed,
    displays: [1, 2, 3, 4, 5], firmware: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), {ok: true, missing: []}])),
    ports: wzPorts(), job: wzJob ? {...wzJob, log: wzJob.log.slice()} : null});
  // esptool output, as web/flasher.py shows it (percent parsed from "( NN %)")
  const ESPTOOL = (port) => [
    ['esptool.py v4.8.1', 0.2], [`Serial port ${port}`, 0.2], ['Connecting....', 1.0], ['Chip is ESP32-S3 (QFN56) (revision v0.2)', 0.2],
    ['Features: WiFi, BLE, Embedded PSRAM 8MB (AP_3v3)', 0.1], ['Crystal is 40MHz', 0.1], ['MAC: f4:12:fa:5c:21:08', 0.1],
    ['Uploading stub...', 0.3], ['Running stub...', 0.2], ['Stub running...', 0.2], ['Changing baud rate to 460800', 0.2], ['Changed.', 0.4],
    ...[['0x00000000', 'bootloader.bin', 3], ['0x00008000', 'partitions.bin', 1], ['0x0000e000', 'boot_app0.bin', 1], ['0x00010000', 'firmware.bin', 20]]
      .flatMap(([a, f, n]) => [[`Compressed data for ${f}...`, 0.1],
        ...Array.from({length: n}, (_, i) => [`Writing at ${a}... (${Math.round((i + 1) * 100 / n)} %)`, 0.35]),
        [`Wrote ${f} at ${a}`, 0.1], ['Hash of data verified.', 0.2]]),
    ['Leaving...', 0.2], ['Hard resetting via RTS pin...', 0.3]];
  function runFlash(j) {
    const lines = ESPTOOL(j.port);
    let i = 0;
    const next = () => {
      if (!usbIn()) { j.state = 'error'; j.message = 'ไม่สำเร็จ (รหัส 2) กดปุ่ม BOOT ค้าง เสียบสายใหม่ แล้วลองอีกครั้ง'; j.log = j.log.concat([`A fatal error occurred: Could not open ${j.port}, the port doesn't exist`]).slice(-30); return; }
      if (i >= lines.length) {
        j.state = 'ok'; j.percent = 100; j.message = 'สำเร็จ ถอดสาย USB แล้วปิด-เปิดไฟจอ';
        wzFlashed[String(j.display)] = {t: Math.floor(Date.now() / 1000), port: j.port};
        BOARDS[j.display].flashed = true; renderPanel();
        return;
      }
      const [line, dt] = lines[i++];
      j.log = j.log.concat([line]).slice(-30);
      const m = /(\d+(?:\.\d+)?)\s?%/.exec(line);
      if (m) { j.percent = Math.min(100, Number(m[1])); j.message = 'กำลังลงโปรแกรม'; }
      setTimeout(next, dt * 1000);
    };
    next();
  }
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
// Absolute paths like /api/me are used as-is: on Windows file:// new URL() would turn them into /C:/api/me
    const raw = typeof url === 'string' ? url : String((url && url.url) || url);
    const path = raw.charAt(0) === '/' ? raw.split('#')[0].split('?')[0] : new URL(raw, location.href).pathname;
    const method = (opts.method || 'GET').toUpperCase();
    if (path.endsWith('/static/maps/T3.svg') || path === '/static/maps/T3.svg') return new Response(MAP_SVG, {status: 200, headers: {'Content-Type': 'image/svg+xml'}});
    if (!path.startsWith('/api/')) return origFetch(url, opts);
    await new Promise((r) => setTimeout(r, 40));
    let body = {};
    if (opts.body && typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch (e) { body = {}; } }
    const me = session;
    if (path === '/api/me') return J(me ? {user: me.user, role: me.role, icon: (USERS[me.user] || {}).icon || '', sim: false} : {user: null, setup_needed: !Object.keys(USERS).length});
    if (path === '/api/setup/first-user' && method === 'POST') {
      if (Object.keys(USERS).length) return J({error: 'มีบัญชีผู้ใช้แล้ว'}, 403);
      const name = String(body.user || '').trim(), pw = String(body.password || '');
      if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return J({error: 'ชื่อผู้ใช้ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข - _ .'}, 400);
      if (pw.length < 8) return J({error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'}, 400);
      USERS[name] = {pw, role: 'editor', created: stamp().slice(0, 10)};
      logAudit(name, 'first_user_created', {ip: '127.0.0.1'});
      session = {user: name, role: 'editor'}; renderPanel(); return J({ok: true});
    }
    if (path === '/api/login' && method === 'POST') {
      const u2 = USERS[body.user];
      if (!u2 || u2.pw !== body.password) { logAudit(body.user || '?', 'login_failed'); return J({error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'}, 401); }
      session = {user: body.user, role: u2.role}; logAudit(body.user, 'login'); renderPanel(); return J({ok: true});
    }
    if (path === '/api/logout') { session = null; renderPanel(); return J({ok: true}); }
    if (!me) return J({error: 'กรุณาเข้าสู่ระบบ'}, 401);
    const editor = me.role === 'editor';
    if (method === 'GET') {
      if (path === '/api/flow') return J(SimFlow.summary());
      if (path === '/api/state') return J({state: (() => { const s = status(); SimFlow.feed(s, Date.now() / 1000); return s; })(), age_s: 0.2, stale: false, ota: otaJobs,
        displays: Object.fromEntries(Object.entries(DISPLAYS).filter(([k]) => BOARDS[k] && BOARDS[k].flashed).map(([k, v]) => [k, v ? 'online' : 'offline']))});
      if (path === '/api/config') return J({config: cfg, errors: validate(cfg), defaults: withDefaults({})});
      if (path === '/api/versions') return J({versions: versions.map(({cfg: _c, ...v}) => v)});
      if (path === '/api/setup/status') return J(wzStatus());
      if (path === '/api/ports') return J({ports: PORTS.filter((p) => p.connected).map((p) => ({path: p.path, label: p.label}))});
      if (path === '/api/layout') return J(layout);
      if (path === '/api/drawing') { if (drawing === null) drawing = {items: drawingSeed && window.T3_STARTER ? window.T3_STARTER() : []}; return J(drawing); }
      if (path === '/api/template') { const t = clone(EXAMPLE); return J({lanes: t.lanes, displays: t.displays, sensors: Object.fromEntries(Object.keys(t.sensors).map((k) => [k, {port: ''}]))}); }
      if (path === '/api/map') return J({error: 'ใช้แผนที่เริ่มต้น'}, 404);
      if (path === '/api/users') return editor ? J({users: Object.entries(USERS).map(([name, v]) => ({name, role: v.role, created: v.created, icon: v.icon || ''})), audit: audit.slice(-40).reverse()}) : J({error: 'บัญชีนี้ดูได้อย่างเดียว'}, 403);
      return J({error: 'ไม่พบ'}, 404);
    }
    if (!editor) return J({error: 'บัญชีนี้ดูได้อย่างเดียว'}, 403);
    if (path === '/api/config') {
      const errs = validate(body.config);
      if (errs.length) return J({error: 'ค่าไม่ถูกต้อง', errors: errs}, 422);
      const n = saveCfg(body.config, me.user, body.note || '');
      command({cmd: 'apply_config', user: me.user}); renderPanel();
      return J({version: n});
    }
    if (path === '/api/rollback') {
      const v = versions.find((x) => x.version === body.version);
      const n = saveCfg(v.cfg, me.user, `ย้อนกลับไป v${body.version}`);
      command({cmd: 'apply_config', user: me.user}); renderPanel();
      return J({version: n});
    }
    if (path === '/api/flow/reset') { SimFlow.reset(Date.now() / 1000); return J(SimFlow.summary()); }
    if (path === '/api/control') { logAudit(me.user, 'control', body); return J({ok: true, result: command({...body, user: me.user})}); }
    if (path === '/api/layout') { layout = clone(body); logAudit(me.user, 'layout_saved'); return J(layout); }
    if (path === '/api/drawing') { drawing = {items: clone(body.items || [])}; logAudit(me.user, 'drawing_saved'); return J(drawing); }
    if (path === '/api/map' || path === '/api/map/reset') return J({error: 'ตัวจำลองนี้เปลี่ยนรูปแผนที่ไม่ได้ (บน Pi จริงทำได้)'}, 400);
    if (path === '/api/setup/flash') {
      if (wzJob && wzJob.state === 'running') return J({error: 'กำลังลงโปรแกรมจออื่นอยู่ รอให้เสร็จก่อน'}, 409);
      const n = Number(body.display);
      if (!(n >= 1 && n <= 5)) return J({error: `ไม่มีจอ ${body.display}`}, 400);
      if (!wzPorts().some((p) => p.path === body.port)) return J({error: 'ไม่พบพอร์ตนี้ กดรีเฟรชแล้วเลือกใหม่'}, 400);
      wzJob = {display: n, port: body.port, state: 'running', percent: 0, log: [], message: 'กำลังเชื่อมต่อ'};
      logAudit(me.user, 'flash_display_' + n);
      runFlash(wzJob);
      return J({job: {...wzJob}}, 202);
    }
    if (path === '/api/setup/done') { wzDone = true; return J({ok: true}); }
    if (path === '/api/reboot') { if (C.active != null) return J({error: 'มีเลนเขียวอยู่ รอให้แยกว่างแล้วกดอีกครั้ง'}, 409); logAudit(me.user, 'reboot_pi'); startController(); return J({ok: true}); }
    if (path.startsWith('/api/ota/')) {
      const d = Number(path.split('/').pop());
      const job = {display: d, running: true, step: 'ปิดเลนก่อนอัปเดต', ok: null};
      otaJobs = otaJobs.filter((j) => j.display !== d).concat([job]);
      const lane = C.lanes.find((l) => l.display === d);
      if (lane) command({cmd: 'maintenance', lane: lane.id, on: true, user: me.user});
      setTimeout(() => { job.step = 'กำลังส่งไฟล์ไปที่จอ'; }, 1500);
      setTimeout(() => { job.step = 'จอกำลังรีบูตด้วยเฟิร์มแวร์ใหม่'; }, 4000);
      setTimeout(() => { job.step = 'เสร็จ · เลนยังปิดอยู่ ตรวจภาพบนจอแล้วกด “เปิดเลน”'; job.ok = true; job.running = false; }, 8000);
      return J({message: 'เริ่มอัปเดตแล้ว'}, 202);
    }
    if (path === '/api/me/icon') { USERS[me.user].icon = String(body.icon || '').startsWith('data:image') ? String(body.icon).slice(0, 40000) : String(body.icon || '').slice(0, 8); return J({ok: true, icon: USERS[me.user].icon}); }
    if (path === '/api/users') {
      if (body.password !== undefined && body.password !== null && body.password !== '' && String(body.password).length < 8) return J({error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'}, 400);
      const u3 = USERS[body.name] || {pw: '', role: 'viewer', created: stamp().slice(0, 10)};
      if (body.password) u3.pw = body.password;
      if (body.role) u3.role = body.role;
      if (body.icon !== undefined) u3.icon = String(body.icon).startsWith('data:image') ? String(body.icon).slice(0, 40000) : String(body.icon).slice(0, 8);
      USERS[body.name] = u3; logAudit(me.user, 'user_set', {name: body.name}); return J({ok: true});
    }
    if (path === '/api/users/delete') { if (body.name === me.user) return J({error: 'ลบบัญชีตัวเองไม่ได้'}, 400); delete USERS[body.name]; return J({ok: true}); }
    return J({error: 'ไม่พบ'}, 404);
  };

  // ------------------------------------------------------------ scenario helpers
  const timers = [];
  function later(s, fn) { timers.push(setTimeout(fn, s * 1000)); }
  function portOfSensor(sid) { const p = ((cfg.sensors || {})[sid] || {}).port; return PORTS.find((x) => x.path === p); }
  function pulse(sid, at, dur) { later(at, () => { const p = portOfSensor(sid); if (p) p.covered = true; }); later(at + dur, () => { const p = portOfSensor(sid); if (p) p.covered = false; }); }
  function scenarios() {
    const hold = withDefaults(cfg).hand.hold_s;
    return (cfg.lanes || []).filter((l) => l.enabled !== false).flatMap((l) => {
      const k = kind(l);
      if (k === 'manual' && l.follow_sensor) return [[`car${l.id}`, `รถเข้าเลน ${l.id}`, 'จอดทับเซนเซอร์ 4 s แล้วขับผ่าน', () => pulse(l.sensor, 0, 4)],
        [`two${l.id}`, `รถ 2 คันต่อกัน เลน ${l.id}`, `คันที่ 2 ผ่าน ${l.follow_sensor} แล้วรอที่ ${l.sensor}`, () => { pulse(l.sensor, 0, 4); pulse(l.follow_sensor, 1, 2); pulse(l.sensor, 5, 12); }]];
      if (k === 'auto') return [[`auto${l.id}`, `รถ Auto เลน ${l.id}`, 'ผ่าน C ไกล แล้วถึง C ใกล้ใน 3 s', () => { pulse(l.far_sensor, 0, 1.0); pulse(l.near_sensor, 3, 4); }]];
      if (k === 'special') return [[`hand${l.id}`, `ยื่นมือเลน ${l.id}`, `ค้างมือ ${hold + 0.5} s`, () => pulse(l.sensor, 0, hold + 0.5)]];
      return [[`car${l.id}`, `รถเข้าเลน ${l.id}`, 'จอดทับเซนเซอร์ 4 s แล้วขับผ่าน', () => pulse(l.sensor, 0, 4)]];
    });
  }
  let drawing = null, drawingSeed = false;
  function loadReady() {
    const c = siteCfg();
    Object.keys(c.sensors).forEach((sid) => { const p = PORTS.find((x) => x.wired === sid); c.sensors[sid].port = p ? p.path : ''; });
    cfg = c; cfg._version = 2; versions = [];
    versions.unshift({version: 2, user: 'engineer01', time: stamp(), note: 'ตั้งค่าเริ่มต้น', changes: [], cfg: clone(cfg)});
    versions.push({version: 1, user: 'installer', time: stamp(), note: 'ค่าก่อนแก้จากหน้าเว็บ', changes: [], cfg: blankCfg()});
    const at = {1: [580, 315], 2: [460, 315], 3: [372, 282], 4: [580, 272], 5: [700, 272]};
    layout = {lanes: {}}; drawing = null; drawingSeed = true;
    Object.entries(at).forEach(([id, [x, y]]) => { layout.lanes[id] = {x: (x - 20) / 840, y: (y - 10) / 585, rot: id === '3' ? 90 : 0}; });
    USERS = {engineer01: {pw: 'password1', role: 'editor', created: '2026-09-28'}, operator01: {pw: 'password2', role: 'viewer', created: '2026-09-28'}};
    Object.values(BOARDS).forEach((b) => { b.flashed = true; b.power = true; });
    [1, 2, 3, 4, 5].forEach((n) => { wzFlashed[String(n)] = {t: Math.floor(Date.now() / 1000), port: WZ_PORT.path}; });
    HW.usbAt = 0; wzDone = true; wzJob = null;
    startController();
  }
  // a new junction straight out of the box: no account, boards not flashed, no lanes
  function resetAll() {
    cfg = blankCfg(); versions = []; audit = []; layout = {lanes: {}}; drawing = null; drawingSeed = false;
    USERS = {}; session = null; wzDone = false; wzJob = null; HW.usbAt = 0;
    Object.keys(wzFlashed).forEach((k) => delete wzFlashed[k]);
    Object.values(BOARDS).forEach((b) => { b.flashed = false; b.power = true; });
    PORTS.forEach((p) => { p.covered = p.hold = p.broken = false; });
    try { localStorage.removeItem('t3draft'); } catch (e) { /* ignore */ }
    startController();
  }

  // ------------------------------------------------------------ simulator panel
  const panel = document.createElement('aside');
  panel.id = 'simpanel';
  panel.setAttribute('aria-label', 'แผงจำลอง');
  document.body.appendChild(panel);
  let open = true, tab = 'hw', lastUsb = '';
  async function relogin(user) {
    session = {user, role: USERS[user].role};
    if (typeof S !== 'undefined') { S.edit = null; S.draft = null; S.page = 'map'; }
    if (typeof start === 'function') await start();
    renderPanel();
  }
  async function reloadApp() {
    if (typeof S !== 'undefined') { S.edit = null; S.draft = null; S.finder = null; S.wiz = null; S.me = null; }
    if (typeof start === 'function') await start();
    renderPanel();
  }
  const BOARD_ST = (n) => { const b = BOARDS[n]; return !b.power ? 'ปิดไฟ' : !b.flashed ? 'ยังไม่ลงโปรแกรม' : 'ออนไลน์'; };
  function renderPanel() {
    const t = now();
    if (!open) { panel.className = 'closed'; panel.innerHTML = '<button class="sim-open" data-sim="open">▲ แผงจำลอง</button>'; return; }
    panel.className = '';
    const who = session ? `${session.user} · ${session.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'}` : 'ยังไม่เข้าสู่ระบบ';
    const tabs = [['hw', 'ฮาร์ดแวร์'], ['drive', 'จำลองรถ'], ['who', 'ผู้ใช้/รีเซ็ต']];
    let body = '';
    if (tab === 'drive') {
      const sc = scenarios();
      body = sc.length ? `<div class="sim-grid">${sc.map(([id, label, help]) => `<button class="sim-btn" data-sim="sc" data-id="${id}"><b>${label}</b><small>${help}</small></button>`).join('')}</div>
        <p class="sim-note">หรือไปแท็บ ฮาร์ดแวร์ แล้วกด “บัง” ค้างไว้ที่เซนเซอร์เอง</p>`
        : '<p class="sim-note">ยังไม่มีเลน · ตั้งค่าเลนในหน้าเว็บก่อน หรือกด “ข้ามไปผัง T3 พร้อมใช้” ในแท็บ ผู้ใช้/รีเซ็ต</p>';
    } else if (tab === 'hw') {
      const usbNote = 'บอร์ดจอ 5 ตัวเสียบ USB อยู่ที่ /dev/ttyACM0 ถึง ttyACM4 · เลือกจอและพอร์ตในหน้าลงโปรแกรมจอ';
      body = `<div class="sim-row"><b>สาย USB ลงโปรแกรมจอ</b><span class="sim-note">${usbNote}</span></div>
        <div class="sim-row"><b>LAN</b><span class="sim-note">จอทั้ง 5 ต่อสาย LAN แล้ว · ลงโปรแกรมเสร็จจะออนไลน์เอง</span></div>
        <div class="sim-row"><b>จอ</b>${[1, 2, 3, 4, 5].map((n) => `<label class="sim-chk" title="${BOARD_ST(n)}"><input type="checkbox" data-sim="power" data-n="${n}" ${BOARDS[n].power ? 'checked' : ''}>B${n} <small class="mut">${BOARD_ST(n)}</small></label>`).join('')}</div>
        <table class="sim-t"><tr><th>เซนเซอร์</th><th>พอร์ต</th><th>ระยะ</th><th></th></tr>${PORTS.map((p, i) => [p, i]).filter(([p]) => p.wired)
        .sort(([a], [b]) => a.wired.localeCompare(b.wired, 'en', {numeric: true})).map(([p, i]) => {
        const cm = portCm(p, t);
        return `<tr><td class="mono">${p.wired}</td><td>${p.label.replace('USB-485 ', '')}</td><td class="mono" data-simcm="${i}">${cm == null ? '—' : cm + ' cm'}</td>
          <td class="sim-acts"><button class="sim-mini ${p.covered ? 'on' : ''}" data-sim="cover" data-i="${i}" title="กดค้าง = เอามือ/รถบังเซนเซอร์">บัง</button>
          <button class="sim-mini ${p.hold ? 'on' : ''}" data-sim="hold" data-i="${i}" title="บังค้างไว้จนกดอีกครั้ง">ค้าง</button>
          <button class="sim-mini ${p.broken ? 'bad' : ''}" data-sim="break" data-i="${i}" title="ถอดสาย / เซนเซอร์เสีย">เสีย</button></td></tr>`;
      }).join('')}</table>`;
    } else {
      const logins = Object.entries(USERS).filter(([, v]) => v.pw).map(([u, v]) => `<button class="sim-btn" data-sim="as" data-u="${u}"><b>เข้าเป็น ${u}</b><small>${v.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'}</small></button>`).join('');
      body = `<div class="sim-grid">${logins}
        <button class="sim-btn" data-sim="ready"><b>ข้ามไปผัง T3 พร้อมใช้</b><small>5 เลน ผูกพอร์ตและวางบนแผนที่แล้ว</small></button>
        <button class="sim-btn" data-sim="reset"><b>เริ่มใหม่ทั้งหมด</b><small>เหมือนติดตั้งใหม่: ยังไม่มีบัญชี จอยังไม่ลงโปรแกรม</small></button></div>`;
    }
    const phys = [1, 2, 3, 4, 5].map((n) => `<figure><canvas width="128" height="64" data-phys="${n}" aria-label="จอจริง B${n}"></canvas><figcaption>B${n}</figcaption></figure>`).join('');
    panel.innerHTML = `<div class="sim-head"><b>แผงจำลอง</b><span>${who}</span><button class="sim-x" data-sim="close" aria-label="ย่อแผงจำลอง">▼</button></div>
      <div class="sim-disp" title="ภาพบนจอจริงที่หน้างาน">${phys}</div>
      <div class="sim-tabs">${tabs.map(([id, l]) => `<button class="${tab === id ? 'on' : ''}" data-sim="tab" data-t="${id}">${l}</button>`).join('')}</div>
      <div class="sim-body">${body}</div>
      <p class="sim-foot">ส่วนนี้ไม่ใช่หน้าเว็บจริง · แทนรถ เซนเซอร์ จอ และสาย USB · ค่าไม่ถูกเก็บ</p>`;
  }
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sim]');
    if (!b) return;
    const a = b.dataset.sim;
    if (a === 'open') { open = true; renderPanel(); }
    else if (a === 'close') { open = false; renderPanel(); }
    else if (a === 'tab') { tab = b.dataset.t; renderPanel(); }
    else if (a === 'sc') { const s = scenarios().find((x) => x[0] === b.dataset.id); if (s) s[3](); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 600); }
    else if (a === 'hold') { const p = PORTS[Number(b.dataset.i)]; p.hold = !p.hold; renderPanel(); }
    else if (a === 'break') { const p = PORTS[Number(b.dataset.i)]; p.broken = !p.broken; renderPanel(); }
    else if (a === 'as') await relogin(b.dataset.u);
    else if (a === 'ready') { loadReady(); session = {user: 'engineer01', role: 'editor'}; await reloadApp(); }
    else if (a === 'reset') { resetAll(); await reloadApp(); }
  });
  panel.addEventListener('change', (e) => {
    const c = e.target;
    if (c.dataset.sim === 'power') { BOARDS[c.dataset.n].power = c.checked; refreshDisplays(); renderPanel(); }
  });
  panel.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-sim=cover]');
    if (!b) return;
    const p = PORTS[Number(b.dataset.i)];
    p.covered = true; b.classList.add('on');
    const up = () => { p.covered = false; b.classList.remove('on'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  setInterval(() => {
    const t = now();
    document.querySelectorAll('canvas[data-phys]').forEach((c) => {
      const f = physical(Number(c.dataset.phys), t);
      if (!f) { c._key = null; const x = c.getContext('2d'); x.fillStyle = '#070807'; x.fillRect(0, 0, c.width, c.height); c.style.opacity = '.35'; return; }
      c.style.opacity = ''; window.drawLED(c, f[0], f[1]);
    });
    const u = usbIn() + '|' + HW.usbAt;
    if (open && tab === 'hw' && u !== lastUsb) { lastUsb = u; renderPanel(); }
    if (open && tab === 'hw') {
      document.querySelectorAll('[data-simcm]').forEach((el) => { const p = PORTS[Number(el.dataset.simcm)]; const cm = portCm(p, t); el.textContent = cm == null ? '—' : cm + ' cm'; });
    }
  }, 200);

  // start: a new junction out of the box (first account, wizard, lane setup), like a fresh Pi
  resetAll();
  renderPanel();
})();
