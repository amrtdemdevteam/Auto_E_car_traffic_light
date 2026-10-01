'use strict';
/* Animated 3D vehicles on the 3D map (docs/T3_DESIGN.md 12.7)
 *
 * Auto = tow tractor with a tower lamp, Manual = tow tractor with the driver standing on it.
 * The controller does not know where a vehicle is, so the animation is a simulation driven
 * by what it does know, in real time: a vehicle appears when the far sensor (Auto) or the
 * sensor / ticket of the lane (Manual) sees one, drives to the stop line, waits there while
 * the lane is not green, and drives through when the controller gives that lane the green.
 * Positions are therefore illustrative, not measured. Loaded before app.js. */

const VL = 94, VMAX = 130, VACC = 170, VDEC = 220;      // vehicle length (drawing units, model drawn 72 long and scaled 1.3), speed and acceleration in units / s
const V_ENTRY = 280, V_AFTER = 380;                     // path length before the stop line / after it
const HEAD = {N: 90, S: 270, E: 180, W: 0};             // approach side -> heading (0 = right, 90 = down, 180 = left, 270 = up)
const VEH = {list: [], seq: 0, cool: {}, clr: {}, idle: {}, host: null, els: new Map(), last: 0};

function laneHeading(l) {
  const pos = (S.layout.lanes || {})[String(l.id)] || {};
  if (pos.dir !== undefined) return pos.dir;
  if (S.dirs && S.dirs[String(l.id)] !== undefined) return S.dirs[String(l.id)];
  return HEAD[l.approach] !== undefined ? HEAD[l.approach] : 270;
}
// where the lane's vehicles run: start point, unit vector, stop position along the path
function vPath(l) {
  const pos = (S.layout.lanes || {})[String(l.id)];
  if (!pos) return null;
  const stopC = 34 + VL / 2;                            // centre of a waiting vehicle, behind the lane widget
  const drawn = ((S.drawing && S.drawing.items) || []).find((it) => it.type === 'lanepath' && it.lane === l.id);
  if (drawn) return drawnPath(drawn, pos, stopC);        // the engineer drew this lane's route on the map
  const a = laneHeading(l) * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
  const sx = pos.x * 1000 - ux * stopC, sy = pos.y * 700 - uy * stopC;
  const x0 = sx - ux * V_ENTRY, y0 = sy - uy * V_ENTRY, ang = laneHeading(l);
  return {ang, at: (s) => ({x: x0 + ux * s, y: y0 + uy * s, a: ang}), stop: V_ENTRY, end: V_ENTRY + stopC + V_AFTER};
}
// a drawn route (rounded polyline): position and heading at distance s; the stop point is the spot nearest the lane widget
const VPATH_CACHE = new Map();
function drawnPath(it, pos, stopC) {
  const c = VPATH_CACHE.get(it.lane);
  if (c && c.it === it && c.px === pos.x && c.py === pos.y) return c.P;
  const pts = dSmooth(it.pts), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1], wx = pos.x * 1000, wy = pos.y * 700;
  let best = 0, bd = 1 / 0;
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - wx, p[1] - wy); if (d < bd) { bd = d; best = i; } });
  const at = (s) => {
    s = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i], seg = (cum[i] - cum[i - 1]) || 1, t = (s - cum[i - 1]) / seg;
    return {x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, a: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI};
  };
  const P = {ang: at(0).a, at, stop: Math.max(0, Math.min(total - 1, cum[best] - stopC)), end: total};
  VPATH_CACHE.set(it.lane, {it, px: pos.x, py: pos.y, P});
  return P;
}
const isWaiting = (v) => v.phase !== 'go';

function vehSpawn(l, s, phase) {
  VEH.list.push({id: ++VEH.seq, lane: l.id, kind: kindOf(l) === 'auto' ? 'auto' : 'manual', s, v: phase === 'go' ? 60 : 50, phase, fade: 0});
}

