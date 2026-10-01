// T3 Traffic Platform web UI (plain JS, served from the Pi, no internet needed).
//
// Pages
//   setup   first run only (no lane yet): add lanes with +, pick type,
//           display and sensor ports, test the hardware, then Next
//   map     main page: junction map with draggable lane widgets + lane list;
//           double-click a widget (or + in the list) opens that lane's panel
//   system  junction-wide parameters, config history, users
'use strict';

const S = {
  me: null, page: 'map', cfg: null, defaults: null, errors: [],
  state: null, stale: true, displays: {}, ota: [], ports: [],
  layout: {lanes: {}}, mapUrl: null,
  drawing: {items: []},     // the junction map drawn in the browser (draw.js)
  dr: null,                 // drawing editor state while editing (draw.js)
  v3d: false,               // 3D view of the map (view only)
  cam: {rz: -24, tilt: 54, zoom: 1.1},   // 3D camera
  theme: null,              // 'light' | 'dark' | null = follow the system
  alerts: [],               // active diagnostics (diag.js)
  draft: null,              // setup: config being built
  edit: null,               // open lane panel: {id, isNew, lane, sensors, orig}
  finder: null,             // "cover the sensor with a hand" search
  sel: null,                // selected widget on the map
  sys: null, sysTab: 'params', sysCat: 'auto', versions: [], users: [], audit: [],
};

// ------------------------------------------------------------------ light / dark
function applyTheme() {
  const r = document.documentElement;
  if (S.theme) r.setAttribute('data-theme', S.theme); else r.removeAttribute('data-theme');
}
const isDark = () => (S.theme ? S.theme === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
function setTheme(t) {
  S.theme = t;
  try { localStorage.setItem('t3theme', t); } catch (e) { /* private mode: the choice lasts until reload */ }
  applyTheme();
}
try { const t = localStorage.getItem('t3theme'); if (t === 'light' || t === 'dark') S.theme = t; } catch (e) { /* ignore */ }
applyTheme();
try { const v = JSON.parse(localStorage.getItem('t3view') || 'null'); if (v) { S.v3d = !!v.v3d; S.vehOff = !!v.vehOff; if (v.cam) S.cam = {...S.cam, ...v.cam}; } } catch (e) { /* ignore */ }
try { S.dirs = JSON.parse(localStorage.getItem('t3dirs') || '{}') || {}; } catch (e) { S.dirs = {}; }
function keepDirs() { try { localStorage.setItem('t3dirs', JSON.stringify(S.dirs)); } catch (e) { /* ignore */ } }
function vehBtn() {
  const off = !!S.vehOff;
  return `<button class="sec sm vsw ${off ? '' : 'on'}" data-act="vehs" aria-pressed="${!off}" title="${off ? 'กดเพื่อแสดงรถจำลองบนแผนที่' : 'กดเพื่อซ่อนรถจำลองบนแผนที่'}">🚜 รถจำลอง <i>${off ? 'ซ่อน' : 'แสดง'}</i></button>`;
}
function keepView() { try { localStorage.setItem('t3view', JSON.stringify({v3d: S.v3d, vehOff: !!S.vehOff, cam: S.cam})); } catch (e) { /* ignore */ } }

// ------------------------------------------------------------------ words
const KIND_TH = {auto: 'Auto', vehicle: 'Manual', hand: 'Manual'};
const KIND_SUB = {auto: 'รถ Auto · เซนเซอร์ 2 ตัว', vehicle: 'ขอทางด้วยเซนเซอร์จับรถ', hand: 'ขอทางด้วยการยื่นมือ'};
const ROLE_TH = {far: 'ไกล', near: 'ใกล้', vehicle: 'จับรถ', hand: 'จับมือ'};
const STATE_TH = {STARTING: 'กำลังเริ่มระบบ', IDLE: 'พร้อม', SWITCHING: 'กำลังสลับเลน',
  GREEN: 'เขียว', CONFIG_ERROR: 'รอตั้งค่า'};
const GREEN_TH = {GO: '↑ ตรง', LEFT: '← ซ้าย', RIGHT: '→ ขวา'};
const DISPLAY_IDS = [1, 2, 3, 4, 5, 6, 7];

// definitions shown by the ⓘ buttons
const INFO = {
  heading: ['ทิศทางรถวิ่ง', 'ทิศที่รถของเลนนี้วิ่งเข้าหาเส้นหยุดบนแผนที่ 3 มิติ ใช้แสดงรถจำลองเท่านั้น ไม่กระทบการทำงานของไฟ'],
  kind: ['ประเภทเลน', 'Auto = รถ Auto วิ่งตามเส้น ใช้เซนเซอร์ 2 ตัว · Manual = รถมีคนขับ เลือกวิธีขอทางต่อด้านล่าง'],
  mode: ['วิธีขอทาง (Manual)', 'เซนเซอร์จับรถ: เซนเซอร์มองพื้น รถจอดทับ = ขอทาง ไฟเขียวจนรถพ้นแล้วนับเวลาเคลียร์\nยื่นมือ: เซนเซอร์ข้างเลน คนขับยื่นมือค้าง = ขอทาง ไฟเขียวตามเวลาที่ตั้ง'],
  display: ['จอ', 'จอ LED ของเลนนี้ หนึ่งจอใช้ได้เลนเดียว กด “ทดสอบ” แล้วจอนั้นจะขึ้นคำว่า TEST 5 วินาที'],
  port: ['พอร์ต', 'ช่องบนกล่อง USB-485 ที่สายเซนเซอร์ต่ออยู่ ตัวเลขท้ายชื่อคือระยะที่อ่านได้ตอนนี้'],
  find: ['หาด้วยมือ', 'กดแล้วเอามือบังเซนเซอร์ตัวนั้นค้างไว้ประมาณ 2 วินาที ระบบเลือกพอร์ตที่ระยะเปลี่ยนให้เอง'],
  far: ['เซนเซอร์ไกล', 'อยู่ห่างจากแยก เจอรถ Auto = แทรกหน้าคิวไว้ก่อน รถยังไม่ถึง'],
  near: ['เซนเซอร์ใกล้', 'อยู่ติดแยก เจอรถ = รถถึงแล้ว ให้ไฟเขียวได้ และใช้นับเวลาเคลียร์'],
  vehicle: ['เซนเซอร์จับรถ', 'มองลงพื้นกลางเลน รถจอดทับ = ขอทาง'],
  hand: ['เซนเซอร์จับมือ', 'ติดข้างเลนด้านคนขับ ยื่นมือค้าง = ขอทาง'],
  auto_clear_s: ['เคลียร์หลังรถพ้น', 'หลังท้ายรถหรือ dolly พ้นเซนเซอร์ใกล้ ไฟเขียวค้างต่ออีกเท่านี้'],
  auto_ticket_expiry_s: ['อายุคิว Auto', 'เซนเซอร์ไกลเจอรถแล้ว ถ้าเซนเซอร์ใกล้ไม่เจอภายในเวลานี้ ยกเลิกคิว'],
  manual_clear_s: ['เคลียร์หลังรถพ้น', 'หลังท้ายรถพ้นเซนเซอร์ ไฟเขียวค้างต่ออีกเท่านี้'],
  special_green_s: ['เวลาไฟเขียว', 'เลนยื่นมือได้ไฟเขียวนานเท่านี้ทุกครั้ง'],
  hold_s: ['ยื่นมือค้าง', 'ต้องยื่นมือค้างนานเท่านี้จึงได้คิว จอแสดง 1/3 2/3 ระหว่างนับ'],
  grace_ms: ['อนุโลมมือหลุด', 'มือหลุดจากเซนเซอร์สั้นกว่านี้ยังนับต่อ กันมือสั่น'],
  confirm_show_s: ['แสดงเครื่องหมายถูก', 'จอแสดงเครื่องหมายถูกนานเท่านี้หลังได้คิว'],
  rearm_clear_s: ['เอามือออกก่อนขอใหม่', 'ต้องเอามือออกนานเท่านี้ก่อนขอคิวครั้งต่อไป'],
  max_pending_per_lane: ['คิวค้างสูงสุด', 'จำนวนคิวที่เลนนี้ค้างได้พร้อมกัน'],
  min_detect_cm: ['ระยะใกล้สุด', 'วัตถุที่ใกล้กว่านี้ไม่นับว่าเจอ'],
  max_detect_cm: ['ระยะไกลสุด', 'วัตถุที่ไกลกว่านี้ไม่นับ · พื้นต้องอยู่ไกลกว่าค่านี้'],
  min_strength: ['ความแรงสัญญาณขั้นต่ำ', 'แสงสะท้อนอ่อนกว่านี้ไม่นับ กันค่าหลอก'],
  debounce_ms: ['Debounce', 'ต้องเจอต่อเนื่องนานเท่านี้จึงนับว่ามีรถหรือมือ'],
  manual_gap_hold_s: ['Gap hold · Manual', 'เลน Manual: ช่องว่างสั้นกว่านี้ถือเป็นคันเดียวกัน ตั้งต่ำเพื่อแยกรถที่ขับชิดกัน'],
  gap_hold_s: ['Gap hold', 'ช่องว่างสั้นกว่านี้ถือเป็นคันเดียวกัน เช่นช่องระหว่าง dolly'],
  offline_timeout_s: ['ถือว่าเซนเซอร์เสีย', 'ไม่มีข้อมูลจากเซนเซอร์นานเท่านี้ = เสีย ปิดเลนนั้น'],
  recover_stable_s: ['กลับมาใช้ได้', 'ข้อมูลกลับมานิ่งนานเท่านี้ = เปิดเลนกลับ'],
  switch_all_red_s: ['สลับเลน', 'ก่อนเลนใหม่ได้ไฟเขียว ทุกจอเป็น X อย่างน้อยเท่านี้'],
  display_ack_timeout_s: ['รอจอยืนยัน', 'จอต้องตอบยืนยันภายในเวลานี้ ไม่งั้นถือว่าจอเสีย'],
  display_link_timeout_s: ['อายุคำสั่งจอ', 'จอไม่ได้คำสั่งใหม่นานเท่านี้ จะขึ้น LINK LOST เอง · ต้องไม่เกินค่าในเฟิร์มแวร์'],
  display_fault_timeout_s: ['เวลาเผื่อจอเสีย', 'จอไม่ตอบ = ปิดเลนของจอนั้น และรอเท่านี้ (จอเลิกเขียวเองแน่นอน) ก่อนให้เลนอื่นได้เขียวต่อ'],
  command_refresh_s: ['ส่งคำสั่งซ้ำ', 'ส่งคำสั่งเดิมซ้ำไปที่จอทุกกี่วินาที'],
  startup_min_s: ['รอตอนเริ่มระบบ', 'หลังเปิดระบบ รออย่างน้อยเท่านี้ก่อนเริ่มควบคุม'],
  auto_first: ['Auto ได้คิวก่อน', 'รถ Auto ได้คิวก่อน Manual ที่รออยู่ แต่ไม่ตัดไฟเขียวที่กำลังวิ่ง'],
  green_frame: ['ภาพไฟเขียว', 'ภาพบนจอตอนเลนนี้ได้ไฟเขียว'],
  priority: ['ลำดับความสำคัญ', 'เลขมากได้คิวก่อน เท่ากันใครมาก่อนได้ก่อน'],
  enabled: ['เปิดใช้เลน', 'ปิด = เลนนี้ไม่รับคิว จอแสดง CONFIG'],
  name: ['ชื่อเลน', 'ชื่อที่แสดงในหน้าเว็บและบันทึก'],
  STOPHINT: ['F16 X + จุดยื่นมือ', 'เลนยื่นมือแสดง X พร้อมจุดบอกตำแหน่งยื่นมือ แทน X ธรรมดา'],
  GO_N: ['F21–F23 เขียว + นับถอยหลัง', 'เตรียมไว้ ยังไม่มีเงื่อนไขเรียกใช้'],
  STOP_N: ['F24–F26 แดง + นับถอยหลัง', 'เตรียมไว้ ยังไม่มีเงื่อนไขเรียกใช้'],
  ota_password: ['รหัส OTA', 'รหัสอัปเดตเฟิร์มแวร์ผ่าน LAN ต้องตรงกับ OTA_PASSWORD ในเฟิร์มแวร์จอ'],
};

// [key, label, unit, min, max, step]
const LANE_PARAMS = {
  auto: [['auto_clear_s', 'เคลียร์หลังรถพ้น', 's', 0.5, 30, 0.5], ['auto_ticket_expiry_s', 'อายุคิว', 's', 1, 60, 0.5]],
  vehicle: [['manual_clear_s', 'เคลียร์หลังรถพ้น', 's', 0.5, 30, 0.5]],
  hand: [['special_green_s', 'เวลาไฟเขียว', 's', 1, 60, 0.5], ['hold_s', 'ยื่นมือค้าง', 's', 1, 10, 0.5],
    ['grace_ms', 'อนุโลมมือหลุด', 'ms', 100, 1000, 50], ['confirm_show_s', 'แสดงเครื่องหมายถูก', 's', 0.2, 5, 0.1],
    ['rearm_clear_s', 'เอามือออกก่อนขอใหม่', 's', 0.1, 5, 0.1], ['max_pending_per_lane', 'คิวค้างสูงสุด', '', 1, 5, 1]],
};
const SENSOR_PARAMS = [['min_detect_cm', 'ระยะใกล้สุด', 'cm', 0, 1200, 5], ['max_detect_cm', 'ระยะไกลสุด', 'cm', 10, 1200, 5],
  ['min_strength', 'ความแรงสัญญาณขั้นต่ำ', '', 0, 65535, 10], ['debounce_ms', 'Debounce', 'ms', 0, 2000, 50],
  ['gap_hold_s', 'Gap hold', 's', 0.1, 5, 0.1]];
// system page: category -> groups -> rows.
// row: ['num', path, label, unit, min, max, step] | ['bool', path, label] | ['reserve', key] | ['text', path, label, infoKey]
const CATS = [
  ['auto', 'เลน Auto', [['ค่าเริ่มต้นของทุกเลน Auto', [
    ['num', 'timing.auto_clear_s', 'เคลียร์หลังรถพ้น', 's', 0.5, 30, 0.5], ['num', 'timing.auto_ticket_expiry_s', 'อายุคิว', 's', 1, 60, 0.5]]]]],
  ['manual', 'เลน Manual', [
    ['เซนเซอร์จับรถ', [['num', 'timing.manual_clear_s', 'เคลียร์หลังรถพ้น', 's', 0.5, 30, 0.5]]],
    ['ยื่นมือ', [['num', 'timing.special_green_s', 'เวลาไฟเขียว', 's', 1, 60, 0.5], ['num', 'hand.hold_s', 'ยื่นมือค้าง', 's', 1, 10, 0.5],
      ['num', 'hand.grace_ms', 'อนุโลมมือหลุด', 'ms', 100, 1000, 50], ['num', 'hand.confirm_show_s', 'แสดงเครื่องหมายถูก', 's', 0.2, 5, 0.1],
      ['num', 'hand.rearm_clear_s', 'เอามือออกก่อนขอใหม่', 's', 0.1, 5, 0.1], ['num', 'hand.max_pending_per_lane', 'คิวค้างสูงสุด', '', 1, 5, 1]]]]],
  ['sensor', 'เซนเซอร์', [
    ['การตรวจจับ', [['num', 'sensor_defaults.min_detect_cm', 'ระยะใกล้สุด', 'cm', 0, 1200, 5], ['num', 'sensor_defaults.max_detect_cm', 'ระยะไกลสุด', 'cm', 10, 1200, 5],
      ['num', 'sensor_defaults.min_strength', 'ความแรงสัญญาณขั้นต่ำ', '', 0, 65535, 10], ['num', 'sensor_defaults.debounce_ms', 'Debounce', 'ms', 0, 2000, 50],
      ['num', 'sensor_defaults.gap_hold_s', 'Gap hold · Auto', 's', 0.1, 5, 0.1],
      ['num', 'sensor_defaults.manual_gap_hold_s', 'Gap hold · Manual', 's', 0.05, 5, 0.05]]],
    ['เซนเซอร์เสีย', [['num', 'sensor_defaults.offline_timeout_s', 'ถือว่าเซนเซอร์เสีย', 's', 0.5, 10, 0.5], ['num', 'sensor_defaults.recover_stable_s', 'กลับมาใช้ได้', 's', 0.2, 10, 0.1]]]]],
  ['safety', 'ความปลอดภัย', [
    ['การสลับเลน', [['num', 'timing.switch_all_red_s', 'สลับเลน · ทุกจอ X', 's', 0.5, 10, 0.1],
      ['bool', 'priority.auto_first', 'Auto ได้คิวก่อน']]],
    ['การสื่อสารกับจอ', [['num', 'timing.display_ack_timeout_s', 'รอจอยืนยัน', 's', 0.5, 10, 0.5], ['num', 'timing.display_link_timeout_s', 'อายุคำสั่งจอ', 's', 1, 5, 0.5],
      ['num', 'timing.display_fault_timeout_s', 'เวลาเผื่อจอเสีย', 's', 2, 30, 0.5],
      ['num', 'timing.command_refresh_s', 'ส่งคำสั่งซ้ำ', 's', 0.2, 2.5, 0.1], ['num', 'timing.startup_min_s', 'รอตอนเริ่มระบบ', 's', 1, 30, 0.5]]]]],
  ['display', 'จอ', [
    ['เฟรมสำรอง', [['reserve', 'STOPHINT'], ['reserve', 'GO_N'], ['reserve', 'STOP_N']]],
    ['เฟิร์มแวร์', [['text', 'ota.password', 'รหัส OTA', 'ota_password']]]]],
  ['flash', 'ลงโปรแกรมจอ', []],
  ['service', 'ดูแลระบบ', []],
];

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const isEditor = () => S.me && S.me.role === 'editor';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const lastKey = (path) => path.split('.').pop();

async function api(path, opts = {}) {
  const o = {method: opts.method || 'GET', headers: {'X-T3': '1'}, credentials: 'same-origin'};
  if (opts.body !== undefined) {
    if (opts.raw) { o.body = opts.body; o.headers['Content-Type'] = 'application/octet-stream'; }
    else { o.body = JSON.stringify(opts.body); o.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, o);
  let data = {};
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && path !== '/api/login') { S.me = null; render(); }
  if (!r.ok) { const err = new Error(data.error || ('HTTP ' + r.status)); err.data = data; throw err; }
  return data;
}

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, err ? 7000 : 3500);
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
  if (val === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = val;
}
function flatten(d, prefix = '', out = {}) {
  if (Array.isArray(d)) d.forEach((v, i) => flatten(v, prefix + (v && v.id !== undefined ? v.id : i) + '.', out));
  else if (d && typeof d === 'object') Object.keys(d).forEach((k) => { if (!k.startsWith('_')) flatten(d[k], prefix + k + '.', out); });
  else out[prefix.slice(0, -1)] = d;
  return out;
}
function diff(a, b) {
  const fa = flatten(a || {}), fb = flatten(b || {});
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()
    .filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map((k) => ({key: k, from: fa[k], to: fb[k]}));
}
const infoBtn = (key) => (INFO[key] ? `<button class="ib" type="button" data-info="${key}" aria-label="คำอธิบาย ${esc(INFO[key][0])}" aria-expanded="false">i</button>` : '');

