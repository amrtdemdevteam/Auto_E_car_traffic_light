'use strict';
/* Lane timing: queue position, wait / green countdown, and the timeline (docs/T3_DESIGN.md 12.6)
 *
 * Only the web page does this. It watches the status it already polls, remembers how long
 * each lane really stayed green and how long it really waited, and uses those averages to
 * estimate the wait of the tickets in the queue. Numbers marked "≈" are estimates:
 * only the hand lane (fixed green time) and the Auto ticket expiry are exact.
 * Loaded before app.js; it reads the global state S when called. */

const TL_PAST = 60, TL_FUT = 30, TL_KEEP = 8;      // seconds shown before / after now; samples kept per lane
const T = {cur: null, red: null, wait: {}, segs: [], first: true, stats: {}};
try { T.stats = JSON.parse(localStorage.getItem('t3stats') || '{}') || {}; } catch (e) { T.stats = {}; }
const tlNow = () => Date.now() / 1000;
const tlAvg = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function tlPush(id, key, v) {
  const s = T.stats[id] = T.stats[id] || {g: [], w: []};
  s[key].push(Math.round(v * 10) / 10);
  if (s[key].length > TL_KEEP) s[key].shift();
  try { localStorage.setItem('t3stats', JSON.stringify(T.stats)); } catch (e) { /* ignore */ }
}
const laneById = (id) => ((S.cfg && S.cfg.lanes) || []).find((x) => x.id === id);
const laneTiming = (l) => ({...((S.cfg && S.cfg.timing) || {}), ...((l && l.params) || {})});

// expected green time of a lane: measured average, else a guess from its settings
function estGreen(l) {
  const m = tlAvg((T.stats[l.id] || {}).g), tm = laneTiming(l), k = kindOf(l);
  if (k === 'hand') return {v: tm.special_green_s, exact: true};
  if (m !== null) return {v: m, exact: false};
  return {v: (k === 'auto' ? tm.auto_clear_s : tm.manual_clear_s) + 2, exact: false, guess: true};
}

// called on every status poll
function tlTrack() {
  const st = S.state, now = tlNow();
  const live = !!(st && !S.stale);
  const act = live && st.state === 'GREEN' ? st.active_lane : null;
  const closeGreen = () => {
    if (!T.cur) return;
    T.segs.push({kind: 'green', lane: T.cur.lane, t0: T.cur.t0, t1: now});
    if (!T.cur.partial) tlPush(T.cur.lane, 'g', now - T.cur.t0);
    T.cur = null;
  };
  if (!live) { closeGreen(); T.first = true; T.wait = {}; return; }
  if (!T.cur || T.cur.lane !== act) {
    closeGreen();
    if (act !== null) {
      const w0 = T.wait[act];
      if (w0 !== undefined) { T.segs.push({kind: 'wait', lane: act, t0: w0, t1: now}); tlPush(act, 'w', now - w0); }
      T.cur = {lane: act, t0: now, partial: T.first};
    }
  }
  const red = st.state === 'SWITCHING' || st.state === 'FAULT_HOLD';
  if (red && !T.red) T.red = {t0: now};
  if (!red && T.red) { T.segs.push({kind: 'red', t0: T.red.t0, t1: now}); T.red = null; }
  const seen = {};
  (st.queue || []).forEach((t) => { const t0 = now - t.age_s; if (seen[t.lane] === undefined || t0 < seen[t.lane]) seen[t.lane] = t0; });
  Object.keys(T.wait).forEach((k) => { if (seen[k] === undefined) delete T.wait[k]; });
  Object.keys(seen).forEach((k) => { if (T.wait[k] === undefined) T.wait[k] = seen[k]; });
  T.first = false;
  T.segs = T.segs.filter((s) => s.t1 > now - TL_PAST - 5);
}

// the queue laid out in time: [{lane, t0, t1, wait}] with the current green's remaining time in `until`
function tlPlan() {
  const st = S.state, now = tlNow(), out = {blocks: [], until: now};
  if (!st || S.stale) return out;
  let cursor = now;
  if (T.cur) {
    const l = laneById(T.cur.lane);
    if (l) { const e = estGreen(l), el = now - T.cur.t0; cursor = now + Math.max(e.exact ? 0 : 1, e.v - el); }
  }
  out.until = cursor;
  const bar = ((S.cfg.timing || {}).switch_all_red_s || 1) + 0.5, used = {};
  (st.queue || []).forEach((t) => {
    const l = laneById(t.lane);
    if (!l || used[t.lane] || (T.cur && T.cur.lane === t.lane)) return;
    used[t.lane] = true;
    cursor += bar;
    const g = estGreen(l);
    out.blocks.push({lane: t.lane, t0: cursor, t1: cursor + g.v, wait: cursor - now, exact: g.exact, guess: g.guess});
    cursor += g.v;
  });
  return out;
}