// called on every status poll: decide which vehicles exist and which may go
function vehSync() {
  const st = S.state, now = Date.now();
  if (!st || S.stale || !S.cfg) { VEH.list = []; return; }
  const occ = {};
  (st.sensors || []).forEach((x) => { occ[x.id] = !!x.occupied; });
  const q = st.queue || [];
  const lanes = (S.cfg.lanes || []).filter((l) => S.layout.lanes[String(l.id)]);
  VEH.list = VEH.list.filter((v) => lanes.some((l) => l.id === v.lane));
  lanes.forEach((l) => {
    const P = vPath(l), mine = VEH.list.filter((v) => v.lane === l.id);
    const sens = laneSensors(l), far = sens.find((x) => x.role === 'far'), near = sens.find((x) => x.role === 'near');
    const farOcc = far ? occ[far.sid] : false;
    const anyOcc = sens.some((x) => occ[x.sid]);
    const tickets = q.some((t) => t.lane === l.id);
    const green = st.state === 'GREEN' && st.active_lane === l.id;
    const leaving = mine.some((v) => v.phase === 'go' && v.s < P.stop + VL * 1.3);   // a vehicle is still passing the sensors
    if (!anyOcc) VEH.clr[l.id] = true;                    // the sensors were free since the last vehicle went
    const cooled = (VEH.cool[l.id] || 0) < now && VEH.clr[l.id] !== false;
    if (green) {
      const flip = mine.filter(isWaiting);
      flip.forEach((v) => { v.phase = 'go'; VEH.cool[l.id] = now + 3500; VEH.clr[l.id] = anyOcc ? false : true; });
      if (anyOcc && !leaving && cooled && !flip.length) { vehSpawn(l, Math.max(0, P.stop - 70), 'go'); VEH.cool[l.id] = now + 3500; VEH.clr[l.id] = false; }
      VEH.idle[l.id] = now;
      return;
    }
    const want = kindOf(l) === 'auto' ? (farOcc || anyOcc || tickets) : (anyOcc || tickets);
    if (want) VEH.idle[l.id] = now;
    const waiting = mine.filter(isWaiting);
    if (want && !waiting.length && !leaving && cooled) vehSpawn(l, kindOf(l) === 'auto' && farOcc && !anyOcc ? 0 : Math.max(0, P.stop - 170), 'approach');
    if (!want && waiting.length && now - (VEH.idle[l.id] || now) > 5000) waiting.forEach((v) => { v.fade = 1; });   // the request went away: the vehicle drives off
  });
}

// one animation step (dt in seconds)
function vehStep(dt) {
  const st = S.state, by = {};
  VEH.list.forEach((v) => { (by[v.lane] = by[v.lane] || []).push(v); });
  Object.keys(by).forEach((id) => {
    const l = ((S.cfg && S.cfg.lanes) || []).find((x) => x.id === Number(id)), P = l && vPath(l);
    if (!P) return;
    const q = by[id].filter(isWaiting).sort((a, b) => b.s - a.s);
    q.forEach((v, i) => {
      const target = P.stop - i * (VL + 16), dist = target - v.s;
      if (v.fade) return;
      if (dist <= 0.6) { v.s = target; v.v = 0; v.phase = 'wait'; return; }
      v.phase = 'approach';
      v.v = Math.min(VMAX, v.v + VACC * dt, Math.sqrt(2 * VDEC * dist) + 8);
      v.s = Math.min(target, v.s + v.v * dt);
    });
    by[id].filter((v) => !isWaiting(v)).forEach((v) => { v.v = Math.min(VMAX, v.v + VACC * dt); v.s += v.v * dt; });
  });
  VEH.list.forEach((v) => { if (v.fade) v.fade += dt; });
  VEH.list = VEH.list.filter((v) => {
    const l = ((S.cfg && S.cfg.lanes) || []).find((x) => x.id === v.lane), P = l && vPath(l);
    return P && v.s < P.end && v.fade < 1.2;
  });
}