// ------------------------------------------------------------------ lane model
function kindOf(l) {
  if (!l || !l.type) return null;
  if (l.type === 'auto') return 'auto';
  if (l.type === 'special' || (l.type === 'manual' && l.mode === 'hand')) return 'hand';
  return 'vehicle';
}
function laneSensors(l) {
  const k = kindOf(l);
  if (k === 'auto') return [{sid: l.far_sensor, role: 'far'}, {sid: l.near_sensor, role: 'near'}];
  if (k) return [{sid: l.sensor, role: k}];
  return [];
}
function setKind(E, kind) {
  const l = E.lane;
  const byRole = {};
  laneSensors(l).forEach(({sid, role}) => { byRole[role] = E.sensors[sid]; });
  delete l.sensor; delete l.near_sensor; delete l.far_sensor; delete l.mode;
  const id = l.id;
  E.sensors = {};
  if (kind === 'auto') {
    l.type = 'auto'; l.far_sensor = `C${id}.2`; l.near_sensor = `C${id}.1`;
    E.sensors[l.far_sensor] = byRole.far || {port: ''};
    E.sensors[l.near_sensor] = byRole.near || byRole.vehicle || byRole.hand || {port: ''};
  } else {
    l.type = 'manual'; l.mode = kind; l.sensor = `C${id}`;
    E.sensors[l.sensor] = byRole.vehicle || byRole.hand || byRole.near || {port: ''};
  }
  l.params = {};
}
const srcCfg = () => (S.page === 'setup' ? S.draft : S.cfg);
function freeDisplay(cfg, exceptLane) {
  const used = (cfg.lanes || []).filter((l) => l.id !== exceptLane).map((l) => l.display);
  return DISPLAY_IDS.find((n) => !used.includes(n)) || null;
}
function applyEdit(cfg, E) {
  cfg.lanes = cfg.lanes || [];
  cfg.sensors = cfg.sensors || {};
  const old = cfg.lanes.find((x) => x.id === E.id);
  if (old) laneSensors(old).forEach(({sid}) => delete cfg.sensors[sid]);
  const lane = clone(E.lane);
  if (lane.params && !Object.keys(lane.params).length) delete lane.params;
  if (old) cfg.lanes[cfg.lanes.indexOf(old)] = lane; else cfg.lanes.push(lane);
  cfg.lanes.sort((a, b) => a.id - b.id);
  Object.entries(E.sensors).forEach(([sid, v]) => {
    const c = {};
    Object.entries(v).forEach(([k, x]) => { if (x !== '' && x !== undefined && x !== null) c[k] = x; });
    c.port = c.port || '';
    cfg.sensors[sid] = c;
  });
  cfg.displays = cfg.displays || {};
  if (lane.display && !cfg.displays[String(lane.display)]) cfg.displays[String(lane.display)] = {ip: '10.77.0.' + ((cfg.display_ip_base ?? 30) + lane.display)};
  return cfg;
}
function removeLane(cfg, id) {
  const old = (cfg.lanes || []).find((x) => x.id === id);
  if (!old) return cfg;
  laneSensors(old).forEach(({sid}) => delete cfg.sensors[sid]);
  cfg.lanes = cfg.lanes.filter((x) => x.id !== id);
  return cfg;
}
function getSensor(cfg, sid) { return (cfg.sensors || {})[sid] || {}; }
function laneMissing(cfg, l, sensors) {
  const miss = [];
  if (!kindOf(l)) miss.push('ประเภท');
  if (!l.display) miss.push('จอ');
  laneSensors(l).forEach(({sid}) => { if (!(sensors ? sensors[sid] || {} : getSensor(cfg, sid)).port) miss.push('พอร์ต ' + sid); });
  return miss;
}
function portLabel(path) { const p = allPorts().find((x) => x.path === path); return p ? p.label : (path || '—'); }
// who already uses this port: another lane (saved) or another sensor of the lane being edited
function portUsedBy(cfg, E, path, exceptSid) {
  const o = portOwner(cfg, path, E.id);
  if (o) return o;
  const same = Object.entries(E.sensors || {}).find(([k, v]) => k !== exceptSid && v.port === path);
  return same ? {lane: E.id, sid: same[0]} : null;
}
function portOwner(cfg, path, exceptLane) {
  for (const l of cfg.lanes || []) {
    if (l.id === exceptLane) continue;
    for (const {sid} of laneSensors(l)) if (getSensor(cfg, sid).port === path) return {lane: l.id, sid};
  }
  return null;
}

// ------------------------------------------------------------------ live data
function allPorts() {
  const out = ((S.state && S.state.ports) || []).slice();
  S.ports.forEach((p) => { if (!out.find((x) => x.path === p.path)) out.push({...p, cm: null, age_s: null}); });
  return out;
}
function effCm(p) {
  if (!p || p.age_s == null || p.age_s > 2) return null;
  if (p.strength != null && p.strength < 100) return 0;
  if (!p.cm || p.cm >= 12000) return 0;
  return p.cm;
}
function sensorLive(sid, port, cfg, sens) {
  const st = S.state;
  const running = st && (st.sensors || []).find((x) => x.id === sid);
  if (running && S.cfg && getSensor(S.cfg, sid).port === port) {
    if (!running.online) return {cls: 'bad', text: `${sid} ไม่มีข้อมูล`};
    return {cls: running.occupied ? 'on' : running.raw ? 'raw' : 'ok', text: `${sid} · ${running.distance_cm ?? '—'} cm${running.occupied ? ' · เจอ' : ''}`};
  }
  if (!port) return {cls: 'unk', text: `${sid} ยังไม่เลือกพอร์ต`};
  const p = allPorts().find((x) => x.path === port);
  const cm = effCm(p);
  if (cm == null) return {cls: st ? 'bad' : 'unk', text: `${sid} ไม่มีข้อมูลจากพอร์ต`};
  const d = {...((cfg && cfg.sensor_defaults) || {}), ...(sens || {})};
  const hit = cm >= d.min_detect_cm && cm <= d.max_detect_cm;
  return {cls: hit ? 'raw' : 'ok', text: `${sid} · ${cm} cm`};
}
function laneLive(id) { return ((S.state && S.state.lanes) || []).find((l) => l.id === id); }
function displayOnline(n) {
  const ll = ((S.state && S.state.lanes) || []).find((l) => l.display === n);
  if (ll) return ll.display_online;
  return S.displays[String(n)] === 'online';
}
function displayFrame(n) {
  const ll = ((S.state && S.state.lanes) || []).find((l) => l.display === n);
  if (ll) return [ll.frame, ll.arg];
  return [S.state ? 'CONFIG' : 'LINKWAIT', ''];
}

// ------------------------------------------------------------------ data loading
async function loadConfig() {
  const d = await api('/api/config');
  S.cfg = d.config; S.errors = d.errors; S.defaults = d.defaults;
}
async function loadLayout() { try { S.layout = await api('/api/layout'); } catch (e) { S.layout = {lanes: {}}; } }
async function loadPorts() { try { S.ports = (await api('/api/ports')).ports; } catch (e) { S.ports = []; } }
// optional picture behind the drawing (an uploaded floor plan); there is no built-in map
async function loadMap() {
  S.mapUrl = null;
  try {
    const r = await fetch('/api/map', {headers: {'X-T3': '1'}});
    if (r.ok) S.mapUrl = '/api/map?v=' + Date.now();
  } catch (e) { /* no picture */ }
}
async function pollState() {
  try {
    const d = await api('/api/state');
    S.state = d.state; S.stale = d.stale; S.displays = d.displays || {}; S.ota = d.ota || [];
    runFinder();
    updateLive();
  } catch (e) { /* next poll */ }
}