// queue position + wait / green time on every lane row
function updateLaneQueue() {
  const st = S.state, live = !!(st && !S.stale), q = live ? (st.queue || []) : [], now = tlNow(), plan = tlPlan();
  document.querySelectorAll('[data-lq]').forEach((el) => {
    const id = Number(el.dataset.lq), l = laneById(id);
    let html = '';
    if (l && live) {
      if (T.cur && T.cur.lane === id) {
        const el_s = now - T.cur.t0, e = estGreen(l);
        if (e.exact) html = `<b class="g">เขียว · เหลือ ${Math.max(0, e.v - el_s).toFixed(1)} s</b><span class="lbar g"><i style="width:${Math.max(0, Math.min(100, 100 * (1 - el_s / e.v)))}%"></i></span>`;
        else html = `<b class="g">เขียว ${el_s.toFixed(1)} s</b><span class="mono">เฉลี่ย ${e.guess ? '≈' : ''}${e.v.toFixed(1)} s</span><span class="lbar g"><i style="width:${Math.min(100, 100 * el_s / e.v)}%"></i></span>`;
      } else {
        const pos = q.map((t, i) => (t.lane === id ? i + 1 : 0)).filter(Boolean);
        if (pos.length) {
          const tk = q.find((t) => t.lane === id), b = plan.blocks.find((x) => x.lane === id);
          const auto = q.find((t) => t.lane === id && t.kind === 'auto' && !t.matched);
          const tm = laneTiming(l);
          const exp = auto ? `<span class="mono">หมดอายุ ${Math.max(0, tm.auto_ticket_expiry_s - auto.age_s).toFixed(1)} s</span>` : '';
          const p = b ? 100 * tk.age_s / (tk.age_s + Math.max(0.1, b.wait)) : 0;
          html = `<b>คิว ${pos.join(',')}</b><span class="mono">รอ ${tk.age_s} s</span>${b ? `<span class="mono">≈อีก ${b.wait.toFixed(0)} s</span>` : ''}${exp}<span class="lbar w"><i style="width:${Math.min(100, p)}%"></i></span>`;
        }
      }
    }
    if (el._h !== html) { el._h = html; el.innerHTML = html; }
  });
}

