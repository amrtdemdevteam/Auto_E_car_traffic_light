'use strict';
/* Diagnostic codes and alerts (docs/T3_DESIGN.md 12.3)
 *
 * The web UI derives the alerts from the controller status it already polls, so
 * nothing new is sent to the controller and the light logic is not touched.
 *   E = error (a lane or the whole junction cannot work)
 *   W = warning (something is wrong but the junction still runs)
 *   I = information (a lane is off on purpose)
 * Loaded before app.js; it reads the global state S when called. */

// code -> [title, what to do]
const DIAG = {
  E101: ['เซนเซอร์ไม่มีข้อมูล · เลนถูกปิด', 'เช็กสาย USB-485 และไฟเลี้ยงเซนเซอร์ · ตั้งค่าเลน › “หาด้วยมือ” เพื่อดูว่าพอร์ตถูกตัว · กลับมาเองเมื่อข้อมูลนิ่ง'],
  E102: ['เซนเซอร์ของเลนที่เขียวเสีย · หยุดทุกเลน', 'ทุกจอเป็น X เพื่อให้รถเคลียร์แยก แล้วเลนอื่นทำงานต่อ · ซ่อมเซนเซอร์เลนที่เสีย'],
  E201: ['จอไม่ตอบ · เลนถูกปิด', 'เช็กไฟและสาย LAN ของจอ · IP ของจอต้องตรงกับที่ตั้งไว้ · เลนกลับมาเองเมื่อจอตอบ'],
  E301: ['ค่าตั้งใช้ไม่ได้ · ไม่ควบคุมไฟ', 'แก้ค่าตามข้อความที่แสดง แล้วบันทึกใหม่ (ระบบ › ประวัติ ย้อนกลับได้)'],
  E401: ['ระบบควบคุมไม่ตอบ', 'จอจะแสดง LINK LOST เอง · เช็กว่า Pi ทำงาน และ service trafficlight รันอยู่'],
  W101: ['เซนเซอร์ไม่มีข้อมูล (เลนยังใช้ได้)', 'เซนเซอร์ไกลของเลน Auto เสีย เลนใช้เซนเซอร์ใกล้แทน · ซ่อมเมื่อสะดวก'],
  I501: ['ปิดเลนโดยผู้ใช้ (maintenance)', 'เลนนี้ไม่รับคิว จอแสดง MAINT · เปิดที่ตั้งค่าเลน › เปิดเลน'],
  I502: ['เลนปิดในค่าตั้ง', 'เลนนี้ไม่รับคิว จอแสดง CONFIG · เปิดใช้ที่ ตั้งค่าเลน › เปิดใช้เลน'],
};
const codeSev = (c) => ({E: 'err', W: 'warn', I: 'info'}[c[0]]);

function diagnose() {
  const st = S.state, out = [];
  const add = (code, key, lane, detail) => out.push({code, key: code + ':' + key, sev: codeSev(code), lane, title: DIAG[code][0], hint: DIAG[code][1], detail});
  if (!S.cfg) return out;
  if (!st) { if (S.me) add('E401', 'link', null, 'ยังไม่ได้รับสถานะ'); return out; }
  if (S.stale) { add('E401', 'link', null, 'ไม่ได้รับสถานะจากระบบควบคุม'); return out; }   // the rest would be old data
  if (st.errors && st.errors.length) add('E301', 'cfg', null, st.errors.join(' · '));
  if (st.state === 'FAULT_HOLD') add('E102', 'hold', st.active_lane || null, `ทุกเลน X อีก ${st.fault_hold_s} s`);
  const inLane = new Set();
  (st.lanes || []).forEach((l) => {
    const rs = l.reasons || [];
    rs.filter((r) => r.startsWith('sensor:')).forEach((r) => {
      const sid = r.slice(7); inLane.add(sid);
      add('E101', sid, l.id, `เลน ${l.id} · เซนเซอร์ ${sid}`);
    });
    if (rs.includes('display') || l.display_online === false) add('E201', 'B' + l.display, l.id, `เลน ${l.id} · จอ B${l.display}`);
    if (rs.includes('maintenance')) add('I501', String(l.id), l.id, `เลน ${l.id}`);
    if (rs.includes('config_disabled')) add('I502', String(l.id), l.id, `เลน ${l.id}`);
  });
  if (st.state !== 'STARTING') {
    (st.sensors || []).forEach((s) => {
      if (s.online === false && !inLane.has(s.id)) {
        const l = (st.lanes || []).find((x) => (x.sensors || []).includes(s.id));
        add('W101', s.id, l ? l.id : null, `เซนเซอร์ ${s.id}${l ? ` · เลน ${l.id}` : ''}`);
      }
    });
  }
  const rank = {err: 0, warn: 1, info: 2};
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || a.code.localeCompare(b.code));
}