// ------------------------------------------------------------------ render root
function render() {
  const app = $('#app');
  hideInfo();
  if (!S.me) { app.innerHTML = loginView(); return; }
  if (S.wiz) { app.innerHTML = headerView() + wizView(); updateLive(); return; }
  const needSetup = S.cfg && !(S.cfg.lanes || []).length;
  if (needSetup && !S.draft) initDraft();
  if (needSetup && isEditor() && S.page !== 'system') S.page = 'setup';
  if (!needSetup && S.page === 'setup') S.page = 'map';
  let body;
  if (S.page === 'setup') body = setupView();
  else if (needSetup && S.page !== 'system') body = '<main id="main" tabindex="-1"><div class="card empty"><h2>ยังไม่ได้ตั้งค่าแยกนี้</h2><span class="mut">ให้ผู้ที่มีสิทธิ์แก้ไขเข้าสู่ระบบเพื่อตั้งค่า</span></div></main>';
  else if (S.page === 'system') body = systemView();
  else body = mainView();
  app.innerHTML = headerView() + body;
  if (S._pageKey !== S.page) {           // entrance animation only when the page changes, not on every refresh
    S._pageKey = S.page;
    app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter');
  }
  $$('canvas.led').forEach((c) => { c._key = null; });
  fitMapFull(); fit3d();
  afterRenderDraw();
  S._alertSig = null;                    // the alert widgets were rebuilt: fill them again
  updateLive();
  if (S.focus) { const el = document.getElementById(S.focus); if (el) el.focus(); S.focus = null; }
}

function headerView() {
  const cfg = S.page === 'setup' ? S.draft : S.cfg;
  const nav = (S.page === 'setup' || S.wiz) ? '' : `<nav>${[['map', 'แผนที่'], ['system', 'ระบบ']].map(([id, t]) =>
    `<a href="#${id}" class="${S.page === id ? 'on' : ''}">${t}</a>`).join('')}</nav>`;
  return `<a class="skip" href="#main">ข้ามไปเนื้อหาหลัก</a><header>
    <span class="jn"><img class="logo" src="/static/logo.png" alt="${esc((cfg && cfg.junction_id) || 'T3')}"></span>
    ${nav}
    <span class="pill" id="hdr-state" role="status" aria-live="polite"><i></i><span>—</span></span>
    <span class="qchips" id="hdr-queue"></span>
    <button class="alertbadge" id="hdr-alerts" data-act="alerts" hidden aria-label="การแจ้งเตือน"></button>
    <span class="who">
      <label class="themesw" title="สลับโหมดสว่าง / มืด"><span aria-hidden="true">☀</span><span class="sw"><input type="checkbox" data-theme-toggle aria-label="โหมดมืด" ${isDark() ? 'checked' : ''}><span></span></span><span aria-hidden="true">☾</span></label>
      ${avBtn(S.me.user, S.me.icon, 'avview')}<span class="mono">${esc(S.me.user)}</span>
      <button class="sec sm" data-act="logout">ออกจากระบบ</button></span>
  </header>`;
}

function loginView() {
  return `<form class="login" id="loginform">
    <h2>Traffic Platform</h2>
    ${S.setupNeeded ? '<p class="mut small">ยังไม่มีบัญชีผู้ใช้ ตั้งชื่อและรหัสผ่านของผู้ดูแลคนแรก (ทำได้จากหน้าจอของ Pi เท่านั้น รหัสผ่านอย่างน้อย 8 ตัว)</p>' : ''}
    <input id="lu" type="text" autocomplete="username" placeholder="ชื่อผู้ใช้" aria-label="ชื่อผู้ใช้" required>
    <input id="lp" type="password" autocomplete="current-password" placeholder="รหัสผ่าน" aria-label="รหัสผ่าน" required>
    ${S.setupNeeded ? '<input id="lp2" type="password" autocomplete="new-password" placeholder="ยืนยันรหัสผ่านอีกครั้ง" aria-label="ยืนยันรหัสผ่าน" required>' : ''}
    <button type="submit">${S.setupNeeded ? 'สร้างบัญชีและเริ่มเซ็ตอัป' : 'เข้าสู่ระบบ'}</button>
    <span class="r small">${esc(S.loginErr || '')}</span>
  </form>`;
}

const ledHtml = (n, w = 128, h = 64) => `<canvas class="led" width="${w}" height="${h}" data-disp="${n || ''}" aria-label="ภาพบนจอ B${n || '-'}"></canvas>`;

// ------------------------------------------------------------------ setup
function setupView() {
  const d = S.draft;
  const lanes = d.lanes || [];
  const cards = lanes.map((l) => laneCard(l)).join('');
  const newCard = S.edit && S.edit.isNew ? laneCard(S.edit.lane) : '';
  const nextId = Math.max(0, ...lanes.map((l) => l.id)) + 1;
  const incomplete = lanes.filter((l) => laneMissing(d, l).length).length;
  const reqs = [[lanes.length > 0, 'มีอย่างน้อย 1 เลน'], [lanes.length > 0 && !incomplete, 'ทุกเลนเลือกประเภท จอ และพอร์ตครบ'], [!S.edit, 'บันทึกเลนที่เปิดอยู่']];
  const ready = reqs.every((r) => r[0]);
  const add = S.edit ? '' : (lanes.length ? `<button class="addcard" data-act="addlane">＋ เพิ่มเลน ${nextId}</button>`
    : `<div class="card empty"><button class="bigplus" data-act="addlane" aria-label="เพิ่มเลน 1">+</button>
        <h2>เพิ่มเลนแรก</h2>
        <button class="plain" data-act="template">หรือใช้ผัง T3 ตามแบบ (5 เลน)</button></div>`);
  return `<main id="main" tabindex="-1"><div class="wiz">
    <div class="wiz-head"><h1>ตั้งค่าแยก</h1><span class="mut">เพิ่มเลนทีละเลน ครบแล้วกดถัดไป แล้ววาดแผนที่และวางเลนบนแผนที่</span></div>
    <div class="list">
      <div class="li-row"><span class="lab">รหัสแยก</span><span class="val"><input type="text" style="width:120px" data-g="junction_id" value="${esc(d.junction_id || '')}" aria-label="รหัสแยก"></span></div>
      <div class="li-row"><span class="lab">ชื่อแยก</span><span class="val"><input type="text" style="width:280px;max-width:52vw" data-g="junction_name" value="${esc(d.junction_name || '')}" aria-label="ชื่อแยก"></span></div>
    </div>
    ${cards}${newCard}${add}
  </div></main>
  <div class="bar">
    <div class="req">${reqs.map(([ok, t]) => `<span class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${t}</span>`).join('')}</div>
    <span class="sp"></span>
    ${S.wizSeen ? '<button class="sec" data-act="wizopen">‹ ย้อนกลับ</button>' : ''}
    ${lanes.length && !S.edit ? '<button class="plain" data-act="resetdraft">เริ่มใหม่</button>' : ''}
    <button data-act="finish" ${ready ? '' : 'disabled'}>ถัดไป</button>
  </div>`;
}
function laneCard(l) {
  const d = S.draft;
  const open = S.edit && S.edit.id === l.id;
  const view = open ? S.edit.lane : l;
  const k = kindOf(view);
  const miss = laneMissing(d, view, open ? S.edit.sensors : null);
  const chip = open ? '' : `<span class="chip ${miss.length ? 'no' : 'ok'}">${miss.length ? 'ยังขาด ' + esc(miss.join(', ')) : '✓ ครบ'}</span>`;
  return `<section class="card lanecard" id="lane-${l.id}">
    <div class="top">
      <span class="badge">${l.id}</span>
      <span class="kind"><b>${k ? KIND_TH[k] : 'เลนใหม่'}</b><span class="mut small">${k ? KIND_SUB[k] : 'เลือกประเภท'}${view.display ? ` · จอ B${view.display}` : ''}</span>${chip}</span>
      <span class="disp">${view.display ? ledHtml(view.display) : ''}</span>
      <span>${open ? '' : `<button class="sec sm" data-act="toggle" data-lane="${l.id}">แก้ไข</button>`}</span>
    </div>
    ${open ? editorHtml('setup') : ''}
  </section>`;
}

// ------------------------------------------------------------------ lane editor
function numRow(id, label, info, unit, min, max, step, value, dflt, attrs, ro) {
  const bad = value !== undefined && value !== '' && (isNaN(value) || value < min || value > max);
  const set = value !== undefined && value !== '';
  return `<div class="li-row"><label class="lab" for="${id}">${esc(label)}${infoBtn(info)}</label>
    <span class="val"><input id="${id}" type="number" step="${step}" min="${min}" max="${max}" ${attrs}
      class="${bad ? 'bad' : set ? 'set' : ''}" value="${set ? esc(value) : ''}" placeholder="${dflt === undefined ? '' : esc(dflt)}" ${ro}>
      <span class="unit">${unit}</span>
      <button class="rst ${set && !ro ? 'on' : ''}" type="button" data-act="clr" data-for="${id}" title="ใช้ค่าเริ่มต้น" aria-label="ใช้ค่าเริ่มต้น">↺</button></span></div>`;
}
function editorHtml(ctx) {
  const E = S.edit;
  const cfg = srcCfg();
  const l = E.lane;
  const k = kindOf(l);
  const ro = isEditor() ? '' : 'disabled';
  const segDis = ro ? 'aria-disabled="true"' : '';
  const typeSec = `<div><div class="sec-t">ประเภทเลน${infoBtn('kind')}</div>
    <div class="seg" role="group" aria-label="ประเภทเลน" ${segDis}>
      <button class="${k === 'auto' ? 'on' : ''}" data-act="kind" data-k="auto">Auto</button>
      <button class="${k && k !== 'auto' ? 'on' : ''}" data-act="kind" data-k="${k === 'hand' ? 'hand' : 'vehicle'}">Manual</button></div>
    ${k && k !== 'auto' ? `<div class="sec-t" style="margin-top:16px">วิธีขอทาง${infoBtn('mode')}</div>
      <div class="opts" ${segDis}>
        <button class="opt ${k === 'vehicle' ? 'on' : ''}" data-act="kind" data-k="vehicle" ${ro}><b>เซนเซอร์จับรถ</b><small>รถจอดทับเซนเซอร์</small></button>
        <button class="opt ${k === 'hand' ? 'on' : ''}" data-act="kind" data-k="hand" ${ro}><b>ยื่นมือ</b><small>คนขับยื่นมือค้างที่เซนเซอร์ข้างเลน</small></button>
      </div>` : ''}</div>`;
  if (!k) return `<div class="ed">${typeSec}<div class="edfoot"><span class="sp"></span><button class="sec" data-act="cancel">ยกเลิก</button></div></div>`;
  const dispOpts = DISPLAY_IDS.map((n) => {
    const owner = (cfg.lanes || []).find((x) => x.display === n && x.id !== l.id);
    return `<option value="${n}" ${l.display === n ? 'selected' : ''} ${owner ? 'disabled' : ''}>B${n}${displayOnline(n) ? '' : ' · ไม่พบ'}${owner ? ` · เลน ${owner.id}` : ''}</option>`;
  }).join('');
  const dispSec = `<div><div class="sec-t">จอ${infoBtn('display')}</div><div class="list">
    <div class="li-row"><span class="lab"><select data-e="display" aria-label="จอของเลน ${l.id}" ${ro}><option value="">เลือกจอ</option>${dispOpts}</select></span>
      <span class="val"><button class="sec sm" data-act="identify" data-disp="${l.display || ''}" ${l.display ? '' : 'disabled'}>ทดสอบ</button></span></div></div></div>`;
  const hd = laneHeading(l);
  const dirSec = `<div><div class="sec-t">ทิศทางรถวิ่ง${infoBtn('heading')}</div>
    <div class="seg dirseg" role="group" aria-label="ทิศทางรถวิ่งเลน ${l.id}" ${segDis}>${[[270, '↑', 'ขึ้น'], [90, '↓', 'ลง'], [180, '←', 'ซ้าย'], [0, '→', 'ขวา']].map(([d, a, t]) =>
      `<button class="${hd === d ? 'on' : ''}" data-act="setdir" data-lane="${l.id}" data-d="${d}" title="รถวิ่ง${t}" aria-label="รถวิ่ง${t}" ${ro}>${a}</button>`).join('')}</div>
    <div class="small mut" style="margin-top:6px">ใช้กับรถจำลองบนแผนที่ 3 มิติ · ปรับทีหลังได้ที่ปุ่ม “ทิศรถ ↻” บนไอคอนเลน</div></div>`;
  const sensSec = `<div><div class="sec-t">เซนเซอร์${infoBtn('port')}</div><div class="list">${laneSensors(l).map(({sid, role}) => sensorRow(E, cfg, sid, role, ro)).join('')}</div></div>`;
  const params = LANE_PARAMS[k].map(([key, label, unit, min, max, step]) => {
    const dflt = key in (cfg.timing || {}) ? cfg.timing[key] : (cfg.hand || {})[key];
    return numRow(`p_${l.id}_${key}`, label, key, unit, min, max, step, (l.params || {})[key], dflt, `data-p="${key}"`, ro);
  }).join('');
  const sensParams = laneSensors(l).map(({sid, role}) => {
    const sens = E.sensors[sid] || {};
    const d = {...(cfg.sensor_defaults || {})};
    return `<div><div class="sec-t">การตรวจจับของ ${esc(sid)} · ${ROLE_TH[role]}</div><div class="list">${SENSOR_PARAMS.map(([key, label, unit, min, max, step]) =>
      numRow(`s_${sid.replace('.', '_')}_${key}`, label, key, unit, min, max, step, sens[key], d[key], `data-sid="${esc(sid)}" data-sk="${key}"`, ro)).join('')}</div></div>`;
  }).join('');
  const more = `<details class="more"><summary>ตั้งค่าเพิ่มเติม</summary><div class="more-body">
    <div><div class="sec-t">เวลาของเลนนี้ <span class="mut" style="font-weight:400;margin-left:6px">ช่องว่าง = ค่าเริ่มต้น</span></div><div class="list">${params}</div></div>
    ${sensParams}
    <div><div class="sec-t">อื่น ๆ</div><div class="list">
      <div class="li-row"><span class="lab">ภาพไฟเขียว${infoBtn('green_frame')}</span><span class="val"><select data-e="green_frame" aria-label="ภาพไฟเขียว" ${ro}>${Object.entries(GREEN_TH).map(([g, t]) => `<option value="${g}" ${(l.green_frame || 'GO') === g ? 'selected' : ''}>${t}</option>`).join('')}</select></span></div>
      <div class="li-row"><span class="lab">ชื่อเลน${infoBtn('name')}</span><span class="val"><input type="text" data-e="name" value="${esc(l.name || '')}" placeholder="เลน ${l.id}" aria-label="ชื่อเลน" ${ro}></span></div>
      <div class="li-row"><span class="lab">ลำดับความสำคัญ${infoBtn('priority')}</span><span class="val"><input type="number" data-e="priority" data-num="1" value="${esc(l.priority ?? 0)}" min="0" max="9" step="1" aria-label="ลำดับความสำคัญ" ${ro}></span></div>
      <div class="li-row"><span class="lab">เปิดใช้เลน${infoBtn('enabled')}</span><span class="val"><label class="sw"><input type="checkbox" data-e="enabled" aria-label="เปิดใช้เลน" ${l.enabled !== false ? 'checked' : ''} ${ro}><span></span></label></span></div>
    </div></div></div></details>`;
  const live = laneLive(l.id);
  const maint = live && (live.reasons || []).includes('maintenance');
  const ops = ctx === 'main' && isEditor() && !E.isNew ? `<div class="ops">
      <button class="sec sm" data-act="maint" data-lane="${l.id}" data-on="${maint ? 0 : 1}">${maint ? 'เปิดเลน' : 'ปิดเลน'}</button>
      ${live && live.tickets ? `<button class="sec sm" data-act="clearq" data-lane="${l.id}">ล้างคิว ${live.tickets}</button>` : ''}
      <label class="filebtn">อัปเดตเฟิร์มแวร์<input type="file" accept=".bin" data-ota="${l.display}" aria-label="ไฟล์เฟิร์มแวร์ B${l.display}" hidden></label>
      <span class="small">${otaStatus(l.display)}</span></div>` : '';
  return `<div class="ed" data-editor="${l.id}">
    ${ops}${typeSec}${dispSec}${dirSec}${sensSec}${more}
    <div class="edfoot">
      ${isEditor() && !E.isNew ? '<button class="danger" data-act="dellane">ลบเลน</button>' : ''}
      <span class="sp"></span>
      <button class="sec" data-act="cancel">${isEditor() ? 'ยกเลิก' : 'ปิด'}</button>
      ${isEditor() ? '<button data-act="savelane">บันทึก</button>' : ''}
    </div>
  </div>`;
}
function sensorRow(E, cfg, sid, role, ro) {
  const sens = E.sensors[sid] || {port: ''};
  const ports = allPorts();
  const opts = ports.map((p) => {
    const owner = portUsedBy(cfg, E, p.path, sid);
    const cm = effCm(p);
    // a port already given to another sensor cannot be picked again (the server rejects it too)
    return `<option value="${esc(p.path)}" ${sens.port === p.path ? 'selected' : ''} ${owner && sens.port !== p.path ? 'disabled' : ''}>${esc(p.label)}${cm != null ? ` — ${cm} cm` : ''}${owner ? ` · ใช้กับ ${owner.sid} แล้ว` : ''}</option>`;
  }).join('');
  const missing = sens.port && !ports.find((p) => p.path === sens.port) ? `<option value="${esc(sens.port)}" selected>${esc(sens.port)} · ไม่พบ</option>` : '';
  const f = S.finder && S.finder.sid === sid;
  return `<div class="li-row"><div class="sensor-row" style="flex:1">
    <span class="sname"><span class="sd big" data-sid="${esc(sid)}" data-lane="${E.id}"></span>${esc(sid)}<small>${ROLE_TH[role]}</small>${infoBtn(role)}</span>
    <select data-port="${esc(sid)}" aria-label="พอร์ตของ ${esc(sid)}" ${ro}><option value="">เลือกพอร์ต</option>${missing}${opts}</select>
    <span></span>
    ${isEditor() ? (f ? `<span class="finder"><i></i>เอามือบัง ${esc(sid)} ค้างไว้… <button class="plain sm" data-act="findstop">หยุด</button></span>`
      : `<span><button class="plain sm" style="padding:0" data-act="find" data-sid="${esc(sid)}">หาด้วยมือ</button>${infoBtn('find')}</span>`) : ''}
  </div></div>`;
}
function otaStatus(disp) {
  const job = (S.ota || []).find((j) => j.display === disp);
  return job ? `<span class="${job.ok === false ? 'r' : job.ok ? 'g' : 'a'}">${esc(job.step)}</span>` : '';
}