// the timeline card under the map
function tlRender() {
  const host = document.getElementById('tl');
  if (!host) return;
  const lanes = (S.cfg && S.cfg.lanes) || [], now = tlNow(), st = S.state;
  if (!lanes.length) { host.innerHTML = ''; return; }
  const plan = tlPlan(), X0 = 150, X1 = 990, RH = 38, TOP = 26, Hh = TOP + lanes.length * RH + 6, span = TL_PAST + TL_FUT;
  const x = (t) => X0 + (X1 - X0) * Math.max(-1, Math.min(2, (t - (now - TL_PAST)) / span)), xn = x(now);
  const clip = (a, b) => [Math.max(a, now - TL_PAST), Math.min(b, now + TL_FUT)];
  let g = '';
  for (let s = -TL_PAST; s <= TL_FUT; s += 10) g += `<line class="tg" x1="${x(now + s)}" x2="${x(now + s)}" y1="${TOP - 4}" y2="${Hh - 4}"/><text class="tt" x="${x(now + s)}" y="14" text-anchor="middle">${s === 0 ? 'ตอนนี้' : (s > 0 ? '+' : '−') + Math.abs(s)}</text>`;
  const reds = T.segs.filter((s) => s.kind === 'red').concat(T.red ? [{t0: T.red.t0, t1: now}] : []);
  reds.forEach((s) => { const [a, b] = clip(s.t0, s.t1); if (b > a) g += `<rect class="tred" x="${x(a)}" y="${TOP - 4}" width="${Math.max(1.5, x(b) - x(a))}" height="${Hh - TOP}"><title>ทุกจอ X ${(s.t1 - s.t0).toFixed(1)} s</title></rect>`; });
  lanes.forEach((l, i) => {
    const y = TOP + i * RH, s = T.stats[l.id] || {}, ag = tlAvg(s.g), aw = tlAvg(s.w);
    g += `<text class="tl1" x="0" y="${y + 15}">เลน ${l.id} <tspan class="tk">${kindOf(l) === 'auto' ? 'Auto' : 'Manual'}</tspan></text>`
      + `<text class="tt" x="0" y="${y + 29}">เขียว ${ag !== null ? '≈' + ag.toFixed(1) : '—'} s · รอ ${aw !== null ? '≈' + aw.toFixed(0) : '—'} s</text>`
      + `<line class="tg" x1="${X0}" x2="${X1}" y1="${y + RH - 3}" y2="${y + RH - 3}"/>`;
    const seg = (a, b, cls, tip) => { const [c, d] = clip(a, b); if (d > c) g += `<rect class="${cls}" x="${x(c)}" y="${y + 3}" width="${Math.max(2, x(d) - x(c))}" height="20" rx="4"><title>${tip}</title></rect>`; };
    T.segs.filter((z) => z.lane === l.id).forEach((z) => seg(z.t0, z.t1, z.kind === 'green' ? 'tgrn' : 'twait', `${z.kind === 'green' ? 'เขียว' : 'รอ'} ${(z.t1 - z.t0).toFixed(1)} s`));
    if (T.cur && T.cur.lane === l.id) seg(T.cur.t0, now, 'tgrn', `เขียว ${(now - T.cur.t0).toFixed(1)} s`);
    if (T.wait[l.id] !== undefined && !(T.cur && T.cur.lane === l.id)) seg(T.wait[l.id], now, 'twait', `รอมาแล้ว ${(now - T.wait[l.id]).toFixed(1)} s`);
    const p = plan.blocks.find((b) => b.lane === l.id);
    if (p) { seg(p.t0, p.t1, 'tplan', `คาดว่าเขียว ≈${(p.t1 - p.t0).toFixed(1)} s (รอ ≈${p.wait.toFixed(0)} s)`); }
    else if (T.cur && T.cur.lane === l.id) { const e = estGreen(l); if (!e.exact && now - T.cur.t0 < e.v) seg(now, T.cur.t0 + e.v, 'tplan', `เฉลี่ยเขียว ≈${e.v.toFixed(1)} s`); }
  });
  g += `<line class="tnow" x1="${xn}" x2="${xn}" y1="${TOP - 4}" y2="${Hh - 4}"/>`;
  host.innerHTML = `<svg viewBox="0 0 1000 ${Hh}" role="img" aria-label="ไทม์ไลน์เวลาเขียวและเวลารอของแต่ละเลน">${g}</svg>`;
  const sub = document.getElementById('tl-sub');
  if (sub) sub.textContent = st && !S.stale ? (plan.blocks.length ? `คิวที่รอ ${plan.blocks.length} เลน · เลนสุดท้ายได้เขียวอีก ≈${plan.blocks[plan.blocks.length - 1].wait.toFixed(0)} s` : 'ไม่มีคิว') : 'ไม่มีข้อมูลจากระบบควบคุม';
}

/* ---------------------------------------------------------------- summary since power-on (12.8)
 * The numbers come from the web service (/api/flow), which counts them from the controller status
 * and keeps them across restarts; this only draws them. */
