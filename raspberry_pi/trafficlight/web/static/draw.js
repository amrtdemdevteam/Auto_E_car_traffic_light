'use strict';
/* Site map drawing (docs/T3_DESIGN.md 12.2)
 *
 * The engineer draws the junction map in the browser: rectangles, circles, lines,
 * arrows, text and a few ready-made parts (roads, arrows, pillar, box A, sensors).
 * Shapes live in a 1000 x 700 space and use theme colour tokens, so the map follows
 * light / dark mode. Saved by POST /api/drawing (the server checks every field).
 * Lane widgets (the LED boxes) are placed on top of this drawing by app.js.
 * Loaded before app.js; it only touches the global state S at call time. */

const DRAW_W = 1000, DRAW_H = 700;
const DCOL = {ink: 'var(--ink)', mut: 'var(--mut)', faint: 'var(--faint)', line: 'var(--line)', soft: 'var(--soft)', fill: 'var(--fill)',
  panel: 'var(--panel)', accent: 'var(--accent)', grn: 'var(--grn)', red: 'var(--red)', amb: 'var(--amb)', zone: 'var(--zone)', none: 'none'};
const DSWATCH = ['ink', 'mut', 'faint', 'line', 'accent', 'grn', 'red', 'amb', 'zone', 'none'];
const DFILLS = [['none', 'ไม่เติมสี'], ['soft', 'เทาอ่อน'], ['fill', 'เทา'], ['panel', 'ขาว/ดำ'], ['accent', 'น้ำเงิน'], ['grn', 'เขียว'], ['red', 'แดง'], ['amb', 'เหลือง'], ['ink', 'ดำ']];
const DTOOLS = [['select', 'เลือก / ย้าย', '↖'], ['rect', 'สี่เหลี่ยม', '▭'], ['ellipse', 'วงกลม', '◯'], ['line', 'เส้นตรง', '╱'], ['arrow', 'ลูกศร', '➜'], ['text', 'ข้อความ', 'T'], ['zone', 'โซน safety', '◇'], ['path', 'เส้นทางรถ', '⤳']];
const DPRESETS = [['road-v', 'ถนน ตั้ง'], ['road-h', 'ถนน นอน'], ['arr-up', '↑'], ['arr-down', '↓'], ['arr-left', '←'], ['arr-right', '→'],
  ['junction', 'พื้นที่แยก'], ['building', 'อาคาร 3D'], ['pillar', 'pillar'], ['boxA', 'กล่อง A'], ['sensor', 'เซนเซอร์'], ['tof', 'ToF'], ['label', 'ป้ายเลน'], ['exit', 'ทางออก']];
const DZONE_N = 4, VPATH_R = 70;   // clicks of a safety zone · corner rounding radius of a vehicle path     // clicks that make one safety zone
let drawSeq = 0;
let drawDrag = null;

const dEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const dcol = (t) => DCOL[t] || 'none';
const dclone = (o) => JSON.parse(JSON.stringify(o));
const newDid = () => 'd' + Date.now().toString(36) + (drawSeq++).toString(36);
const drawEditing = () => !!(S.dr && S.dr.on);