// ------------------------------------------------------------------ main page
function mainView() {
  const cfg = S.cfg;
  const st = S.state;
  const banners = [];
  if (S.stale) banners.push('<div class="banner warn">ไม่ได้รับสถานะจากระบบควบคุม · จอจะแสดง LINK LOST เอง</div>');
  const pending = st && S.cfg._version && st.config_version !== S.cfg._version;
  if (pending) banners.push(`<div class="banner warn">บันทึก v${esc(S.cfg._version)} แล้ว · ใช้ค่าใหม่เมื่อแยกว่าง</div>`);
  else if (st && st.errors && st.errors.length) banners.push(`<div class="banner"><b>config ใช้ไม่ได้ · ไม่ควบคุมไฟ</b><br>${st.errors.map(esc).join('<br>')}</div>`);
  const edit = isEditor();
  const widgets = (cfg.lanes || []).filter((l) => S.layout.lanes[String(l.id)]).map((l) => widgetHtml(l)).join('');
  const drawing = drawEditing();
  const v3 = S.v3d && !drawing;
  const bg = v3 ? `<div class="stage" id="stage">${mapBgHtml(true)}${scene3dHtml((S.drawing && S.drawing.items) || [])}<div class="vehs" id="vehs"></div>${widgets}</div>` : mapBgHtml();
  const list = (cfg.lanes || []).map((l) => listItem(l)).join('');
  const newItem = S.edit && S.edit.isNew ? `<div class="lane open" id="lane-${S.edit.id}"><div class="lrow"><span class="num">${S.edit.id}</span><span class="mut small">เลนใหม่</span></div>${editorHtml('main')}</div>` : '';
  return `<main id="main" tabindex="-1">${banners.join('')}
    <div class="mainwrap">
      <div>
        <div class="card mapcard${S.mapFull ? ' full' : ''}" id="mapcard">
          ${drawing ? '<div class="dtools" id="dtools"></div>' : ''}
          ${drawing ? '' : `<div class="maptools">${v3 ? '<span class="camtools"><button class="sec sm" data-act="cam" data-k="rl" aria-label="หมุนซ้าย">⟲</button><button class="sec sm" data-act="cam" data-k="rr" aria-label="หมุนขวา">⟳</button><button class="sec sm" data-act="cam" data-k="tu" aria-label="เงยขึ้น">▲</button><button class="sec sm" data-act="cam" data-k="td" aria-label="ก้มลง">▼</button><button class="sec sm" data-act="cam" data-k="zi" aria-label="ซูมเข้า">＋</button><button class="sec sm" data-act="cam" data-k="zo" aria-label="ซูมออก">−</button></span>' : ''}${vehBtn()}
              <button class="sec sm" data-act="v3d" aria-pressed="${S.v3d}">${S.v3d ? '2D' : '3D'}</button>
              ${edit ? `<button class="sec sm" data-dact="start">✎ วาดแผนที่</button>
              <label>รูปพื้นหลัง<input type="file" accept="image/png,image/jpeg,image/svg+xml,.svg" data-mapfile hidden></label>
              ${S.mapUrl ? '<button class="sec sm" data-act="mapreset">ลบรูปพื้นหลัง</button>' : ''}` : ''}
              <button class="sec sm" data-act="mapfull" aria-label="แผนที่เต็มจอ">${S.mapFull ? '✕ ปิดเต็มจอ' : '⛶ เต็มจอ'}</button></div>`}<div class="mapbox${drawing ? ' drawing' : ''}${v3 ? ' v3d' : ''}" id="map"><div class="bg">${bg}</div>${v3 ? mapHintHtml() : (drawing ? '' : '<div class="vehs" id="vehs"></div>') + widgets}
            
          </div>
          <div class="legend">${drawing ? '<span>วาดแผนที่ · ลากเลนที่วางไว้จะทำได้หลังบันทึก</span>' : `<span><span class="sd ok"></span>ว่าง</span><span><span class="sd raw"></span>เห็นวัตถุ</span><span><span class="sd on"></span>เจอรถ/มือ</span><span><span class="sd bad"></span>เสีย</span>
            <span class="sp"></span><span>${v3 ? 'ลากเพื่อหมุนมุมมอง · ล้อเมาส์ซูม · รถเป็นการจำลองจากเซนเซอร์/คิว ไม่ใช่ตำแหน่งจริง · ลากเลนมาวางได้ทั้ง 2D และ 3D' : edit ? 'ลากเลนมาวาง · คลิกเลือกแล้วหมุน/ย่อขยาย · ดับเบิลคลิกเพื่อตั้งค่า' : 'ดับเบิลคลิกเพื่อดูรายละเอียด'}</span>`}</div>
        </div>
        <section class="card tlcard" id="tlcard" aria-label="ไทม์ไลน์">
          <div class="card-h">ไทม์ไลน์ · เวลาเขียวและเวลารอ<span class="sp"></span><span class="mut small" id="tl-sub"></span></div>
          <div id="tl"></div>
          <div class="legend"><span><i class="lg tgrn"></i>เขียว (จริง)</span><span><i class="lg twait"></i>รอคิว (จริง)</span><span><i class="lg tplan"></i>≈ คาดการณ์จากค่าเฉลี่ยจริงของเลนนั้น</span><span><i class="lg tred"></i>ทุกจอ X</span></div>
        </section>
        <section class="card flowcard" id="flowcard" aria-label="สรุปการไหลของรถ">
          <div class="card-h">สรุปตั้งแต่เปิดเครื่อง · การไหลของรถแต่ละเลน<span class="sp"></span><span class="mut small" id="flow-sub"></span>${isEditor() ? '<button class="plain sm" data-act="flowreset">เริ่มนับใหม่</button>' : ''}</div>
          <div id="flow"></div>
        </section>
        <div class="below">
          <section class="card"><div class="card-h">คิว</div><div class="log" id="queue"></div></section>
          <section class="card"><div class="card-h">เหตุการณ์ล่าสุด</div><div class="log" id="events"></div></section>
        </div>
      </div>
      <div class="side-col">
      <section class="card alertcard" id="alertcard" aria-label="การแจ้งเตือน" aria-live="polite" hidden></section>
      <aside class="card lanes" aria-label="รายการเลน">
        <div class="card-h">เลน</div>
        ${list}${newItem}
        ${edit && !S.edit ? '<button class="addrow" data-act="addlane">＋ เพิ่มเลน</button>' : ''}
      </aside>
      </div>
    </div></main>`;
}
function widgetHtml(l) {
  const pos = S.layout.lanes[String(l.id)] || {x: 0, y: 0, rot: 0};
  const edit = isEditor() && !drawEditing();
  const cls = `${edit ? 'edit' : ''} ${S.edit && S.edit.id === l.id ? 'open' : ''} ${S.sel === l.id ? 'sel' : ''}`;
  return `<div class="wg ${cls}" data-widget="${l.id}" tabindex="0"
      style="left:${pos.x * 100}%;top:${pos.y * 100}%;--rot:${pos.rot || 0}deg;--sc:${pos.scale || 1}" aria-label="เลน ${l.id} จอ B${l.display}">
    ${edit ? `<span class="tools"><button data-act="rot" data-lane="${l.id}">หมุน 90°</button><button data-act="dir" data-lane="${l.id}" title="ทิศที่รถของเลนนี้วิ่ง (มุมมอง 3D)">ทิศรถ ↻</button><button data-act="zoom" data-lane="${l.id}" data-d="-1" aria-label="ย่อ">−</button><button data-act="zoom" data-lane="${l.id}" data-d="1" aria-label="ขยาย">＋</button><button data-act="toggle" data-lane="${l.id}">ตั้งค่า</button><button data-act="unplace" data-lane="${l.id}">เอาออก</button></span><span class="rz" data-rz="${l.id}" title="ลากเพื่อย่อ/ขยาย"></span>` : ''}
    <span class="n">${l.id}</span>${ledHtml(l.display)}
    <span class="ss">${laneSensors(l).map(({sid}) => `<span class="sd" data-sid="${esc(sid)}" data-lane="${l.id}"></span>`).join('')}</span>
  </div>`;
}
// Auto / Manual (and how a Manual lane asks for the way) shown on every lane row
function kindBadge(l) {
  const k = kindOf(l);
  if (!k) return '';
  return `<span class="kbadge ${k === 'auto' ? 'auto' : 'man'}">${k === 'auto' ? 'Auto' : 'Manual'}${k === 'hand' ? ' · ยื่นมือ' : k === 'vehicle' ? ' · จับรถ' : ''}</span>`;
}
function listItem(l) {
  const open = S.edit && S.edit.id === l.id;
  const placed = !!S.layout.lanes[String(l.id)];
  return `<div class="lane ${open ? 'open' : ''}" id="lane-${l.id}">
    <div class="lrow ${isEditor() ? 'edit' : ''}" data-draglane="${l.id}">
      <span class="num">${l.id}</span>${ledHtml(l.display)}
      <span class="lmeta">${kindBadge(l)}<span class="lcodes" data-lcodes="${l.id}"></span>${placed ? '' : `<span class="hint">${isEditor() ? 'ลากไปวางบนแผนที่' : 'ยังไม่อยู่บนแผนที่'}</span>`}</span>
      <span class="lq" data-lq="${l.id}"></span>
      <button class="icon" data-act="toggle" data-lane="${l.id}" aria-expanded="${open}" aria-label="${open ? 'ปิด' : 'เปิด'}รายละเอียดเลน ${l.id}">${open ? '−' : '+'}</button>
    </div>
    ${open ? editorHtml('main') : ''}
  </div>`;
}