function alertRowHtml(a) {
  return `<div class="al ${a.sev}"><span class="code mono">${a.code}</span>
    <div class="alb"><b>${esc(a.title)}</b><span class="mut small">${esc(a.detail)}</span><span class="hint small">${esc(a.hint)}</span></div>
    ${a.lane ? `<button class="sec sm" data-act="toggle" data-lane="${a.lane}">เลน ${a.lane}</button>` : ''}</div>`;
}
function codeTableHtml() {
  return Object.entries(DIAG).map(([c, [t, h]]) => `<div class="li-row"><span class="code mono ${codeSev(c)}">${c}</span><span class="lab" style="flex:1"><span>${esc(t)}<br><span class="mut small">${esc(h)}</span></span></span></div>`).join('');
}

// called on every status poll (no full render)
function updateAlerts() {
  const list = diagnose();
  const sig = JSON.stringify(list.map((a) => [a.key, a.detail]));
  const fresh = S._alertInit ? list.filter((a) => a.sev !== 'info' && !(S.alerts || []).some((o) => o.key === a.key)) : [];
  S._alertInit = true;
  S.alerts = list;
  if (fresh.length && !(S.state && S.state.state === 'STARTING')) { const a = fresh[0]; toast(`${a.sev === 'err' ? '⚠' : '•'} ${a.code} ${a.title}${a.lane ? ` · เลน ${a.lane}` : ''}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`, a.sev === 'err'); }
  if (sig === S._alertSig) return;
  S._alertSig = sig;
  const act = list.filter((a) => a.sev !== 'info');
  const badge = document.getElementById('hdr-alerts');
  if (badge) {
    badge.hidden = !list.length;
    badge.className = 'alertbadge ' + (act.some((a) => a.sev === 'err') ? 'err' : act.length ? 'warn' : 'info');
    badge.textContent = `${act.length ? '⚠' : 'ⓘ'} ${list.length}`;
    badge.title = list.map((a) => `${a.code} ${a.title}`).join('\n');
  }
  const card = document.getElementById('alertcard');
  if (card) {
    card.hidden = !list.length;
    card.className = 'card alertcard ' + (act.some((a) => a.sev === 'err') ? 'err' : '');
    card.innerHTML = list.length ? `<div class="card-h">การแจ้งเตือน<span class="cnt">${list.length}</span></div>${list.map(alertRowHtml).join('')}` : '';
  }
  document.querySelectorAll('[data-lcodes]').forEach((el) => {
    const id = Number(el.dataset.lcodes);
    el.innerHTML = list.filter((a) => a.lane === id && a.sev !== 'info').map((a) => `<span class="code mono ${a.sev}" title="${esc(a.title)}">${a.code}</span>`).join('');
  });
  document.querySelectorAll('.wg[data-widget]').forEach((w) => {
    const id = Number(w.dataset.widget);
    w.classList.toggle('alerted', list.some((a) => a.lane === id && a.sev === 'err'));
  });
}