const FLOW = {data: null, at: 0, busy: false};
async function flowFetch(force) {
  const now = Date.now();
  if (FLOW.busy || (!force && now - FLOW.at < 5000)) return;
  FLOW.busy = true; FLOW.at = now;
  try { FLOW.data = await api('/api/flow'); } catch (e) { /* keep the last one */ }
  FLOW.busy = false;
  flowRender();
}
const fmtS = (s) => (s == null ? '–' : s >= 3600 ? `${Math.floor(s / 3600)} ชม. ${Math.round(s % 3600 / 60)} น.` : s >= 120 ? `${Math.floor(s / 60)} น. ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`);
const pct = (v) => `${Math.round((v || 0) * 1000) / 10}%`;
function flowInsights(f, lanes) {
  const rows = lanes.map((l) => ({l, d: f.lanes[String(l.id)]})).filter((r) => r.d);
  const out = [];
  const nm = (r) => `เลน ${r.l.id}${r.l.name ? ` (${esc(r.l.name)})` : ''}`;
  const withWait = rows.filter((r) => r.d.wait_avg_s != null);
  if (withWait.length > 1) {
    const w = withWait.reduce((a, b) => (b.d.wait_avg_s > a.d.wait_avg_s ? b : a)), m = withWait.reduce((a, b) => (b.d.wait_avg_s < a.d.wait_avg_s ? b : a));
    if (w.d.wait_avg_s > m.d.wait_avg_s * 1.5 && w.d.wait_avg_s - m.d.wait_avg_s > 5) out.push(`${nm(w)} รอนานสุด เฉลี่ย ${fmtS(w.d.wait_avg_s)} (เร็วสุด ${nm(m)} ${fmtS(m.d.wait_avg_s)})`);
  }
  const busy = rows.filter((r) => r.d.served > 0 && r.d.greens > 0);
  if (busy.length > 1) { const b = busy.reduce((x, y) => (y.d.served > x.d.served ? y : x)); out.push(`${nm(b)} ใช้แยกมากสุด ผ่าน ${b.d.served} ครั้ง คิดเป็น ${pct(b.d.green_of_all)} ของเวลาเขียวทั้งหมด`); }
  rows.filter((r) => r.d.expired > 0).forEach((r) => out.push(`${nm(r)} มีคำขอหมดอายุ ${r.d.expired} ครั้ง (คนขอแล้วไม่เข้ามา หรือเซนเซอร์ไม่เห็นรถ)`));
  rows.filter((r) => r.d.faults > 0).forEach((r) => out.push(`${nm(r)} ขัดข้อง ${r.d.faults} ครั้ง ปิดใช้งานรวม ${fmtS(r.d.unavailable_s)}`));
  if (f.total_s > 0 && f.allred_s / f.total_s > 0.25) out.push(`เวลา "ทุกจอ X" คิดเป็น ${pct(f.allred_s / f.total_s)} ของเวลา สลับเลนถี่ ลองดูเวลาเผื่อสลับ/เวลาเขียวขั้นต่ำ`);
  if (!out.length) out.push(f.total_s < 300 ? 'ยังเก็บข้อมูลไม่นาน ตัวเลขจะน่าเชื่อถือขึ้นเมื่อมีรถผ่านมากขึ้น' : 'ยังไม่พบความผิดปกติในการไหลของรถ');
  return out;
}
function flowRender() {
  const host = document.getElementById('flow');
  if (!host) return;
  const f = FLOW.data, lanes = (S.cfg && S.cfg.lanes) || [];
  const sub = document.getElementById('flow-sub');
  if (!f || !lanes.length) { host.innerHTML = '<div class="mut" style="padding:8px 18px 14px">ยังไม่มีข้อมูล</div>'; return; }
  const since = f.since ? new Date(f.since * 1000).toLocaleString('th-TH', {dateStyle: 'short', timeStyle: 'short'}) : '–';
  if (sub) sub.textContent = `ตั้งแต่ ${since} · เก็บข้อมูลแล้ว ${fmtS(f.total_s)}${f.gaps ? ` · ขาดช่วง ${f.gaps} ครั้ง` : ''}`;
  const tot = f.total_s || 1;
  const chips = `<div class="fchips"><span><b>${pct(f.allred_s / tot)}</b>ทุกจอ X (${fmtS(f.allred_s)})</span><span><b>${pct(f.fault_s / tot)}</b>ค้างเผื่อเสีย (${fmtS(f.fault_s)})</span><span><b>${pct(f.idle_s / tot)}</b>ว่างไม่มีคิว (${fmtS(f.idle_s)})</span></div>`;
  const rows = lanes.map((l) => {
    const d = f.lanes[String(l.id)] || {greens: 0, green_s: 0, requests: 0, served: 0, expired: 0, queue_peak: 0, faults: 0, green_of_all: 0, green_share: 0};
    return `<tr><td><b>${l.id}</b> ${esc(l.name || '')}<small>${kindOf(l) === 'auto' ? 'Auto' : 'Manual'}</small></td>
      <td>${d.greens}</td><td>${fmtS(d.green_avg_s)}<small>${d.green_min_s == null ? '' : `${fmtS(d.green_min_s)} – ${fmtS(d.green_max_s)}`}</small></td>
      <td>${fmtS(d.wait_avg_s)}<small>${d.served ? `สูงสุด ${fmtS(d.wait_max_s)}` : ''}</small></td>
      <td>${d.requests}<small>ผ่าน ${d.served} · หมดอายุ ${d.expired}</small></td>
      <td>${d.queue_peak}</td><td>${d.served_per_hour == null ? '–' : d.served_per_hour}</td>
      <td><span class="lbar g" title="สัดส่วนเวลาเขียวเทียบเวลาทั้งหมด ${pct(d.green_share)}"><i style="width:${Math.min(100, (d.green_of_all || 0) * 100)}%"></i></span><small>${pct(d.green_of_all)} ของเขียวทั้งหมด</small></td>
      <td>${d.faults ? `<span class="chip" style="color:var(--red)">${d.faults}</span>` : '0'}</td></tr>`;
  }).join('');
  const notes = flowInsights(f, lanes).map((t) => `<li>${t}</li>`).join('');
  host.innerHTML = `${chips}<div class="ftable"><table><thead><tr><th>เลน</th><th>ครั้งที่เขียว</th><th>เขียวเฉลี่ย<small>ต่ำสุด – สูงสุด</small></th><th>รอเฉลี่ย</th><th>คำขอ</th><th>คิวสูงสุด</th><th>ผ่าน/ชม.</th><th>สัดส่วนเวลาเขียว</th><th>ขัดข้อง</th></tr></thead><tbody>${rows}</tbody></table></div>
    <ul class="fnotes">${notes}</ul>`;
}