// ------------------------------------------------------------------ system page
function systemView() {
  const tabs = [['params', 'ค่ารวม'], ['history', 'ประวัติ'], ['users', 'ผู้ใช้']].filter(([id]) => id !== 'users' || isEditor());
  const head = `<div style="margin-bottom:24px"><div class="seg" role="tablist">${tabs.map(([id, t]) => `<button role="tab" aria-selected="${S.sysTab === id}" class="${S.sysTab === id ? 'on' : ''}" data-act="systab" data-tab="${id}">${t}</button>`).join('')}</div></div>`;
  let body = '';
  if (S.sysTab === 'params') body = sysParams();
  if (S.sysTab === 'history') body = sysHistory();
  if (S.sysTab === 'users') body = sysUsers();
  return `<main id="main" tabindex="-1">${head}${body}</main><div id="savebar">${sysSavebar()}</div>`;
}
function sysRow(row, ro) {
  const c = S.sys;
  const [type] = row;
  if (type === 'num') {
    const [, path, label, unit, min, max, step] = row;
    const v = getPath(c, path), dv = getPath(S.defaults, path), sv = getPath(S.cfg, path);
    const chg = JSON.stringify(v) !== JSON.stringify(sv);
    const notDefault = dv !== undefined && JSON.stringify(v) !== JSON.stringify(dv);
    const bad = v !== undefined && (isNaN(v) || v < min || v > max);
    const id = 'g_' + path.replace(/\./g, '_');
    return `<div class="li-row"><label class="lab" for="${id}">${esc(label)}${infoBtn(lastKey(path))}</label>
      <span class="val"><span class="dflt">${notDefault ? `ค่าเริ่มต้น ${esc(dv)}` : ''}</span>
      <input id="${id}" type="number" step="${step}" min="${min}" max="${max}" data-g="${path}" data-num="1" class="${bad ? 'bad' : chg ? 'chg' : ''}" value="${v === undefined ? '' : esc(v)}" ${ro}>
      <span class="unit">${unit}</span>
      <button class="rst ${notDefault && !ro ? 'on' : ''}" type="button" data-act="gdef" data-path="${path}" title="คืนค่าเริ่มต้น" aria-label="คืนค่าเริ่มต้น">↺</button></span></div>`;
  }
  if (type === 'bool') {
    const [, path, label] = row;
    return `<div class="li-row"><span class="lab">${esc(label)}${infoBtn(lastKey(path))}</span><span class="val"><label class="sw"><input type="checkbox" data-g="${path}" data-bool="1" aria-label="${esc(label)}" ${getPath(c, path) !== false ? 'checked' : ''} ${ro}><span></span></label></span></div>`;
  }
  if (type === 'reserve') {
    const key = row[1];
    const on = (getPath(c, 'frames.enabled_reserve') || []).includes(key);
    return `<div class="li-row"><span class="lab">${esc(INFO[key][0])}${infoBtn(key)}</span><span class="val"><label class="sw"><input type="checkbox" data-reserve="${key}" aria-label="${esc(INFO[key][0])}" ${on ? 'checked' : ''} ${ro}><span></span></label></span></div>`;
  }
  const [, path, label, info] = row;
  return `<div class="li-row"><span class="lab">${esc(label)}${infoBtn(info)}</span><span class="val"><input type="text" data-g="${path}" aria-label="${esc(label)}" value="${esc(getPath(c, path) || '')}" ${ro}></span></div>`;
}
function sysParams() {
  const ro = isEditor() ? '' : 'disabled';
  const cat = CATS.find((x) => x[0] === S.sysCat) || CATS[0];
  const side = `<nav class="side" aria-label="หมวดค่ารวม">${CATS.map(([id, t]) => `<button class="${cat[0] === id ? 'on' : ''}" data-act="syscat" data-cat="${id}">${t}</button>`).join('')}</nav>`;
  let content;
  if (cat[0] === 'flash') {
    content = `<div class="group"><div class="list"><div class="li-row"><span class="lab">ลงโปรแกรมให้จอ <span class="mut small">ตอนเปลี่ยนจอใหม่</span></span><span class="val"><button data-act="wizopen" data-nav="1" ${ro}>เริ่ม</button></span></div></div></div>`;
  } else if (cat[0] === 'service') {
    content = `<div class="group"><div class="list">
      <div class="li-row"><span class="lab">รีสตาร์ตระบบควบคุม</span><span class="val"><button class="sec sm" data-act="restart" ${ro}>รีสตาร์ต</button></span></div>
      <div class="li-row"><span class="lab">รีบูต Pi</span><span class="val"><button class="sec sm" data-act="reboot" ${ro} style="color:var(--red)">รีบูต</button></span></div>
    </div><span class="mut small" style="margin-left:16px">ทั้งสองอย่างรอให้แยกว่างก่อน ระหว่างนั้นทุกจอเป็น X</span></div>
    <div class="group"><div class="eyebrow">รหัสแจ้งเตือน</div><div class="list">${codeTableHtml()}</div></div>`;
  } else {
    content = cat[2].map(([title, rows]) => `<div class="group"><div class="eyebrow">${esc(title)}</div><div class="list">${rows.map((r) => sysRow(r, ro)).join('')}</div></div>`).join('');
  }
  const resetAll = cat[0] !== 'service' && cat[0] !== 'flash' && isEditor() && cat[2].some(([, rows]) => rows.some((r) => r[0] === 'num'))
    ? `<button class="plain" data-act="catdef" data-cat="${cat[0]}">คืนค่าเริ่มต้นทั้งหมวด</button>` : '';
  return `<div class="syswrap">${side}<div class="maxw"><div class="sys-h"><h2>${cat[1]}</h2>${resetAll}</div>${content}</div></div>`;
}
function sysSavebar() {
  if (S.sysTab !== 'params' || !isEditor() || !S.sys) return '';
  const n = diff(S.cfg, S.sys).length;
  if (!n) return '';
  return `<div class="bar"><span class="a">แก้ไข ${n} ค่า · ยังไม่บันทึก</span><span class="sp"></span>
    <button class="sec" data-act="sysdiscard">ยกเลิก</button><button data-act="syssave">บันทึก</button></div>`;
}
function sysHistory() {
  const vers = S.versions.map((v, i) => `<tr><td class="mono"><b>v${v.version}</b></td>
    <td>${esc(v.user)} <span class="mut small">${esc(v.time)}</span><br><span class="mut small">${esc(v.note || (v.changes || []).slice(0, 3).map((c) => c.key).join(', '))}</span></td>
    <td style="text-align:right">${i === 0 ? '<span class="g small">ใช้อยู่</span>' : (isEditor() ? `<button class="sec sm" data-act="rollback" data-v="${v.version}">ย้อนกลับ</button>` : '')}</td></tr>`).join('');
  return `<div class="maxw"><div class="list">${vers ? `<table>${vers}</table>` : '<div class="li-row mut">ยังไม่มีการบันทึกจากหน้าเว็บ</div>'}</div></div>`;
}
const USER_ICONS = ['', '🧑‍🔧', '👷', '🚜', '🛠️', '🔧', '⚡', '🚦', '🛡️', '⭐', '🦸', '🧙', '🐱', '🐶', '🦊', '🐼'];
const iconOpts = (cur) => USER_ICONS.map((i) => `<option value="${i}" ${cur === i ? 'selected' : ''}>${i || 'ตัวอักษรแรก'}</option>`).join('');
const isImg = (i) => typeof i === 'string' && i.startsWith('data:image/');
const userAv = (name, icon) => `<span class="uav" aria-hidden="true">${isImg(icon) ? `<img src="${icon}" alt="">` : (icon ? esc(icon) : esc((name || '?').charAt(0).toUpperCase()))}</span>`;
const avBtn = (name, icon, act = 'avpick') => `<button class="uavb" data-act="${act}" data-name="${esc(name)}" title="${act === 'avview' ? 'ดูรูปใหญ่' : 'เปลี่ยนรูปโปรไฟล์'}" aria-label="${act === 'avview' ? 'ดูรูปโปรไฟล์' : 'เปลี่ยนรูปโปรไฟล์'} ${esc(name)}">${userAv(name, icon)}</button>`;
// choose a picture: preset icons, the presets a build adds (window.T3_AVATARS), or an own upload (shrunk to 128 px in the browser)
async function setUserIcon(name, icon) {
  if (name === S.me.user) { await api('/api/me/icon', {method: 'POST', body: {icon}}); S.me.icon = icon; }
  else await api('/api/users', {method: 'POST', body: {name, icon}});
  if (S.me.role === 'editor') { const u = await api('/api/users'); S.users = u.users; }
  closeAvPick(); render(); toast('เปลี่ยนรูปโปรไฟล์แล้ว');
}
function closeAvPick() { const m = document.getElementById('avpk'); if (m) m.remove(); }
function openAvPick(name) {
  closeAvPick();
  const cur = name === S.me.user ? S.me.icon : ((S.users || []).find((u) => u.name === name) || {}).icon;
  const item = (v, label) => `<button class="avopt ${cur === v ? 'on' : ''}" data-avset="${esc(v)}" title="${esc(label)}">${userAv(name, v)}</button>`;
  const extra = (window.T3_AVATARS || []).map((v, i) => item(v, `รูปที่ ${i + 1}`)).join('');
  const m = document.createElement('div');
  m.id = 'avpk';
  m.innerHTML = `<div class="avcard" role="dialog" aria-label="รูปโปรไฟล์ ${esc(name)}"><div class="avh"><b>รูปโปรไฟล์ของ ${esc(name)}</b><button class="plain sm" data-avclose>ปิด</button></div>
    <div class="avgrid">${item('', 'ตัวอักษรแรก')}${USER_ICONS.filter((i) => i).map((i) => item(i, i)).join('')}${extra}</div>
    <label class="filebtn avup">อัปโหลดรูปของคุณ<input type="file" accept="image/*" data-avfile hidden></label><span class="mut small">ระบบย่อรูปเป็นวงกลม 256 pxให้เอง</span></div>`;
  m.dataset.name = name;
  document.body.appendChild(m);
}
function shrinkImage(file) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 320 / Math.max(img.width, img.height)), c = document.createElement('canvas');   // keep the whole picture, longest side 320 px
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error('อ่านรูปไม่ได้')); };
    img.src = url;
  });
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('avpk');
  if (!m) return;
  const set = e.target.closest('[data-avset]');
  if (set) setUserIcon(m.dataset.name, set.dataset.avset).catch((err) => toast(err.message, true));
  else if (e.target.closest('[data-avclose]') || e.target === m) closeAvPick();
});
document.addEventListener('change', async (e) => {
  const f = e.target.closest('[data-avfile]'), m = document.getElementById('avpk');
  if (!f || !m || !f.files[0]) return;
  try { await setUserIcon(m.dataset.name, await shrinkImage(f.files[0])); } catch (err) { toast(err.message, true); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAvPick(); });
function sysUsers() {
  const users = S.users.map((u) => `<tr><td>${avBtn(u.name, u.icon)} ${esc(u.name)}</td>

    <td><select aria-label="สิทธิ์ ${esc(u.name)}" data-userrole="${esc(u.name)}">${[['editor', 'แก้ไขได้'], ['viewer', 'ดูอย่างเดียว']].map(([k, t]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
    <td style="text-align:right"><button class="plain sm" data-act="userpw" data-name="${esc(u.name)}">ตั้งรหัสใหม่</button>
    ${u.name !== S.me.user ? `<button class="danger sm" data-act="userdel" data-name="${esc(u.name)}">ลบ</button>` : ''}</td></tr>`).join('');
  const audit = S.audit.map((a) => `<div><span class="mono">${esc(a.t)}</span><span>${esc(a.user)} · ${esc(a.action)}</span></div>`).join('');
  return `<div class="maxw" style="display:flex;flex-direction:column;gap:24px">
    <div class="group"><div class="eyebrow">บัญชีผู้ใช้</div><div class="list"><table>${users}</table>
      <form class="li-row" id="adduser"><select id="ni" class="iconsel" aria-label="ไอคอน">${iconOpts('')}</select><input type="text" id="nu" aria-label="ชื่อผู้ใช้ใหม่" placeholder="ชื่อผู้ใช้ใหม่" required style="flex:1">
        <input type="password" id="np" aria-label="รหัสผ่าน" placeholder="รหัสผ่าน ≥ 8 ตัว" required minlength="8" style="flex:1">
        <select id="nr" aria-label="สิทธิ์"><option value="viewer">ดูอย่างเดียว</option><option value="editor">แก้ไขได้</option></select>
        <button type="submit" class="sm">เพิ่ม</button></form></div></div>
    <div class="group"><div class="eyebrow">บันทึกการใช้งาน</div><div class="card"><div class="log" style="padding-top:8px;max-height:360px">${audit || '<span class="empty">—</span>'}</div></div></div></div>`;
}

// ------------------------------------------------------------------ info popover
function showInfo(btn) {
  const [title, text] = INFO[btn.dataset.info] || ['', ''];
  const p = $('#pop');
  if (p.dataset.for === btn.dataset.info && p.classList.contains('show')) { hideInfo(); return; }
  hideInfo();
  p.innerHTML = `<b>${esc(title)}</b>${esc(text).replace(/\n/g, '<br>')}`;
  p.dataset.for = btn.dataset.info;
  p.classList.add('show');
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight;
  const x = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - 12) y = r.top - h - 8;
  p.style.left = x + 'px'; p.style.top = y + 'px';
}
function hideInfo() {
  const p = $('#pop');
  if (!p) return;
  p.classList.remove('show'); p.dataset.for = '';
  $$('.ib[aria-expanded=true]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

// ------------------------------------------------------------------ live updates (no re-render)
function updateLive() {
  const st = S.state;
  flowFetch();
  const pill = $('#hdr-state');
  if (pill) {
    let cls = '', txt = 'ไม่มีข้อมูลจากระบบควบคุม';
    if (st && !S.stale) {
      txt = STATE_TH[st.state] || st.state;
      if (st.state === 'GREEN') { txt = `เลน ${st.active_lane} เขียว`; cls = 'g'; }
      else if (st.state === 'CONFIG_ERROR' || st.state === 'SWITCHING' || st.state === 'STARTING') cls = 'a';
      else cls = 'c';
      if (st.exit_requested) txt += ' · รอใช้ค่าใหม่';
    } else if (st) { cls = 'r'; txt = 'ระบบควบคุมไม่ตอบ'; }
    pill.className = 'pill ' + cls;
    pill.lastElementChild.textContent = txt;
  }
  $$('.lane').forEach((el) => el.classList.toggle('go', !!(st && !S.stale && st.state === 'GREEN' && el.id === 'lane-' + st.active_lane)));
  const q = (st && st.queue) || [];
  const hq = $('#hdr-queue');
  if (hq) hq.innerHTML = q.length ? 'คิว ' + q.slice(0, 6).map((t) => `<b>${t.lane}</b>`).join('') : '';
  const qe = $('#queue');
  const KQ = {auto: 'Auto', special: 'ยื่นมือ', manual: 'Manual'};
  if (qe) qe.innerHTML = q.length ? q.map((t, i) => `<div><span class="mono">${i + 1}</span><span>เลน ${t.lane} · ${KQ[t.kind] || t.kind}${t.kind === 'auto' && !t.matched ? ' · รถยังไม่ถึง' : ''}</span><span class="sp"></span><span class="mono">${t.age_s} s</span></div>`).join('') : '<span class="empty">ไม่มีคิว</span>';
  const ev = $('#events');
  if (ev) ev.innerHTML = ((st && st.events) || []).slice().reverse().map((e) => `<div><span class="mono">${new Date(e.t * 1000).toLocaleTimeString('th-TH')}</span><span>${esc(e.text)}</span></div>`).join('') || '<span class="empty">—</span>';
  $$('canvas[data-disp]').forEach((c) => {
    const n = Number(c.dataset.disp);
    if (!n) return;
    const [f, a] = displayFrame(n);
    drawLED(c, f, a);
    c.style.opacity = displayOnline(n) ? '' : '.35';
    c.title = `B${n} · ${displayOnline(n) ? 'ออนไลน์' : 'ไม่ตอบ'}`;
  });
  $$('.wg[data-widget]').forEach((w) => {
    const l = (S.cfg.lanes || []).find((x) => x.id === Number(w.dataset.widget));
    if (l) w.classList.toggle('off', !displayOnline(l.display));
    w.classList.toggle('live', !!(st && !S.stale && st.state === 'GREEN' && st.active_lane === Number(w.dataset.widget)));
  });
  updateAlerts();
  tlTrack();
  vehSync();
  updateLaneQueue();
  tlRender();
  $$('.sd[data-sid]').forEach((d) => {
    const sid = d.dataset.sid, laneId = Number(d.dataset.lane);
    const cfg = srcCfg();
    const sens = S.edit && S.edit.id === laneId ? S.edit.sensors[sid] || {} : getSensor(cfg, sid);
    const s = sensorLive(sid, sens.port, cfg, sens);
    d.className = 'sd ' + s.cls + (d.classList.contains('big') ? ' big' : '');
    d.title = s.text;
  });
  $$('select[data-port]').forEach((sel) => {
    if (document.activeElement === sel) return;
    [...sel.options].forEach((o) => {
      if (!o.value) return;
      const p = allPorts().find((x) => x.path === o.value);
      if (!p) return;
      const cm = effCm(p);
      o.textContent = o.textContent.replace(/ — \d+ cm/, '').replace(p.label, p.label + (cm != null ? ` — ${cm} cm` : ''));
    });
  });
  $$('[data-editor]').forEach((ed) => {
    const live = laneLive(Number(ed.dataset.editor));
    const btn = ed.querySelector('[data-act=maint]');
    if (btn && live) {
      const maint = (live.reasons || []).includes('maintenance');
      btn.dataset.on = maint ? 0 : 1;
      btn.textContent = maint ? 'เปิดเลน' : 'ปิดเลน';
    }
  });
}

// ------------------------------------------------------------------ hand finder
function runFinder() {
  const f = S.finder;
  if (!f) return;
  const ports = ((S.state && S.state.ports) || []).filter((p) => effCm(p) != null);
  if (!f.base) {
    f.base = {};
    ports.forEach((p) => { f.base[p.path] = effCm(p); });
    if (!Object.keys(f.base).length) { S.finder = null; toast('ยังไม่มีพอร์ตที่อ่านค่าได้ · ตรวจสาย USB-485', true); render(); }
    return;
  }
  const cands = [];
  ports.forEach((p) => {
    const b = f.base[p.path];
    if (b == null) return;
    const change = Math.abs(b - effCm(p));
    if (change >= Math.max(40, b * 0.3) && !(S.edit && portUsedBy(srcCfg(), S.edit, p.path, f.sid))) cands.push([p.path, change]);
  });
  Object.keys(f.hits).forEach((p) => { if (!cands.find((c) => c[0] === p)) f.hits[p] = 0; });
  cands.forEach(([p]) => { f.hits[p] = (f.hits[p] || 0) + 1; });
  const found = cands.filter(([p]) => f.hits[p] >= 2).sort((a, b) => b[1] - a[1]);
  if (found.length && S.edit && S.edit.sensors[f.sid]) {
    const path = found[0][0];
    S.edit.sensors[f.sid].port = path;
    S.finder = null;
    toast(`${f.sid} = ${portLabel(path)}`);
    render();
  } else if (Date.now() > f.until) {
    S.finder = null;
    toast('ไม่เจอพอร์ตที่ค่าเปลี่ยน ลองบังให้ใกล้เซนเซอร์ขึ้น หรือเลือกจากรายการ', true);
    render();
  }
}

// ------------------------------------------------------------------ lane panel actions
function openLane(id) {
  if (S.edit && S.edit.id === id) return closeLane();
  const cfg = srcCfg();
  const l = cfg.lanes.find((x) => x.id === id);
  if (!l) return;
  const sensors = {};
  laneSensors(l).forEach(({sid}) => { sensors[sid] = clone(getSensor(cfg, sid)); if (sensors[sid].port === undefined) sensors[sid].port = ''; });
  S.edit = {id, isNew: false, lane: clone(l), sensors};
  S.edit.orig = JSON.stringify([S.edit.lane, S.edit.sensors]);
  S.finder = null;
  render();
  const el = document.getElementById('lane-' + id);
  if (el) el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}
function dirtyEdit() { return S.edit && (S.edit.isNew || JSON.stringify([S.edit.lane, S.edit.sensors]) !== S.edit.orig); }
function closeLane() { S.edit = null; S.finder = null; render(); }
function addLane() {
  const cfg = srcCfg();
  const id = Math.max(0, ...(cfg.lanes || []).map((l) => l.id)) + 1;
  S.edit = {id, isNew: true, lane: {id, name: '', type: null, display: freeDisplay(cfg, id), enabled: true, priority: 0, green_frame: 'GO'}, sensors: {}};
  render();
  const el = document.getElementById('lane-' + id);
  if (el) el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}
async function saveLane() {
  const E = S.edit;
  const seen = {};
  for (const [sid, v] of Object.entries(E.sensors)) {
    if (!v.port) continue;
    const o = portUsedBy(srcCfg(), E, v.port, sid) || (seen[v.port] ? {sid: seen[v.port]} : null);
    if (o) { toast(`พอร์ต ${portLabel(v.port)} ซ้ำกับ ${o.sid} · เลือกใหม่ก่อนบันทึก`, true); return; }
    seen[v.port] = sid;
  }
  if (S.page === 'setup') {
    applyEdit(S.draft, E);
    S.edit = null; S.finder = null;
    keepDraft(); render();
    return;
  }
  await commitConfig(applyEdit(clone(S.cfg), E), `แก้เลน ${E.id}`, `บันทึกเลน ${E.id}`);
}
async function commitConfig(next, defaultNote, title) {
  const ch = diff(S.cfg, next);
  if (!ch.length) { S.edit = null; render(); return; }
  const body = `<div class="dl">${ch.map((c) => `<div><span class="mono">${esc(c.key)}</span> ${esc(c.from ?? '—')} → <b>${esc(c.to ?? '—')}</b></div>`).join('')}</div>
    <input id="note" type="text" value="${esc(defaultNote)}" aria-label="บันทึกเหตุผล" placeholder="แก้เพราะอะไร">
    <p class="mut small">ระบบใช้ค่าใหม่เมื่อแยกว่าง (ทุกจอเป็น X ประมาณ 5 วินาที) · ย้อนกลับได้ที่ ระบบ › ประวัติ</p>`;
  const d = await confirmDialog(title, body, 'บันทึก');
  if (!d) return;
  try {
    const r = await api('/api/config', {method: 'POST', body: {config: next, note: d.querySelector('#note').value}});
    await loadConfig();
    S.edit = null; S.finder = null; S.sys = clone(S.cfg);
    render();
    toast(`บันทึก v${r.version} แล้ว`);
  } catch (e) {
    toast('บันทึกไม่ได้: ' + ((e.data && e.data.errors) || [e.message]).join(' · '), true);
  }
}

// ------------------------------------------------------------------ setup draft
function keepDraft() { try { localStorage.setItem('t3draft', JSON.stringify(S.draft)); } catch (e) { /* ignore */ } }
function initDraft() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('t3draft') || 'null'); } catch (e) { saved = null; }
  S.draft = saved && saved.junction_type === 't3' ? saved : clone(S.cfg);
  S.draft.lanes = S.draft.lanes || [];
}
async function finishSetup() {
  try {
    const r = await api('/api/config', {method: 'POST', body: {config: S.draft, note: 'ตั้งค่าเริ่มต้น'}});
    if (S.pendingLayout && !Object.keys(S.layout.lanes).length) {
      try { S.layout = await api('/api/layout', {method: 'POST', body: S.pendingLayout}); } catch (e) { /* place by hand */ }
    }
    if (S.pendingDrawing && !(S.drawing.items || []).length) {
      try { S.drawing = await api('/api/drawing', {method: 'POST', body: {items: drawStarter()}}); } catch (e) { /* draw by hand */ }
    }
    S.pendingDrawing = false;
    try { localStorage.removeItem('t3draft'); } catch (e) { /* ignore */ }
    await loadConfig();
    S.page = 'map'; location.hash = '#map';
    render();
    toast(`บันทึก v${r.version} แล้ว · ลากเลนไปวางบนแผนที่`);
  } catch (e) {
    toast('ยังใช้ไม่ได้: ' + ((e.data && e.data.errors) || [e.message]).join(' · '), true);
  }
}
async function useTemplate() {
  const t = await api('/api/template');
  S.draft.lanes = t.lanes; S.draft.sensors = t.sensors; S.draft.displays = {...(S.draft.displays || {}), ...t.displays};
  const at = {1: [580, 315], 2: [460, 315], 3: [372, 282], 4: [580, 272], 5: [700, 272]};   // T3 layout, old map units (viewBox 20 10 840 585)
  S.pendingLayout = {lanes: {}};
  S.pendingDrawing = true;
  t.lanes.forEach((l) => { const p = at[l.id]; if (p) S.pendingLayout.lanes[String(l.id)] = {x: (p[0] - 20) / 840, y: (p[1] - 10) / 585, rot: l.id === 3 ? 90 : 0}; });
  keepDraft(); render();
  toast('ใส่ผัง T3 แล้ว · เลือกพอร์ตเซนเซอร์ของแต่ละเลน');
}