// ------------------------------------------------------------------ rendering
// polyline with rounded corners (vehicles drive this exact curve): returns many [x,y]
function dSmooth(pts, r = VPATH_R) {
  if (!pts || pts.length < 3) return (pts || []).map((p) => [p[0], p[1]]);
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const d = Math.min(r, la / 2, lc / 2);
    if (d < 1) { out.push([b[0], b[1]]); continue; }
    const p1 = [b[0] + (a[0] - b[0]) * d / la, b[1] + (a[1] - b[1]) * d / la], p2 = [b[0] + (c[0] - b[0]) * d / lc, b[1] + (c[1] - b[1]) * d / lc];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      out.push([u * u * p1[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * b[1] + t * t * p2[1]]);
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}
function drawItemSvg(it, edit) {
  const st = dcol(it.stroke), fl = dcol(it.fill), id = `data-did="${dEsc(it.id)}"`;
  if (it.type === 'lanepath') {
    if (!edit) return '';
    const sm = dSmooth(it.pts), e = sm[sm.length - 1], p = sm[Math.max(0, sm.length - 4)], L = Math.hypot(e[0] - p[0], e[1] - p[1]) || 1;
    const ux = (e[0] - p[0]) / L, uy = (e[1] - p[1]) / L, hs = 20, bx = e[0] - ux * hs, by = e[1] - uy * hs;
    const pl = sm.map((q) => q.map((n) => Math.round(n * 10) / 10).join(',')).join(' ');
    return `<g class="di" ${id}><polyline points="${pl}" fill="none" stroke="transparent" stroke-width="22"/><polyline points="${pl}" fill="none" stroke="${st}" stroke-width="${it.sw || 3}" stroke-dasharray="12 7" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<polygon points="${e[0]},${e[1]} ${bx - uy * hs * 0.5},${by + ux * hs * 0.5} ${bx + uy * hs * 0.5},${by - ux * hs * 0.5}" fill="${st}"/>`
      + `<g style="pointer-events:none"><rect x="${it.pts[0][0] - 20}" y="${it.pts[0][1] - 32}" width="58" height="22" rx="11" fill="${st}"/><text x="${it.pts[0][0] - 11}" y="${it.pts[0][1] - 16}" font-size="14" font-weight="700" fill="var(--panel)">เลน ${it.lane}</text></g></g>`;
  }
  if (it.type === 'zone') {
    const sw0 = it.stroke === 'none' ? 0 : (it.sw || 0);
    return `<g class="di" ${id}><polygon points="${(it.pts || []).map((p) => p.join(',')).join(' ')}" fill="url(#dzone)" stroke="${sw0 ? st : 'none'}" stroke-width="${sw0}" stroke-linejoin="round"/></g>`;
  }
  if (it.type === 'line') {
    const dx = it.x2 - it.x1, dy = it.y2 - it.y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const hs = Math.max(12, it.sw * 4.5);
    let ex = it.x2, ey = it.y2, head = '';
    if (it.arrow && L > hs) {
      ex = it.x2 - ux * hs * 0.85; ey = it.y2 - uy * hs * 0.85;
      const bx = it.x2 - ux * hs, by = it.y2 - uy * hs, px = -uy * hs * 0.5, py = ux * hs * 0.5;
      head = `<polygon points="${it.x2},${it.y2} ${bx + px},${by + py} ${bx - px},${by - py}" fill="${st}"/>`;
    }
    const dash = it.dash ? ` stroke-dasharray="${it.sw * 3} ${it.sw * 3}"` : '';
    return `<g class="di" ${id}><line x1="${it.x1}" y1="${it.y1}" x2="${ex}" y2="${ey}" stroke="${st}" stroke-width="${it.sw}" stroke-linecap="round"${dash}/>${head}`
      + `<line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="transparent" stroke-width="${Math.max(it.sw, 16)}"/></g>`;
  }
  if (it.type === 'text') {
    const rot = it.rot ? ` transform="rotate(${it.rot} ${it.x} ${it.y})"` : '';
    return `<g class="di" ${id}${rot}><text x="${it.x}" y="${it.y + it.size * 0.85}" font-size="${it.size}" font-weight="${it.bold ? 700 : 500}" fill="${st}">${dEsc(it.text)}</text></g>`;
  }
  const rot = it.rot ? ` transform="rotate(${it.rot} ${it.x + it.w / 2} ${it.y + it.h / 2})"` : '';
  const sw = it.sw || 0, stroke = it.stroke === 'none' || !sw ? 'none' : st;
  const op = it.type === 'hatch' ? ' opacity=".3"' : '';
  if (it.type === 'ellipse') {
    return `<g class="di" ${id}${rot}><ellipse cx="${it.x + it.w / 2}" cy="${it.y + it.h / 2}" rx="${it.w / 2}" ry="${it.h / 2}" fill="${fl === 'none' ? 'transparent' : fl}" stroke="${stroke}" stroke-width="${sw}"/></g>`;
  }
  const fill = it.type === 'hatch' ? dcol('faint') : (fl === 'none' ? 'transparent' : fl);
  return `<g class="di" ${id}${rot}><rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="${it.r || 0}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${op}/></g>`;
}
// yellow diamond (argyle) lattice = safety zone; colours follow the theme token --zone
const ZONE_DEFS = '<defs><pattern id="dzone" width="28" height="28" patternUnits="userSpaceOnUse"><rect width="28" height="28" fill="var(--zone)" fill-opacity=".22"/><path d="M14 0L28 14L14 28L0 14Z" fill="none" stroke="var(--zone)" stroke-width="2.5"/></pattern></defs>';
function drawingInner(items, opts = {}) {
  let out = ZONE_DEFS;
  if (opts.edit) {
    out += '<defs><pattern id="dgrid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="var(--line)" stroke-width="1"/></pattern></defs>'
      + `<rect width="${DRAW_W}" height="${DRAW_H}" fill="url(#dgrid)"/>`;
  }
  if (S.mapUrl) out += `<image href="${dEsc(S.mapUrl)}" x="0" y="0" width="${DRAW_W}" height="${DRAW_H}" preserveAspectRatio="xMidYMid meet" opacity="${opts.edit ? .55 : 1}"/>`;
  return out + (items || []).map((it) => drawItemSvg(it, opts.edit)).join('');
}
function drawOverlay(svg) {
  const it = S.dr.items.find((x) => x.id === S.dr.sel);
  const k = DRAW_W / (svg.getBoundingClientRect().width || DRAW_W), r = 6.5 * k;
  const hd = (x, y, h) => `<circle class="dh" data-h="${h}" data-hx="${x}" data-hy="${y}" cx="${x}" cy="${y}" r="${r}"/>`;
  const zp = S.dr.pend;
  if ((S.dr.tool === 'zone' || S.dr.tool === 'path') && zp) {          // points clicked so far + a rubber band to the pointer
    const all = S.dr.hover ? zp.concat([[S.dr.hover.x, S.dr.hover.y]]) : zp;
    const pl = all.length > 1 ? `<polyline class="dsel" points="${all.map((p) => p.join(',')).join(' ')}" fill="none" stroke-width="${2 * k}"/>` : '';
    const last = zp[zp.length - 1] || [60, 40];
    return pl + zp.map((p) => `<circle class="dh" cx="${p[0]}" cy="${p[1]}" r="${r}" style="pointer-events:none"/>`).join('')
      + `<text x="${last[0] + 12 * k}" y="${last[1] - 12 * k}" font-size="${15 * k}" font-weight="700" fill="var(--accent)" style="pointer-events:none">${S.dr.tool === 'zone' ? `จุด ${zp.length + 1}/${DZONE_N}` : `จุด ${zp.length + 1} · ดับเบิลคลิก/Enter = จบ`}</text>`;
  }
  if (!it) return '';
  if (it.type === 'lanepath') return `<polyline class="dsel" points="${it.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke-width="${1.5 * k}" stroke-dasharray="${4 * k} ${4 * k}"/>${it.pts.map((p, i) => hd(p[0], p[1], 'v' + i)).join('')}`;
  if (it.type === 'zone') return `<polygon class="dsel" points="${it.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke-width="${1.5 * k}"/>${it.pts.map((p, i) => hd(p[0], p[1], 'v' + i)).join('')}`;
  if (it.type === 'line') return `<line class="dsel" x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke-width="${2 * k}"/>${hd(it.x1, it.y1, 'p1')}${hd(it.x2, it.y2, 'p2')}`;
  if (it.type === 'text') {
    const el = svg.querySelector(`[data-did="${it.id}"] text`);
    const b = el ? el.getBBox() : {x: it.x, y: it.y, width: 60, height: it.size};
    const rot = it.rot ? ` transform="rotate(${it.rot} ${it.x} ${it.y})"` : '';
    return `<g${rot}><rect class="dsel" x="${b.x - 3}" y="${b.y - 2}" width="${b.width + 6}" height="${b.height + 4}" stroke-width="${1.5 * k}"/>${hd(b.x + b.width + 3, b.y + b.height + 2, 'size')}</g>`;
  }
  const rot = it.rot ? ` transform="rotate(${it.rot} ${it.x + it.w / 2} ${it.y + it.h / 2})"` : '';
  return `<g${rot}><rect class="dsel" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" stroke-width="${1.5 * k}"/>${hd(it.x + it.w, it.y + it.h, 'se')}</g>`;
}
function redrawDrawing() {
  const svg = document.querySelector('svg.dmap');
  if (!svg || !drawEditing()) return;
  svg.innerHTML = drawingInner(S.dr.items, {edit: true});
  svg.insertAdjacentHTML('beforeend', `<g class="dovl">${drawOverlay(svg)}</g>`);
}
// The map background: the drawing (or the empty-state hint) inside a 1000 x 700 svg.
function mapBgHtml(noHint) {
  const editing = drawEditing();
  const items = editing ? S.dr.items : (S.drawing && S.drawing.items) || [];
  const empty = !editing && !items.length && !S.mapUrl;
  const hint = empty ? `<div class="mapempty"><b>${isEditor() ? 'ยังไม่มีแผนที่' : 'ยังไม่ได้วาดแผนที่'}</b>${isEditor()
    ? '<span>วาดผังแยกด้วยเครื่องมือในตัว หรือเริ่มจากผังตามแบบ</span><span class="row" style="justify-content:center"><button data-dact="start">✎ วาดแผนที่</button><button class="sec" data-dact="starter0">ใช้ผังถนนตามแบบ T3</button></span>'
    : ''}</div>` : '';
  return `<svg class="dmap${editing ? ' editing' : ''}" viewBox="0 0 ${DRAW_W} ${DRAW_H}" role="img" aria-label="แผนที่แยก">${drawingInner(items, {edit: editing})}</svg>${noHint ? '' : hint}`;
}
// the empty-map hint must stay flat (not tilted with the 3D stage)
function mapHintHtml() {
  const h = mapBgHtml(false), i = h.indexOf('<div class="mapempty">');
  return i < 0 ? '' : h.slice(i);
}

// ------------------------------------------------------------------ toolbar
function drawToolsHtml() {
  const D = S.dr, sel = D.items.find((x) => x.id === D.sel);
  const b = (act, label, extra = '', cls = 'sec sm') => `<button class="${cls}" data-dact="${act}" ${extra}>${label}</button>`;
  const tools = DTOOLS.map(([t, label, ic]) => `<button class="tool ${D.tool === t ? 'on' : ''}" data-dact="tool" data-t="${t}" title="${label}" aria-pressed="${D.tool === t}"><i>${ic}</i><span>${label}</span></button>`).join('');
  const presets = DPRESETS.map(([p, label]) => b('preset', label, `data-p="${p}"`)).join('');
  const cur = sel ? sel.stroke : D.color;
  const swatches = '';
  const fillNow = sel && sel.type !== 'line' && sel.type !== 'text' && sel.type !== 'zone' && sel.type !== 'lanepath' ? sel.fill : D.fill;
  const swNow = sel ? sel.sw : D.sw;
  let ctx = '';
  if (sel && sel.type === 'text') {
    ctx += `<label class="dfield">ข้อความ<input type="text" id="dtext" data-dfield="text" maxlength="80" value="${dEsc(sel.text)}"></label>
      <label class="dfield">ขนาด<input type="number" data-dfield="size" min="6" max="200" step="2" value="${sel.size}" style="width:64px"></label>
      <label class="dfield chk"><input type="checkbox" data-dfield="bold" ${sel.bold ? 'checked' : ''}> ตัวหนา</label>`;
  }
  if (sel && sel.type === 'line') {
    ctx += `<label class="dfield chk"><input type="checkbox" data-dfield="arrow" ${sel.arrow ? 'checked' : ''}> หัวลูกศร</label>
      <label class="dfield chk"><input type="checkbox" data-dfield="dash" ${sel.dash ? 'checked' : ''}> เส้นประ</label>`;
  }
  if (sel && (sel.type === 'rect' || sel.type === 'ellipse')) {
    ctx += `<label class="dfield" title="ความสูงในมุมมอง 3D (0 = แบน)">สูง 3D<input type="number" data-dfield="ht" min="0" max="300" step="5" value="${sel.ht || 0}" style="width:64px"></label>
      <label class="dfield" title="ยกจากพื้นในมุมมอง 3D">ยก<input type="number" data-dfield="z" min="0" max="300" step="5" value="${sel.z || 0}" style="width:64px"></label>`;
  }
  const laneOpts = ((S.cfg && S.cfg.lanes) || []).map((l) => l.id);
  const laneNow = sel && sel.type === 'lanepath' ? sel.lane : D.pathLane;
  if ((sel && sel.type === 'lanepath') || D.tool === 'path') {
    ctx += `<label class="dfield" title="เลนที่รถวิ่งตามเส้นทางนี้">เลน<select data-dfield="plane">${laneOpts.map((n) => `<option value="${n}" ${Number(laneNow) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
    if (D.tool === 'path') ctx += b('pathend', '✓ จบเส้นทาง', '', 'sm') + '<span class="mut small">คลิกจุดต่อๆ ไป · ดับเบิลคลิกหรือ Enter = จบ · ลากจุดเพื่อโค้ง</span>';
  }
  if (sel || D.tool === 'path') ctx = (sel ? '' : '') + ctx;
  if (sel) ctx += b('rot', 'หมุน 90°') + b('bwd', '↓ ถอยหลัง', 'title="ลงหลังชิ้นถัดไป (Bring backward · [)"') + b('fwd', '↑ ขึ้นหน้า', 'title="ขึ้นหน้าชิ้นถัดไป (Bring forward · ])"')
    + b('back', 'ไปหลังสุด') + b('front', 'ขึ้นหน้าสุด') + b('dup', 'ทำซ้ำ') + b('del', 'ลบ', '', 'danger sm');
  const PL = Object.fromEntries(DPRESETS);
  const pg = (t, ids) => `<div class="dt-pg"><span class="dt-l">${t}</span><div class="dt-btns">${ids.map((p) => b('preset', PL[p], `data-p="${p}"`)).join('')}</div></div>`;
  const picker = (label, act, cur, list, dis) => `<details class="cpick ${dis ? 'dis' : ''}"><summary title="${label}"><span class="cpl">${label}</span><i class="cpc ${cur === 'none' ? 'none' : ''}" style="--c:${dcol(cur)}"></i><b>▾</b></summary>
    <div class="cpp">${list.map(([v, l]) => `<button class="swatch ${cur === v ? 'on' : ''} ${v === 'none' ? 'none' : ''}" data-dact="${act}" data-c="${v}" style="--c:${dcol(v)}" title="${l}" aria-label="${label} ${l}"></button>`).join('')}</div></details>`;
  const fillDis = sel && (sel.type === 'line' || sel.type === 'text' || sel.type === 'zone' || sel.type === 'lanepath') ? 'disabled' : '';
  const selBar = (sel || D.tool === 'path') ? `<div class="dt-sel"><span class="dt-l">${sel ? 'ชิ้นที่เลือก' : 'เส้นทางรถ'}</span>${ctx}</div>` : '';
  return `<div class="dt-top"><div class="dt-tools" role="toolbar" aria-label="เครื่องมือวาด">${tools}</div>
      <div class="dt-style">${picker('สีเส้น', 'color', cur, DSWATCH.map((c) => [c, c === 'none' ? 'ไม่มีเส้น' : c]), '')}${picker('สีเติม', 'fillc', fillNow, DFILLS, fillDis)}
        <label class="dfield">หนา<select data-dfield="sw">${[1, 2, 3, 4, 6, 10].map((v) => `<option value="${v}" ${Number(swNow) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="dfield chk"><input type="checkbox" data-dfield="snap" ${D.snap ? 'checked' : ''}> ชิดกริด</label></div></div>
    <div class="dt-presets2"><span class="dt-l">สำเร็จรูป</span>
      ${pg('ถนน', ['road-v', 'road-h', 'junction', 'exit'])}${pg('ทิศทาง', ['arr-up', 'arr-down', 'arr-left', 'arr-right'])}${pg('สิ่งก่อสร้าง', ['building', 'pillar', 'boxA'])}${pg('อุปกรณ์', ['sensor', 'tof', 'label'])}</div>
    ${selBar}
    <div class="dt-foot">${b('undo', '↶ ย้อน', D.undo.length ? '' : 'disabled')}${b('starter', 'ผังถนนตามแบบ T3')}${b('clear', 'ล้างทั้งหมด', '', 'danger sm')}<span class="sp"></span>
      ${b('cancel', 'ยกเลิก')}${b('save', 'บันทึกแผนที่', '', 'sm')}</div>`;
}
function renderDrawTools() {
  const el = document.getElementById('dtools');
  if (el && drawEditing()) el.innerHTML = drawToolsHtml();
}

// ------------------------------------------------------------------ editing
function dpush() { S.dr.undo.push(JSON.stringify(S.dr.items)); if (S.dr.undo.length > 60) S.dr.undo.shift(); S.dr.dirty = true; }
const dsnap = (v) => (S.dr.snap ? Math.round(v / 10) * 10 : Math.round(v * 10) / 10);
function dpt(svg, e) { const r = svg.getBoundingClientRect(); return {x: (e.clientX - r.left) * DRAW_W / r.width, y: (e.clientY - r.top) * DRAW_H / r.height}; }
const dsel = () => S.dr.items.find((x) => x.id === S.dr.sel);
function dstyle(o) { return {stroke: S.dr.color, fill: S.dr.fill, sw: S.dr.sw, rot: 0, ...o}; }
function dselect(id) { S.dr.sel = id; renderDrawTools(); redrawDrawing(); }

function presetItems(name, cx, cy) {
  const R = (o) => ({id: newDid(), rot: 0, sw: 2, stroke: 'ink', fill: 'none', ...o});
  const T = (x, y, text, o = {}) => R({type: 'text', x, y, text, size: 18, sw: 0, ...o});
  switch (name) {
    case 'road-v': return [R({type: 'road', x: cx - 60, y: cy - 150, w: 120, h: 300, fill: 'soft', stroke: 'line', sw: 1.5})];
    case 'road-h': return [R({type: 'road', x: cx - 150, y: cy - 50, w: 300, h: 100, fill: 'soft', stroke: 'line', sw: 1.5})];
    case 'arr-up': return [R({type: 'line', x1: cx, y1: cy + 45, x2: cx, y2: cy - 45, stroke: 'faint', sw: 5, arrow: true})];
    case 'arr-down': return [R({type: 'line', x1: cx, y1: cy - 45, x2: cx, y2: cy + 45, stroke: 'faint', sw: 5, arrow: true})];
    case 'arr-left': return [R({type: 'line', x1: cx + 45, y1: cy, x2: cx - 45, y2: cy, stroke: 'faint', sw: 5, arrow: true})];
    case 'arr-right': return [R({type: 'line', x1: cx - 45, y1: cy, x2: cx + 45, y2: cy, stroke: 'faint', sw: 5, arrow: true})];
    case 'junction': return [R({type: 'hatch', x: cx - 150, y: cy - 50, w: 300, h: 100, stroke: 'line', sw: 1})];
    case 'building': return [R({type: 'rect', x: cx - 50, y: cy - 40, w: 100, h: 80, ht: 110, fill: 'soft', stroke: 'faint', sw: 1})];
    case 'pillar': return [R({type: 'rect', x: cx - 75, y: cy - 40, w: 150, h: 80, ht: 70, fill: 'fill', stroke: 'none', sw: 0}), T(cx - 22, cy - 10, 'pillar', {size: 16, stroke: 'mut'})];
    case 'boxA': return [R({type: 'rect', x: cx - 26, y: cy - 20, w: 52, h: 40, ht: 40, fill: 'ink', stroke: 'none', sw: 0, r: 3}), T(cx - 7, cy - 12, 'A', {size: 24, bold: true, stroke: 'panel'})];
    case 'sensor': return [R({type: 'rect', x: cx - 32, y: cy - 14, w: 64, h: 28, ht: 12, fill: 'panel', stroke: 'faint', sw: 1.5, r: 3}), T(cx - 14, cy - 8, 'C1', {size: 15})];
    case 'tof': return [R({type: 'ellipse', x: cx - 17, y: cy - 17, w: 34, h: 34, ht: 26, fill: 'panel', stroke: 'accent', sw: 3}), T(cx - 10, cy - 8, 'C3', {size: 14, bold: true, stroke: 'accent'})];
    case 'label': return [T(cx - 24, cy - 12, 'เลน 1', {size: 22, bold: true})];
    case 'exit': return [T(cx - 24, cy - 40, 'ทางออก', {size: 15, stroke: 'mut'}), R({type: 'line', x1: cx - 45, y1: cy, x2: cx + 45, y2: cy, stroke: 'faint', sw: 5, arrow: true})];
    default: return [];
  }
}
function drawStarter() {
  // The T3 junction of docs/T3_DESIGN.md 2, drawn in the old 840 x 585 map units and scaled to 1000 x 700.
  const fx = DRAW_W / 840, fy = DRAW_H / 585, ox = 20, oy = 10, out = [];
  const X = (x) => Math.round((x - ox) * fx * 10) / 10, Y = (y) => Math.round((y - oy) * fy * 10) / 10;
  const box = (type, x, y, w, h, o = {}) => out.push({id: newDid(), type, x: X(x), y: Y(y), w: Math.round(w * fx), h: Math.round(h * fy), rot: 0, sw: 1.5, stroke: 'line', fill: 'none', ...o});
  const line = (x1, y1, x2, y2, o = {}) => out.push({id: newDid(), type: 'line', x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2), sw: 4, stroke: 'faint', fill: 'none', arrow: false, dash: false, ...o});
  const text = (x, y, s, o = {}) => out.push({id: newDid(), type: 'text', x: X(x), y: Y(y), text: s, size: 18, sw: 0, rot: 0, stroke: 'ink', fill: 'none', bold: false, ...o});
  box('road', 400, 20, 360, 560, {fill: 'soft'}); box('road', 30, 250, 370, 90, {fill: 'soft'}); box('hatch', 400, 250, 360, 90);
  line(520, 20, 520, 580, {sw: 1.5, stroke: 'line', dash: true}); line(640, 20, 640, 580, {sw: 1.5, stroke: 'line', dash: true});
  box('rect', 250, 340, 150, 80, {fill: 'fill', stroke: 'none', sw: 0, ht: 70}); text(305, 384, 'pillar', {size: 15, stroke: 'mut'});
  box('rect', 342, 346, 44, 34, {fill: 'ink', stroke: 'none', sw: 0, r: 3, ht: 34, z: 70}); text(357, 350, 'A', {size: 24, bold: true, stroke: 'panel'});
  text(140, 358, 'กล่องควบคุม', {size: 15, stroke: 'mut'});
  [[50, 295, 120, 295], [460, 575, 460, 520], [580, 575, 580, 520], [600, 25, 600, 80], [700, 25, 700, 80], [790, 200, 850, 200], [790, 390, 850, 390]]
    .forEach(([a, b, c, d]) => line(a, b, c, d, {arrow: true}));
  [['เลน 3', 132, 222], ['เลน 2', 400, 548], ['เลน 1', 620, 548], ['เลน 4', 545, 32], ['เลน 5', 712, 32]].forEach(([s, x, y]) => text(x, y, s, {size: 22, bold: true}));
  text(650, 312, 'พื้นที่แยก', {size: 15, stroke: 'mut'}); text(795, 170, 'ทางออก', {size: 14, stroke: 'mut'});
  [['C2', 444, 400, 32], ['C1.1', 556, 400, 48], ['C1.2', 556, 480, 48], ['C4', 584, 168, 32]].forEach(([s, x, y, w]) => {
    box('rect', x, y, w, 22, {fill: 'panel', stroke: 'faint', sw: 1.5, r: 3, ht: 12}); text(x + 5, y + 3, s, {size: 14});
  });
  [['C3', 347, 312], ['C5', 627, 170]].forEach(([s, x, y]) => {
    box('ellipse', x, y, 26, 26, {fill: 'panel', stroke: 'accent', sw: 3, ht: 26}); text(x + 4, y + 8, s, {size: 13, bold: true, stroke: 'accent'});
  });
  line(580, 422, 580, 480, {sw: 1.5, dash: true}); text(612, 443, '14 m สาย', {size: 14, stroke: 'mut'});
  return out;
}
window.T3_STARTER = drawStarter;

function startDrawing() {
  S.dr = {on: true, items: dclone((S.drawing && S.drawing.items) || []), tool: 'select', sel: null, color: 'ink', fill: 'none', sw: 2, snap: true, undo: [], dirty: false, pathLane: ((S.cfg && S.cfg.lanes && S.cfg.lanes[0]) || {id: 1}).id};
  S.sel = null; S.v3d = false;
  if (S.mapFull && typeof setMapFull === 'function') setMapFull(false);
  render();
}
function insertItems(list) {
  dpush();
  S.dr.items.push(...list);
  S.dr.sel = list[0].id; S.dr.tool = 'select';
  renderDrawTools(); redrawDrawing();
}
async function saveDrawing() {
  try {
    S.drawing = await api('/api/drawing', {method: 'POST', body: {items: S.dr.items}});
    S.dr = null; render(); toast('บันทึกแผนที่แล้ว');
  } catch (e) { toast('บันทึกแผนที่ไม่ได้: ' + e.message, true); }
}
async function loadDrawing() { try { S.drawing = await api('/api/drawing'); } catch (e) { S.drawing = {items: []}; } }

function finishPath() {
  const D = S.dr;
  if (!D || D.tool !== 'path') return;
  const pts = [];
  (D.pend || []).forEach((p) => { const q = pts[pts.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 4) pts.push(p); });
  D.pend = null; D.hover = null;
  if (pts.length < 2) { D.tool = 'select'; renderDrawTools(); redrawDrawing(); return; }
  dpush();
  const it = {id: newDid(), type: 'lanepath', lane: Number(D.pathLane) || 1, pts, stroke: 'accent', fill: 'none', sw: 3, rot: 0};
  D.items.push(it); D.sel = it.id; D.tool = 'select';
  renderDrawTools(); redrawDrawing();
}
document.addEventListener('dblclick', (e) => { if (drawEditing() && S.dr.tool === 'path' && e.target.closest('svg.dmap')) finishPath(); });
function moveItem(it, o, dx, dy) {
  if (it.type === 'line') { it.x1 = o.x1 + dx; it.y1 = o.y1 + dy; it.x2 = o.x2 + dx; it.y2 = o.y2 + dy; }
  else if (it.pts) it.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy]);
  else { it.x = o.x + dx; it.y = o.y + dy; }
}
document.addEventListener('pointerdown', (e) => {
  if (!drawEditing() || e.button !== 0) return;
  const svg = e.target.closest('svg.dmap');
  if (!svg) return;
  e.preventDefault();
  const pt = dpt(svg, e), D = S.dr, h = e.target.closest('[data-h]');
  if (h) {
    dpush();
    const it = dsel();
    drawDrag = {mode: h.dataset.h, id: it.id, orig: dclone(it), start: pt, h: {x: Number(h.dataset.hx), y: Number(h.dataset.hy)}};
  } else if (D.tool === 'select') {
    const g = e.target.closest('[data-did]');
    if (!g) { if (D.sel) dselect(null); return; }
    const it = D.items.find((x) => x.id === g.dataset.did);
    if (D.sel !== it.id) dselect(it.id);
    drawDrag = {mode: 'move', id: it.id, orig: dclone(it), start: pt, pushed: false};
  } else if (D.tool === 'path') {
    if (!D.pend) D.pend = [];
    const np = [dsnap(pt.x), dsnap(pt.y)], lp = D.pend[D.pend.length - 1], now = Date.now();
    if (lp && now - (D.pendT || 0) < 450 && Math.hypot(np[0] - lp[0], np[1] - lp[1]) < 16) { finishPath(); return; }   // double click / double tap = finish
    D.pend.push(np); D.pendT = now;
    redrawDrawing();
    return;
  } else if (D.tool === 'zone') {
    if (!D.pend) D.pend = [];
    D.pend.push([dsnap(pt.x), dsnap(pt.y)]);
    if (D.pend.length >= DZONE_N) {
      dpush();
      const it = {id: newDid(), type: 'zone', pts: D.pend, stroke: 'zone', fill: 'none', sw: 3, rot: 0};
      D.items.push(it); D.sel = it.id; D.tool = 'select'; D.pend = null; D.hover = null;
      renderDrawTools();
    }
    redrawDrawing();
    return;
  } else if (D.tool === 'text') {
    dpush();
    const it = dstyle({id: newDid(), type: 'text', x: dsnap(pt.x), y: dsnap(pt.y), text: 'ข้อความ', size: 22, sw: 0, bold: false, fill: 'none'});
    D.items.push(it); D.sel = it.id; D.tool = 'select';
    renderDrawTools(); redrawDrawing();
    const inp = document.getElementById('dtext'); if (inp) { inp.focus(); inp.select(); }
    return;
  } else {
    dpush();
    const sx = dsnap(pt.x), sy = dsnap(pt.y);
    let it;
    if (D.tool === 'line' || D.tool === 'arrow') it = dstyle({id: newDid(), type: 'line', x1: sx, y1: sy, x2: sx, y2: sy, arrow: D.tool === 'arrow', dash: false, fill: 'none', sw: Math.max(D.sw, D.tool === 'arrow' ? 4 : 1)});
    else {
      const kind = D.tool;   // rect | ellipse
      it = dstyle({id: newDid(), type: kind, x: sx, y: sy, w: 1, h: 1, r: 0});
    }
    D.items.push(it); D.sel = it.id;
    drawDrag = {mode: it.type === 'line' ? 'p2' : 'create', id: it.id, orig: dclone(it), start: {x: sx, y: sy}, created: true};
    redrawDrawing();
  }
  try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
document.addEventListener('pointermove', (e) => {
  if (drawEditing() && (S.dr.tool === 'zone' || S.dr.tool === 'path') && S.dr.pend && S.dr.pend.length) {
    const svg = document.querySelector('svg.dmap');
    if (svg) { const p = dpt(svg, e); S.dr.hover = {x: dsnap(p.x), y: dsnap(p.y)}; redrawDrawing(); }
    return;
  }
  if (!drawDrag || !drawEditing()) return;
  const svg = document.querySelector('svg.dmap');
  if (!svg) return;
  const it = dsel(), pt = dpt(svg, e), o = drawDrag.orig, D = S.dr;
  if (!it) return;
  const m = drawDrag.mode;
  if (m === 'move') {
    if (!drawDrag.pushed) { if (Math.hypot(pt.x - drawDrag.start.x, pt.y - drawDrag.start.y) < 3) return; dpush(); drawDrag.pushed = true; }
    const dx = D.snap ? Math.round((pt.x - drawDrag.start.x) / 10) * 10 : pt.x - drawDrag.start.x;
    const dy = D.snap ? Math.round((pt.y - drawDrag.start.y) / 10) * 10 : pt.y - drawDrag.start.y;
    moveItem(it, o, dx, dy);
  } else if (m === 'create') {
    const x2 = dsnap(pt.x), y2 = dsnap(pt.y);
    it.x = Math.min(drawDrag.start.x, x2); it.y = Math.min(drawDrag.start.y, y2);
    it.w = Math.max(1, Math.abs(x2 - drawDrag.start.x)); it.h = Math.max(1, Math.abs(y2 - drawDrag.start.y));
  } else if (m[0] === 'v' && it.pts) {
    it.pts = o.pts.map((p, i) => (i === Number(m.slice(1)) ? [dsnap(pt.x), dsnap(pt.y)] : p));
  } else if (m === 'p1' || m === 'p2') {
    let x = dsnap(pt.x), y = dsnap(pt.y);
    const ax = m === 'p1' ? it.x2 : it.x1, ay = m === 'p1' ? it.y2 : it.y1;
    if (e.shiftKey) {     // hold Shift: snap to 45 degrees
      const a = Math.round(Math.atan2(y - ay, x - ax) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(x - ax, y - ay);
      x = ax + Math.cos(a) * L; y = ay + Math.sin(a) * L;
    }
    if (m === 'p1') { it.x1 = x; it.y1 = y; } else { it.x2 = x; it.y2 = y; }
  } else if (m === 'size') {
    const d0 = Math.hypot(drawDrag.h.x - o.x, drawDrag.h.y - o.y) || 1, d1 = Math.hypot(pt.x - o.x, pt.y - o.y);
    it.size = Math.max(8, Math.min(200, Math.round(o.size * d1 / d0)));
  } else if (m === 'se') {
    if (!o.rot) { it.w = Math.max(8, dsnap(pt.x) - o.x); it.h = Math.max(8, dsnap(pt.y) - o.y); }
    else {
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = -o.rot * Math.PI / 180;
      const px = cx + (pt.x - cx) * Math.cos(a) - (pt.y - cy) * Math.sin(a), py = cy + (pt.x - cx) * Math.sin(a) + (pt.y - cy) * Math.cos(a);
      it.w = Math.max(8, Math.round(Math.abs(px - cx) * 2)); it.h = Math.max(8, Math.round(Math.abs(py - cy) * 2));
      it.x = cx - it.w / 2; it.y = cy - it.h / 2;
    }
  }
  redrawDrawing();
});
document.addEventListener('pointerup', () => {
  if (!drawDrag) return;
  const d = drawDrag; drawDrag = null;
  if (!drawEditing()) return;
  const it = dsel();
  if (d.created && it) {                // a click without dragging makes a sensible default size
    if (it.type === 'line' && Math.hypot(it.x2 - it.x1, it.y2 - it.y1) < 6) { it.x2 = it.x1 + 100; }
    else if (it.type !== 'line' && it.w < 8 && it.h < 8) { it.w = it.type === 'ellipse' ? 60 : 120; it.h = it.type === 'ellipse' ? 60 : 70; }
    S.dr.tool = 'select';
  }
  renderDrawTools(); redrawDrawing();
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dact]');
  if (!b) return;
  const act = b.dataset.dact;
  if (act === 'start') { startDrawing(); return; }
  if (act === 'starter0') { startDrawing(); insertItems(drawStarter()); return; }
  if (!drawEditing()) return;
  const D = S.dr, it = dsel();
  if (act === 'pathend') { finishPath(); return; }
  if (act === 'tool') { D.tool = b.dataset.t; D.pend = null; D.hover = null; if (D.tool === 'zone' || D.tool === 'path') D.sel = null; renderDrawTools(); redrawDrawing(); }
  else if (act === 'preset') { insertItems(presetItems(b.dataset.p, 500 + (Math.random() * 60 - 30), 350 + (Math.random() * 60 - 30))); }
  else if (act === 'fillc') { D.fill = b.dataset.c; if (it && it.type !== 'line' && it.type !== 'text') { dpush(); it.fill = b.dataset.c; redrawDrawing(); } renderDrawTools(); }
  else if (act === 'color') { D.color = b.dataset.c; if (it) { dpush(); it.stroke = b.dataset.c; redrawDrawing(); } renderDrawTools(); }
  else if (act === 'undo') { if (D.undo.length) { D.items = JSON.parse(D.undo.pop()); if (!D.items.find((x) => x.id === D.sel)) D.sel = null; renderDrawTools(); redrawDrawing(); } }
  else if (act === 'del' && it) { dpush(); D.items = D.items.filter((x) => x !== it); D.sel = null; renderDrawTools(); redrawDrawing(); }
  else if (act === 'dup' && it) { dpush(); const c = dclone(it); c.id = newDid(); moveItem(c, it, 20, 20); D.items.push(c); D.sel = c.id; renderDrawTools(); redrawDrawing(); }
  else if (act === 'fwd' && it) { const i = D.items.indexOf(it); if (i < D.items.length - 1) { dpush(); D.items.splice(i, 1); D.items.splice(i + 1, 0, it); redrawDrawing(); } }
  else if (act === 'bwd' && it) { const i = D.items.indexOf(it); if (i > 0) { dpush(); D.items.splice(i, 1); D.items.splice(i - 1, 0, it); redrawDrawing(); } }
  else if (act === 'front' && it) { dpush(); D.items = D.items.filter((x) => x !== it).concat(it); redrawDrawing(); }
  else if (act === 'back' && it) { dpush(); D.items = [it].concat(D.items.filter((x) => x !== it)); redrawDrawing(); }
  else if (act === 'rot' && it) {
    dpush();
    if (it.type === 'line') { const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2, r = (x, y) => [cx - (y - cy), cy + (x - cx)]; [it.x1, it.y1] = r(it.x1, it.y1); [it.x2, it.y2] = r(it.x2, it.y2); }
    else if (it.pts) { const cx = it.pts.reduce((a, p) => a + p[0], 0) / it.pts.length, cy = it.pts.reduce((a, p) => a + p[1], 0) / it.pts.length; it.pts = it.pts.map((p) => [Math.round(cx - (p[1] - cy)), Math.round(cy + (p[0] - cx))]); }
    else it.rot = ((it.rot || 0) + 90) % 360;
    redrawDrawing();
  } else if (act === 'starter') {
    if (D.items.length && !(await confirmDialog('ใส่ผังตามแบบ T3?', '<p class="mut">ผังตามแบบจะถูกเพิ่มต่อจากที่วาดไว้</p>', 'ใส่ผัง'))) return;
    insertItems(drawStarter());
  } else if (act === 'clear') {
    if (D.items.length && await confirmDialog('ล้างแผนที่ทั้งหมด?', '<p class="mut">ชิ้นส่วนที่วาดไว้จะถูกลบ (ยังย้อนกลับได้จนกว่าจะบันทึก)</p>', 'ล้าง')) { dpush(); D.items = []; D.sel = null; renderDrawTools(); redrawDrawing(); }
  } else if (act === 'cancel') {
    if (D.dirty && !(await confirmDialog('ยกเลิกการแก้แผนที่?', '<p class="mut">ที่แก้ไว้จะไม่ถูกบันทึก</p>', 'ยกเลิกการแก้'))) return;
    S.dr = null; render();
  } else if (act === 'save') { await saveDrawing(); }
});
function drawField(e) {
  const f = e.target.closest('[data-dfield]');
  if (!f || !drawEditing()) return;
  const D = S.dr, it = dsel(), k = f.dataset.dfield;
  const v = f.type === 'checkbox' ? f.checked : f.value;
  if (k === 'snap') { D.snap = v; return; }
  if (k === 'fill') { D.fill = v; if (it && it.type !== 'line' && it.type !== 'text') { dpush(); it.fill = v; redrawDrawing(); } return; }
  if (k === 'plane') { D.pathLane = Number(v); if (it && it.type === 'lanepath') { dpush(); it.lane = Number(v); redrawDrawing(); } return; }
  if (k === 'sw') { D.sw = Number(v); if (it) { dpush(); it.sw = Number(v); redrawDrawing(); } return; }
  if (!it) return;
  if (k === 'ht' || k === 'z') {
    if (e.type === 'change') { dpush(); it[k] = Math.max(0, Math.min(300, Number(v) || 0)); redrawDrawing(); }
    return;
  }
  if (e.type === 'change' || k === 'text' || k === 'size') {
    if (e.type === 'input' && !D._typing) { dpush(); D._typing = true; }
    if (e.type === 'change') D._typing = false;
    if (k === 'text') it.text = String(v).slice(0, 80);
    else if (k === 'size') it.size = Math.max(6, Math.min(200, Number(v) || 18));
    else it[k] = !!v;
    redrawDrawing();
  }
}
document.addEventListener('input', drawField);
document.addEventListener('change', drawField);
document.addEventListener('keydown', (e) => {
  if (!drawEditing() || e.target.closest('input,select,textarea')) return;
  const D = S.dr, it = dsel();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); const b = document.querySelector('[data-dact="undo"]'); if (b) b.click(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (it) { e.preventDefault(); document.querySelector('[data-dact="del"]').click(); } }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { if (it) { e.preventDefault(); document.querySelector('[data-dact="dup"]').click(); } }
  else if (e.key === ']' || e.key === '[') { if (it) document.querySelector(`[data-dact="${e.key === ']' ? 'fwd' : 'bwd'}"]`).click(); }
  else if (e.key === 'Enter' && D.tool === 'path') { e.preventDefault(); finishPath(); }
  else if (e.key === 'Escape') { D.tool = 'select'; D.pend = null; D.hover = null; dselect(null); }
  else if (it && e.key.startsWith('Arrow')) {
    e.preventDefault(); dpush();
    const st = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    moveItem(it, dclone(it), dx, dy); redrawDrawing();
  }
});
function afterRenderDraw() { if (drawEditing()) { renderDrawTools(); redrawDrawing(); } }

// ------------------------------------------------------------------ 3D view
// Every rect / ellipse with a height (ht) becomes a block standing on the drawing:
// a rect is a box made of 5 CSS faces, an ellipse a stack of slices. Everything else
// stays flat in the ground svg. All sizes are in the 1000 x 700 drawing units; the
// stage is scaled to the screen by app.js (fit3d).
function scene3dHtml(items) {
  let out = '';
  for (const it of items || []) {
    const H = Number(it.ht) || 0;
    if (!(H > 0) || (it.type !== 'rect' && it.type !== 'ellipse')) continue;
    const z = Number(it.z) || 0, fl = dcol(it.fill), st = dcol(it.stroke), sw = it.stroke === 'none' ? 0 : (it.sw || 0);
    const color = it.fill === 'none' ? 'var(--soft)' : fl;
    const rot = it.rot ? `rotate(${it.rot}deg)` : '';
    if (it.type === 'ellipse') {
      const n = Math.max(2, Math.min(28, Math.ceil(H / 4)));
      let sl = '';
      for (let i = 0; i <= n; i++) sl += `<i class="sl" style="transform:translateZ(${(z + H * i / n).toFixed(1)}px);filter:brightness(${(0.78 + 0.22 * i / n).toFixed(2)})"></i>`;
      out += `<div class="bx cyl" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;--c:${color};--s:${st};--sw:${sw}px;transform:${rot}">${sl}</div>`;
    } else {
      out += `<div class="bx" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;--c:${color};--s:${st};--sw:${sw}px;--r:${it.r || 0}px;transform:${rot}">`
        + `<i class="fc top" style="transform:translateZ(${z + H}px)"></i>`
        + `<i class="fc side" style="left:0;top:0;width:${it.w}px;height:${H}px;transform-origin:0 0;transform:translateZ(${z}px) rotateX(90deg);filter:brightness(.86)"></i>`
        + `<i class="fc side" style="left:0;top:${it.h}px;width:${it.w}px;height:${H}px;transform-origin:0 0;transform:translateZ(${z}px) rotateX(90deg);filter:brightness(.72)"></i>`
        + `<i class="fc side" style="left:0;top:0;width:${H}px;height:${it.h}px;transform-origin:0 0;transform:translateZ(${z}px) rotateY(-90deg);filter:brightness(.8)"></i>`
        + `<i class="fc side" style="left:${it.w}px;top:0;width:${H}px;height:${it.h}px;transform-origin:0 0;transform:translateZ(${z}px) rotateY(-90deg);filter:brightness(.66)"></i></div>`;
    }
  }
  return out;
}