// ------------------------------------------------------------------ models (CSS 3D boxes)
function vbox(x0, y0, z0, x1, y1, z1, color, cls = '') {
  const w = x1 - x0, d = y1 - y0, H = z1 - z0, c = color ? `--c:${color};` : '';
  const side = (l, t, wd, ht, tf, b) => `<i class="fc side" style="left:${l}px;top:${t}px;width:${wd}px;height:${ht}px;transform-origin:0 0;transform:translateZ(${z0}px) ${tf};filter:brightness(${b})"></i>`;
  return `<div class="bx ${cls}" style="left:${x0}px;top:${y0}px;width:${w}px;height:${d}px;${c}--s:transparent;--sw:0px;--r:0px">`
    + `<i class="fc top" style="transform:translateZ(${z1}px)"></i>`
    + side(0, 0, w, H, 'rotateX(90deg)', .86) + side(0, d, w, H, 'rotateX(90deg)', .72)
    + side(0, 0, H, d, 'rotateY(-90deg)', .8) + side(w, 0, H, d, 'rotateY(-90deg)', .66) + '</div>';
}
function vehModelHtml(kind) {
  const GREY = '#66686d', DARK = '#1c1c1e', CREAM = '#efe9d3';
  const ORG = kind === 'auto' ? '#e8722a' : '#7cc4a2';                            // Auto orange, Manual green (Toyota 7CBTY style)
  let m = vbox(-36, -15, 6, 36, 15, 16, GREY)                                   // chassis
    + vbox(8, -13, 16, 36, 13, 30, '#7c7e83')                                   // front cover
    + vbox(-34, -19, 10, 20, -15, 27, ORG) + vbox(-34, 15, 10, 20, 19, 27, ORG) // fenders
    + vbox(-39, -14, 14, -34, 14, 36, ORG)                                      // rear plate
    + [[-30, -20], [-30, 14], [14, -20], [14, 14]].map(([x, y]) => vbox(x, y, 0, x + 17, y + 6, 16, DARK)).join('');   // wheels
  if (kind === 'auto') {
    m += vbox(-31, -9, 16, -17, 9, 64, CREAM) + vbox(-17, -6, 30, -15, 6, 52, DARK)   // mast + panel
      + vbox(-27, -4, 64, -21, 4, 70, null, 'lamp lr') + vbox(-27, -4, 70, -21, 4, 76, null, 'lamp la') + vbox(-27, -4, 76, -21, 4, 82, null, 'lamp lg');  // tower lamp
  } else {
    const MINT = '#7cc4a2', WHT = '#f2f4f3', BK = '#141416';           // Toyota 7CBT: scooter style, seated driver
    m += vbox(-38, -14, 10, -4, 14, 40, MINT) + vbox(-4, -11, 10, 8, 11, 16, MINT)      // rear cowl + floor
      + vbox(-40, -8, 40, -34, 8, 66, MINT)                                             // backrest post
      + vbox(-39, -8, 50, -33, 8, 64, BK)                                               // backrest pad
      + vbox(-26, -8, 40, -6, 8, 44, BK)                                                // seat
      + vbox(10, -8, 14, 22, 8, 56, WHT) + vbox(12, -5, 56, 20, 5, 62, BK)              // front column + steering head
      + vbox(12, -14, 61, 18, 14, 64, BK) + vbox(14, -14, 64, 17, -12, 72, GREY) + vbox(14, 12, 64, 17, 14, 72, GREY)   // handlebar + mirrors
      + vbox(-24, -6, 44, -12, 6, 66, BK) + vbox(-22, -4, 66, -14, 4, 76, BK)           // torso + head
      + vbox(-12, -6, 44, 8, -1, 50, BK) + vbox(-12, 1, 44, 8, 6, 50, BK) + vbox(6, -6, 16, 10, -1, 46, BK) + vbox(6, 1, 16, 10, 6, 46, BK);  // thighs + shins
  }
  return `<div class="mdl">${m}</div>`;
}

// ------------------------------------------------------------------ drawing (runs every animation frame)
function vehRender(dt) {
  const host = document.getElementById('vehs');
  if (!host || S.vehOff) { if (VEH.host) { VEH.els.clear(); VEH.host = null; } return; }
  if (VEH.host !== host) { VEH.host = host; VEH.els.clear(); }
  const alive = new Set();
  VEH.list.forEach((v) => {
    const l = ((S.cfg && S.cfg.lanes) || []).find((x) => x.id === v.lane), P = l && vPath(l);
    if (!P) return;
    alive.add(v.id);
    let el = VEH.els.get(v.id);
    if (!el) { el = document.createElement('div'); el.className = 'veh'; el.innerHTML = vehModelHtml(v.kind); host.appendChild(el); VEH.els.set(v.id, el); }
    const q = P.at(v.s), x = q.x, y = q.y;
    const fadeIn = Math.min(1, v.s / 40 + 0.15), fadeOut = Math.min(1, (P.end - v.s) / 90), gone = v.fade ? Math.max(0, 1 - v.fade / 1.2) : 1;
    el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotateZ(${q.a.toFixed(1)}deg)`;
    el.style.opacity = String(Math.max(0, Math.min(fadeIn, fadeOut, gone)));
    el.dataset.lamp = v.phase === 'go' ? 'g' : v.phase === 'wait' ? 'r' : 'a';
  });
  VEH.els.forEach((el, id) => { if (!alive.has(id)) { el.remove(); VEH.els.delete(id); } });
}
function vehLoop(ts) {
  const dt = Math.min(0.1, (ts - (VEH.last || ts)) / 1000);
  VEH.last = ts;
  if (dt > 0) { vehStep(dt); vehRender(dt); }
  requestAnimationFrame(vehLoop);
}
requestAnimationFrame(vehLoop);