// ------------------------------------------------------------------ layout (drag on map)
let drag = null;
// Map position (0..1) under the pointer. In 3D the pointer is projected back onto the floor of the stage
// (same transform chain as fit3d), so a lane can be dragged or dropped in 3D exactly as in 2D.
function mapPoint(e) {
  const r = mapRect();
  if (!r) return null;
  if (!S.v3d) return {x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))};
  const W = r.width, H = Math.round(W * 0.62), c = S.cam, k = W / 1000 * 0.9 * (c.zoom || 1), d = Math.round(W * 1.7);
  const rz = c.rz * Math.PI / 180, tl = c.tilt * Math.PI / 180, sx = e.clientX - r.left, sy = e.clientY - r.top;
  const fwd = (gx, gy) => {
    const x = (gx - 500) * k, y = (gy - 350) * k;
    const x1 = x * Math.cos(rz) - y * Math.sin(rz), y1 = x * Math.sin(rz) + y * Math.cos(rz);
    const X = W / 2 + x1, Y = H * 0.54 + y1 * Math.cos(tl), f = d / (d - y1 * Math.sin(tl));
    return [W / 2 + (X - W / 2) * f, H / 2 + (Y - H / 2) * f];
  };
  let gx = 500, gy = 350;
  for (let i = 0; i < 12; i++) {                 // Newton steps with a numeric Jacobian
    const [px, py] = fwd(gx, gy), [ax, ay] = fwd(gx + 1, gy), [bx, by] = fwd(gx, gy + 1);
    const a = ax - px, b = bx - px, cc = ay - py, dd = by - py, det = a * dd - b * cc;
    if (Math.abs(det) < 1e-9) break;
    const ex = sx - px, ey = sy - py;
    gx += (dd * ex - b * ey) / det; gy += (-cc * ex + a * ey) / det;
  }
  return {x: Math.max(0, Math.min(1, gx / 1000)), y: Math.max(0, Math.min(1, gy / 700))};
}
function mapRect() { const m = $('#map'); return m && m.getBoundingClientRect(); }
async function saveLayout() {
  try { S.layout = await api('/api/layout', {method: 'POST', body: S.layout}); }
  catch (e) { toast('บันทึกตำแหน่งไม่ได้: ' + e.message, true); }
}
const SCALE_MIN = 0.5, SCALE_MAX = 3;      // the server accepts 0.4 .. 4
const clampScale = (v) => Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, v)) * 20) / 20;
function selectWidget(id) {
  S.sel = id;
  $$('.wg[data-widget]').forEach((w) => w.classList.toggle('sel', Number(w.dataset.widget) === id));
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.wg') && !e.target.closest('#pop') && S.sel !== null) selectWidget(null);
  if (S.v3d && S.page === 'map' && e.button === 0) { const w3 = e.target.closest('[data-widget]'); if (w3 && !e.target.closest('button,select,input,label,a')) selectWidget(Number(w3.dataset.widget)); if (!w3 && !e.target.closest('[data-draglane]')) return; }
  if (!isEditor() || S.page !== 'map' || e.button !== 0 || drawEditing()) return;
  const rz = e.target.closest('[data-rz]');
  if (rz) {                                    // corner handle: resize the widget
    const w0 = rz.closest('.wg'), r0 = w0.getBoundingClientRect(), key = rz.dataset.rz;
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2, cur = (S.layout.lanes[key] || {}).scale || 1;
    drag = {lane: Number(key), el: w0, resize: true, cx, cy, d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, s0: cur, moved: false, x0: e.clientX, y0: e.clientY};
    w0.setPointerCapture(e.pointerId); e.preventDefault();
    return;
  }
  if (e.target.closest('button,select,input,label,a')) return;
  const w = e.target.closest('[data-widget]');
  const h = e.target.closest('[data-draglane]');
  if (!w && !h) return;
  drag = {lane: Number(w ? w.dataset.widget : h.dataset.draglane), el: w, fromMap: !!w, x0: e.clientX, y0: e.clientY, moved: false};
  if (w) { w.setPointerCapture(e.pointerId); e.preventDefault(); }
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
  drag.moved = true;
  if (drag.resize) {
    const sc = clampScale(drag.s0 * Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) / drag.d0);
    drag.scale = sc;
    drag.el.style.setProperty('--sc', String(sc));
    return;
  }
  const r = mapRect();
  if (drag.fromMap) {
    drag.el.classList.add('dragging');
    const mp = mapPoint(e);
    drag.el.style.left = (mp.x * 100) + '%';
    drag.el.style.top = (mp.y * 100) + '%';
  } else {
    if (!drag.ghost) {
      const l = S.cfg.lanes.find((x) => x.id === drag.lane);
      const tmp = document.createElement('div');
      tmp.innerHTML = widgetHtml(l).replace(/left:[^;]*;top:[^;]*;/, '');
      drag.ghost = tmp.firstElementChild;
      drag.ghost.classList.add('ghost-wg');
      drag.ghost.style.transform = 'none';
      document.body.appendChild(drag.ghost);
      drag.ghost.querySelectorAll('canvas').forEach((c) => { const [f, a] = displayFrame(l.display); drawLED(c, f, a); });
    }
    drag.ghost.style.left = (e.clientX - 50) + 'px';
    drag.ghost.style.top = (e.clientY - 18) + 'px';
    const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    $('#map').classList.toggle('drop', inside);
  }
});
document.addEventListener('pointerup', async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.ghost) d.ghost.remove();
  const m = $('#map');
  if (m) m.classList.remove('drop');
  if (d.resize) {
    if (d.moved && d.scale) { const o = S.layout.lanes[String(d.lane)]; if (o) { o.scale = d.scale; await saveLayout(); } }
    return;
  }
  if (!d.moved) { if (d.fromMap) selectWidget(d.lane); return; }
  const r = mapRect();
  const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside && !d.fromMap) return;
  const key = String(d.lane);
  const old = S.layout.lanes[key] || {rot: 0};
  const mp = mapPoint(e);
  S.layout.lanes[key] = {x: mp.x, y: mp.y, rot: old.rot || 0};
  if (old.scale) S.layout.lanes[key].scale = old.scale;
  if (old.dir !== undefined) S.layout.lanes[key].dir = old.dir;
  S.sel = d.lane;               // keep the tools visible after a drop
  await saveLayout();
  render();
});
document.addEventListener('dblclick', (e) => {
  const w = e.target.closest('[data-widget]');
  if (w && S.page === 'map' && !e.target.closest('.tools')) { e.preventDefault(); openLane(Number(w.dataset.widget)); }
});
// Full-screen map for the operator view. Widgets are placed by fraction of the map,
// so only their size needs scaling (--ws); the map keeps its own aspect ratio (--ar).
function fitMapFull() {
  const card = document.getElementById('mapcard'), box = document.getElementById('map');
  if (!card || !box) return;
  card.classList.toggle('full', !!S.mapFull);
  if (!S.mapFull) { box.style.removeProperty('--ar'); card.style.removeProperty('--ws'); return; }
  const svg = box.querySelector('svg'), img = box.querySelector('img');
  let ar = S.v3d ? 1 / 0.62 : 1.4;
  if (S.v3d) { /* fixed 3D aspect */ } else if (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) ar = svg.viewBox.baseVal.width / svg.viewBox.baseVal.height;
  else if (img && img.naturalHeight) ar = img.naturalWidth / img.naturalHeight;
  box.style.setProperty('--ar', ar);
  const w = Math.min(window.innerWidth, (window.innerHeight - 64) * ar);
  card.style.setProperty('--ws', String(Math.max(1, Math.min(3, w / 760))));
}
// 3D view: the drawing stays a flat 1000 x 700 plane, tilted and scaled to the box with CSS 3D
function fit3d() {
  const box = document.getElementById('map'), st = document.getElementById('stage');
  if (!box) return;
  if (!st) {
    box.style.removeProperty('height'); box.style.removeProperty('perspective');
    const v2 = document.getElementById('vehs');       // 2D: same vehicles, drawn flat over the map
    if (v2 && box.clientWidth) v2.style.transform = `scale3d(${box.clientWidth / 1000},${box.clientHeight / 700},${box.clientWidth / 1000})`;
    return;
  }
  const W = box.clientWidth;
  if (!W) return;
  const H = Math.round(W * 0.62), c = S.cam, k = W / 1000 * 0.9 * (c.zoom || 1);
  box.style.height = H + 'px'; box.style.perspective = Math.round(W * 1.7) + 'px';
  st.style.setProperty('--rz', c.rz + 'deg'); st.style.setProperty('--tilt', c.tilt + 'deg');
  st.style.transform = `translate(${W / 2}px,${H * 0.54}px) rotateX(${c.tilt}deg) rotateZ(${c.rz}deg) scale(${k}) translate(-500px,-350px)`;
}
let orbit = null;
document.addEventListener('pointerdown', (e) => {
  if (!S.v3d || S.page !== 'map' || e.button !== 0 || e.target.closest('.wg,button,label,.maptools')) return;
  const box = e.target.closest('#map');
  if (!box) return;
  orbit = {x: e.clientX, y: e.clientY, rz: S.cam.rz, tilt: S.cam.tilt};
  const st = document.getElementById('stage'); if (st) st.classList.add('orbiting');
  try { box.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
document.addEventListener('pointermove', (e) => {
  if (!orbit) return;
  S.cam.rz = Math.round(orbit.rz + (e.clientX - orbit.x) * 0.4);
  S.cam.tilt = Math.max(15, Math.min(80, Math.round(orbit.tilt + (e.clientY - orbit.y) * 0.3)));
  fit3d();
});
document.addEventListener('pointerup', () => {
  if (!orbit) return;
  orbit = null; keepView();
  const st = document.getElementById('stage'); if (st) st.classList.remove('orbiting');
});
document.addEventListener('wheel', (e) => {
  if (!S.v3d || !e.target.closest('#map')) return;
  e.preventDefault();
  S.cam.zoom = Math.max(0.5, Math.min(2.5, Math.round((S.cam.zoom - Math.sign(e.deltaY) * 0.1) * 10) / 10));
  fit3d(); keepView();
}, {passive: false});
function setMapFull(on) {
  S.mapFull = !!on;
  const b = document.querySelector('[data-act="mapfull"]');
  if (b) b.textContent = S.mapFull ? '✕ ปิดเต็มจอ' : '⛶ เต็มจอ';
  fitMapFull(); fit3d();
  try {
    if (S.mapFull && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!S.mapFull && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch (err) { /* browser refused: the overlay still works */ }
}
window.addEventListener('resize', () => { if (S.mapFull) fitMapFull(); fit3d(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.mapFull) setMapFull(false); });
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { hideInfo(); if (S.mapFull) setMapFull(false); else if (S.sel !== null && !drawEditing()) selectWidget(null); }
  const w = e.target.closest && e.target.closest('[data-widget]');
  if (!w || e.target !== w) return;
  const id = Number(w.dataset.widget);
  if (e.key === 'Enter') { e.preventDefault(); openLane(id); return; }
  if (!isEditor()) return;
  const pos = S.layout.lanes[String(id)];
  const step = e.shiftKey ? 0.05 : 0.01;
  const mv = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[e.key];
  if (mv) {
    e.preventDefault();
    pos.x = Math.max(0, Math.min(1, pos.x + mv[0])); pos.y = Math.max(0, Math.min(1, pos.y + mv[1]));
    w.style.left = pos.x * 100 + '%'; w.style.top = pos.y * 100 + '%';
    clearTimeout(w._t); w._t = setTimeout(saveLayout, 600);
  } else if (e.key === 'r' || e.key === 'R') {
    pos.rot = ((pos.rot || 0) + 90) % 360; w.style.setProperty('--rot', pos.rot + 'deg'); saveLayout();
  } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
    pos.scale = clampScale((pos.scale || 1) + (e.key === '-' || e.key === '_' ? -0.1 : 0.1)); w.style.setProperty('--sc', String(pos.scale));
    clearTimeout(w._t); w._t = setTimeout(saveLayout, 600);
  }
});
window.addEventListener('scroll', hideInfo, {passive: true});

// ------------------------------------------------------------------ dialogs
function confirmDialog(title, bodyHtml, okText) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    // plain buttons, not <form method="dialog">: the page-wide submit handler
    // (and sandboxed frames) would block a form submit and leave the dialog open
    d.innerHTML = `<h2>${esc(title)}</h2>${bodyHtml}
      <div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="sec" data-dlg="no">ยกเลิก</button><button type="button" data-dlg="yes">${esc(okText)}</button></div>`;
    d.returnValue = 'no';
    d.onclick = (e) => { const b = e.target.closest('[data-dlg]'); if (b) { d.returnValue = b.dataset.dlg; d.close(); } };
    d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); d.returnValue = 'yes'; d.close(); } };
    d.onclose = () => resolve(d.returnValue === 'yes' ? d : null);
    d.showModal();
    const first = d.querySelector('input') || d.querySelector('[data-dlg=yes]');
    if (first) first.focus();
  });
}
function refreshSavebar() { const sb = $('#savebar'); if (sb) sb.innerHTML = sysSavebar(); }

// ------------------------------------------------------------------ events
document.addEventListener('click', async (ev) => {
  const ib = ev.target.closest('[data-info]');
  if (ib) { ev.preventDefault(); ev.stopPropagation(); showInfo(ib); return; }
  if (!ev.target.closest('#pop')) hideInfo();
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const lane = b.dataset.lane !== undefined ? Number(b.dataset.lane) : undefined;
  try {
    if (act.startsWith('wiz') && await wizAct(act, b)) return;
    if (act === 'avpick') { openAvPick(b.dataset.name); return; }
    if (act === 'avview') {                                  // header avatar: just show it large
      const m = document.createElement('div'); m.id = 'avpk'; m.className = 'avbig';
      m.innerHTML = `<div class="avcard bigone"><div class="bigav ${isImg(S.me.icon) ? 'pic' : ''}">${isImg(S.me.icon) ? `<img src="${S.me.icon}" alt="">` : `<span>${S.me.icon ? esc(S.me.icon) : esc(S.me.user.charAt(0).toUpperCase())}</span>`}</div><b>${esc(S.me.user)}</b><span class="mut small">${isEditor() ? 'เปลี่ยนรูปได้ที่ ระบบ › ผู้ใช้' : ''}</span></div>`;
      document.body.appendChild(m); return;
    }
    if (act === 'logout') { await api('/api/logout', {method: 'POST', body: {}}); S.me = null; render(); }
    else if (act === 'toggle') openLane(lane);
    else if (act === 'addlane') addLane();
    else if (act === 'cancel') closeLane();
    else if (act === 'kind') { setKind(S.edit, b.dataset.k); render(); }
    else if (act === 'savelane') await saveLane();
    else if (act === 'clr') {
      const inp = document.getElementById(b.dataset.for);
      inp.value = '';
      inp.dispatchEvent(new Event('change', {bubbles: true}));
      inp.className = ''; b.classList.remove('on');
    } else if (act === 'dellane') {
      const id = S.edit.id;
      if (S.page === 'setup') { removeLane(S.draft, id); S.edit = null; keepDraft(); render(); }
      else if (await confirmDialog(`ลบเลน ${id}?`, '<p class="mut">จอของเลนนี้จะแสดง CONFIG</p>', 'ลบเลน')) {
        S.edit = null;
        await commitConfig(removeLane(clone(S.cfg), id), `ลบเลน ${id}`, `ลบเลน ${id}`);
      }
    } else if (act === 'identify') {
      const n = Number(b.dataset.disp);
      if (!n) return;
      await api('/api/control', {method: 'POST', body: {cmd: 'identify', display: n}});
      toast(`จอ B${n} แสดง TEST 5 วินาที`);
    } else if (act === 'find') {
      S.finder = {sid: b.dataset.sid, base: null, hits: {}, until: Date.now() + 20000};
      render();
    } else if (act === 'findstop') { S.finder = null; render(); }
    else if (act === 'maint') { await api('/api/control', {method: 'POST', body: {cmd: 'maintenance', lane, on: b.dataset.on === '1'}}); toast('ส่งคำสั่งแล้ว'); }
    else if (act === 'clearq') { if (await confirmDialog(`ล้างคิวเลน ${lane}?`, '<p class="mut">ใช้เมื่อรถที่ขอคิวไว้ออกไปแล้ว</p>', 'ล้างคิว')) await api('/api/control', {method: 'POST', body: {cmd: 'clear_queue', lane}}); }
    else if (act === 'vehs') { S.vehOff = !S.vehOff; keepView(); render(); }
    else if (act === 'flowreset') {
      if (await confirmDialog('เริ่มนับสรุปใหม่?', '<p class="mut">ตัวเลขสรุปทั้งหมดจะเริ่มจากศูนย์ ไม่กระทบการทำงานของไฟ</p>', 'เริ่มนับใหม่')) { FLOW.data = await api('/api/flow/reset', {method: 'POST', body: {}}); FLOW.at = Date.now(); flowRender(); toast('เริ่มนับใหม่แล้ว'); }
    }
    else if (act === 'setdir') {
      const id = Number(b.dataset.lane), d = Number(b.dataset.d);
      S.dirs[String(id)] = d; keepDirs();
      const o = S.layout.lanes[String(id)];
      if (o) { o.dir = d; await saveLayout(); }
      render();
    }
    else if (act === 'dir') {
      const o = S.layout.lanes[String(lane)], l = (S.cfg.lanes || []).find((x) => x.id === lane);
      if (o && l) { o.dir = (laneHeading(l) + 90) % 360; await saveLayout(); render(); toast(`ทิศรถเลน ${lane}: ${{0: '→ ขวา', 90: '↓ ลง', 180: '← ซ้าย', 270: '↑ ขึ้น'}[o.dir]}`); }
    }
    else if (act === 'v3d') { S.v3d = !S.v3d; keepView(); render(); }
    else if (act === 'cam') {
      const c = S.cam, k = b.dataset.k;
      if (k === 'rl') c.rz -= 15; else if (k === 'rr') c.rz += 15;
      else if (k === 'tu') c.tilt = Math.max(15, c.tilt - 8); else if (k === 'td') c.tilt = Math.min(80, c.tilt + 8);
      else if (k === 'zi') c.zoom = Math.min(2.5, Math.round((c.zoom + 0.1) * 10) / 10); else if (k === 'zo') c.zoom = Math.max(0.5, Math.round((c.zoom - 0.1) * 10) / 10);
      fit3d(); keepView();
    } else if (act === 'zoom') {
      const o = S.layout.lanes[String(lane)];
      if (o) { o.scale = clampScale((o.scale || 1) + Number(b.dataset.d) * 0.1); await saveLayout(); render(); }
    } else if (act === 'alerts') { const c = document.getElementById('alertcard'); if (c) c.scrollIntoView({behavior: 'smooth', block: 'center'}); }
    else if (act === 'rot' || act === 'unplace') {
      const key = String(lane);
      if (act === 'rot') S.layout.lanes[key].rot = ((S.layout.lanes[key].rot || 0) + 90) % 360;
      else { delete S.layout.lanes[key]; S.sel = null; }
      await saveLayout(); render();
    } else if (act === 'mapfull') { setMapFull(!S.mapFull); }
    else if (act === 'mapreset') { await api('/api/map/reset', {method: 'POST', body: {}}); await loadMap(); render(); }
    else if (act === 'template') await useTemplate();
    else if (act === 'resetdraft') {
      if (await confirmDialog('เริ่มใหม่?', '<p class="mut">ลบเลนทั้งหมดที่ตั้งไว้ในหน้านี้</p>', 'เริ่มใหม่')) { try { localStorage.removeItem('t3draft'); } catch (e) { /* ignore */ } S.draft = clone(S.cfg); S.draft.lanes = []; S.edit = null; render(); }
    } else if (act === 'finish') await finishSetup();
    else if (act === 'systab') {
      S.sysTab = b.dataset.tab;
      if (S.sysTab === 'history') S.versions = (await api('/api/versions')).versions;
      if (S.sysTab === 'users') { const u = await api('/api/users'); S.users = u.users; S.audit = u.audit; }
      render();
    } else if (act === 'syscat') { S.sysCat = b.dataset.cat; render(); }
    else if (act === 'gdef') { setPath(S.sys, b.dataset.path, clone(getPath(S.defaults, b.dataset.path))); render(); }
    else if (act === 'catdef') {
      const cat = CATS.find((x) => x[0] === b.dataset.cat);
      cat[2].forEach(([, rows]) => rows.forEach((r) => { if (r[0] === 'num' || r[0] === 'bool') setPath(S.sys, r[1], clone(getPath(S.defaults, r[1]))); }));
      render();
    } else if (act === 'syssave') await commitConfig(clone(S.sys), 'แก้ค่ารวม', 'บันทึกค่ารวม');
    else if (act === 'sysdiscard') { S.sys = clone(S.cfg); render(); }
    else if (act === 'restart') { if (await confirmDialog('รีสตาร์ตระบบควบคุม?', '<p class="mut">รอให้แยกว่างก่อน ระหว่างรีสตาร์ตทุกจอเป็น X</p>', 'รีสตาร์ต')) { await api('/api/control', {method: 'POST', body: {cmd: 'restart'}}); toast('จะรีสตาร์ตเมื่อแยกว่าง'); } }
    else if (act === 'reboot') { if (await confirmDialog('รีบูต Pi?', '<p class="mut">ประมาณ 1 นาที ระหว่างนั้นทุกจอแสดง LINK LOST</p>', 'รีบูต')) { await api('/api/reboot', {method: 'POST', body: {}}); toast('กำลังรีบูต'); } }
    else if (act === 'rollback') {
      if (await confirmDialog(`ย้อนกลับไป v${b.dataset.v}?`, '<p class="mut">บันทึกเป็นเวอร์ชันใหม่ แล้วใช้ค่าเมื่อแยกว่าง</p>', 'ย้อนกลับ')) {
        const r = await api('/api/rollback', {method: 'POST', body: {version: Number(b.dataset.v)}});
        await loadConfig(); S.sys = clone(S.cfg); S.versions = (await api('/api/versions')).versions; render(); toast(`ย้อนกลับเป็น v${r.version} แล้ว`);
      }
    } else if (act === 'userpw') {
      const d = await confirmDialog(`ตั้งรหัสใหม่ให้ ${b.dataset.name}`, '<input id="pw1" type="password" placeholder="รหัสผ่าน ≥ 8 ตัว" aria-label="รหัสผ่านใหม่">', 'บันทึก');
      if (d) { await api('/api/users', {method: 'POST', body: {name: b.dataset.name, password: d.querySelector('#pw1').value}}); toast('ตั้งรหัสใหม่แล้ว'); }
    } else if (act === 'userdel') {
      if (await confirmDialog(`ลบ ${b.dataset.name}?`, '', 'ลบ')) { await api('/api/users/delete', {method: 'POST', body: {name: b.dataset.name}}); const u = await api('/api/users'); S.users = u.users; S.audit = u.audit; render(); }
    }
  } catch (e) { toast(e.message, true); }
});

function readNum(t) { return t.value === '' ? undefined : Number(t.value); }
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.type !== 'number') return;
  const v = readNum(t);
  const bad = v !== undefined && (isNaN(v) || v < Number(t.min) || v > Number(t.max));
  t.classList.toggle('bad', bad);
  if (t.dataset.g) t.classList.toggle('chg', !bad && JSON.stringify(v) !== JSON.stringify(getPath(S.cfg, t.dataset.g)));
  else if (t.dataset.p || t.dataset.sk) {
    t.classList.toggle('set', !bad && v !== undefined);
    const r = t.parentElement.querySelector('.rst');
    if (r) r.classList.toggle('on', v !== undefined);
  }
});
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  try {
    if (t.dataset.themeToggle !== undefined) { setTheme(t.checked ? 'dark' : 'light'); return; }
    if (S.edit && t.dataset.e) {
      const k = t.dataset.e;
      let v = t.value;
      if (k === 'display') v = v ? parseInt(v, 10) : null;
      else if (k === 'enabled') v = t.checked;
      else if (t.dataset.num) v = Number(v || 0);
      S.edit.lane[k] = v;
      if (k === 'display') render();
    } else if (S.edit && t.dataset.p) {
      S.edit.lane.params = S.edit.lane.params || {};
      const v = readNum(t);
      if (v === undefined) delete S.edit.lane.params[t.dataset.p]; else S.edit.lane.params[t.dataset.p] = v;
    } else if (S.edit && t.dataset.sk) {
      const s = S.edit.sensors[t.dataset.sid];
      const v = readNum(t);
      if (v === undefined) delete s[t.dataset.sk]; else s[t.dataset.sk] = v;
    } else if (S.edit && t.dataset.port) {
      const used = t.value && portUsedBy(srcCfg(), S.edit, t.value, t.dataset.port);
      if (used) { toast(`พอร์ตนี้ใช้กับ ${used.sid} อยู่แล้ว`, true); render(); return; }
      S.edit.sensors[t.dataset.port].port = t.value;
      render();
    } else if (t.dataset.g !== undefined) {
      const target = S.page === 'setup' ? S.draft : S.sys;
      let v = t.value;
      if (t.dataset.num) v = readNum(t);
      if (t.dataset.bool) v = t.checked;
      setPath(target, t.dataset.g, v);
      if (S.page === 'setup') { keepDraft(); return; }
      refreshSavebar();
      const row = t.closest('.li-row'), dv = getPath(S.defaults, t.dataset.g);
      if (row && t.dataset.num && dv !== undefined) {
        const nd = JSON.stringify(v) !== JSON.stringify(dv);
        row.querySelector('.dflt').textContent = nd ? `ค่าเริ่มต้น ${dv}` : '';
        row.querySelector('.rst').classList.toggle('on', nd);
      }
    } else if (t.dataset.reserve) {
      const list = new Set(getPath(S.sys, 'frames.enabled_reserve') || []);
      if (t.checked) list.add(t.dataset.reserve); else list.delete(t.dataset.reserve);
      setPath(S.sys, 'frames.enabled_reserve', [...list]);
      refreshSavebar();
    } else if (t.dataset.usericon !== undefined) {
      await api('/api/users', {method: 'POST', body: {name: t.dataset.usericon, icon: t.value}});
      if (t.dataset.usericon === S.me.user) S.me.icon = t.value;
      const u = await api('/api/users'); S.users = u.users; render(); toast('เปลี่ยนไอคอนแล้ว');
    } else if (t.dataset.userrole) {
      await api('/api/users', {method: 'POST', body: {name: t.dataset.userrole, role: t.value}}); toast('เปลี่ยนสิทธิ์แล้ว');
    } else if (t.dataset.ota) {
      const f = t.files[0];
      if (!f) return;
      if (await confirmDialog(`อัปเดตเฟิร์มแวร์จอ B${t.dataset.ota}?`, `<p>${esc(f.name)} · ${Math.round(f.size / 1024)} KB</p><p class="mut small">ระบบปิดเลนของจอนี้ก่อน เสร็จแล้วตรวจภาพบนจอ แล้วกด “เปิดเลน”</p>`, 'อัปเดต')) {
        const r = await api('/api/ota/' + t.dataset.ota, {method: 'POST', raw: true, body: await f.arrayBuffer()});
        toast(r.message);
      }
      t.value = '';
    } else if (t.dataset.mapfile !== undefined) {
      const f = t.files[0];
      if (!f) return;
      await api('/api/map', {method: 'POST', raw: true, body: await f.arrayBuffer()});
      await loadMap(); render(); toast('เปลี่ยนรูปแผนที่แล้ว');
    }
  } catch (e) { toast(e.message, true); }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    if (f.id === 'loginform') {
      S.loginErr = '';
      const lu = f.querySelector('#lu').value, lp = f.querySelector('#lp').value;
      if (S.setupNeeded) {                                   // first account, created on the Pi's own screen
        if (lp !== f.querySelector('#lp2').value) throw new Error('รหัสผ่านสองช่องไม่ตรงกัน');
        await api('/api/setup/first-user', {method: 'POST', body: {user: lu, password: lp}});
      } else await api('/api/login', {method: 'POST', body: {user: lu, password: lp}});
      await start();
    } else if (f.id === 'adduser') {
      await api('/api/users', {method: 'POST', body: {name: f.querySelector('#nu').value, password: f.querySelector('#np').value, icon: f.querySelector('#ni').value, role: f.querySelector('#nr').value}});
      const u = await api('/api/users'); S.users = u.users; S.audit = u.audit; render(); toast('เพิ่มผู้ใช้แล้ว');
    }
  } catch (e) {
    if (f.id === 'loginform') { S.loginErr = e.message; render(); } else toast(e.message, true);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirtyEdit() || (S.dr && S.dr.dirty) || (S.sys && S.cfg && S.page === 'system' && diff(S.cfg, S.sys).length)) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('hashchange', () => {
  const p = (location.hash || '#map').slice(1);
  if (!['map', 'system'].includes(p)) return;
  S.edit = null; S.finder = null; S.sel = null; S.dr = null;
  S.page = p;
  if (p === 'system') S.sys = clone(S.cfg);
  render();
});

async function start() {
  const me = await api('/api/me');
  if (!me.user) { S.me = null; S.setupNeeded = me.setup_needed; render(); return; }
  S.me = me;
  await loadConfig();
  await Promise.all([loadLayout(), loadMap(), loadPorts(), loadDrawing()]);
  if (!(S.cfg.lanes || []).length) initDraft();
  const p = (location.hash || '#map').slice(1);
  S.page = ['map', 'system'].includes(p) ? p : 'map';
  S.sys = clone(S.cfg);
  await pollState();
  if (isEditor()) await wizInit();
  render();
}

setInterval(() => { if (S.me) pollState(); }, 600);
setInterval(() => { if (S.me && S.edit) loadPorts(); }, 10000);
start();
