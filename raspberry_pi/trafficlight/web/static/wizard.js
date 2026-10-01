// First-run wizard (Pi touch screen): welcome -> load the program into each display over USB -> check displays online.
// Afterwards the existing lane setup and map drawing take over, then the main map.
// All numbers (display count, baud, files ...) come from the server (cfg.setup).
const WIZ_STEPS = ['เริ่ม', 'ลงโปรแกรมจอ', 'ตรวจจอ'];

async function wizInit() {
  try {
    const st = await api('/api/setup/status');
    S.wizSt = st;
    if (st.show_wizard) { S.wiz = wizNew(0); S.wizSeen = true; }
  } catch (e) { /* viewers may not read it: just skip the wizard */ }
}
const wizNew = (step) => ({step, display: 1, port: '', base: null, jobs: {}, open: false, html: ''});

async function wizRefresh() {
  if (!S.wiz) return;
  try {
    const st = await api('/api/setup/status');
    S.wizSt = st;
    const cur = new Set((st.ports || []).map((p) => p.path));
    if (S.wiz.base === null) S.wiz.base = [...cur];
    else S.wiz.base = S.wiz.base.filter((p) => cur.has(p));      // a re-plugged port counts as new again
    if (S.wiz.port && !cur.has(S.wiz.port)) S.wiz.port = '';
    const fresh = (st.ports || []).filter((p) => !S.wiz.base.includes(p.path));
    if (!S.wiz.port && fresh.length === 1) S.wiz.port = fresh[0].path;
    const j = st.job;
    if (j) {
      const was = S.wiz.jobs[j.display];
      S.wiz.jobs[j.display] = j;                                 // keep every display's own result
      if (j.state === 'ok' && !(was && was.state === 'ok')) {
        const nxt = (st.displays || []).find((n) => !st.flashed[String(n)]);
        if (nxt) S.wiz.display = nxt;
      }
    }
  } catch (e) { /* ignore: next tick retries */ }
}

function wizDots() {
  return `<div class="wz-dots" role="list">${WIZ_STEPS.map((t, i) => `<span role="listitem" class="${i === S.wiz.step ? 'on' : (i < S.wiz.step ? 'done' : '')}"><i>${i < S.wiz.step ? '✓' : i + 1}</i><b>${t}</b></span>`).join('')}</div>`;
}

function wizJobHtml(job, w) {
  if (!job) return '';
  const cls = job.state === 'ok' ? 'ok' : (job.state === 'error' ? 'bad' : '');
  const icon = job.state === 'ok' ? '✓ ' : (job.state === 'error' ? '✕ ' : '');
  return `<div class="wz-prog ${cls}">
    <div class="wz-pb" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(job.percent)}"><i style="width:${job.percent}%"></i></div>
    <div class="wz-msg">${icon}${job.display !== w.display ? `จอ ${job.display} · ` : ''}${esc(job.message)}${job.state === 'running' ? ` · ${Math.round(job.percent)}%` : ''}</div>
    ${job.log && job.log.length ? `<details data-wizlog ${w.open ? 'open' : ''}><summary>รายละเอียด</summary><pre>${esc(job.log.join('\n'))}</pre></details>` : ''}</div>`;
}

function wizBody() {
  const w = S.wiz, st = S.wizSt || {};
  if (w.step === 0) {
    return `<div class="wz-hero"><div class="wz-big" aria-hidden="true">🚦</div><h1>เริ่มตั้งค่าระบบ</h1>
      <ol class="wz-need"><li>ลงโปรแกรมให้จอ ทีละจอ</li><li>ตรวจว่าจอออนไลน์</li><li>ตั้งค่าเลนและแผนที่</li></ol></div>`;
  }
  if (w.step === 1) {
    const disp = st.displays || [];
    const fw = st.firmware || {}, fl = st.flashed || {};
    const last = st.job || null;                                   // newest result stays visible after auto-advancing to the next display
    const job = w.jobs[w.display] || (last && last.state !== 'running' ? last : null);
    const running = Object.values(w.jobs).some((j) => j.state === 'running') || (st.job && st.job.state === 'running');
    const cur = fw[String(w.display)] || {ok: false, missing: []};
    const base = w.base || [];
    const ports = (st.ports || []).map((p) => `<option value="${esc(p.path)}" ${w.port === p.path ? 'selected' : ''}>${base.includes(p.path) ? '' : '★ '}${esc(p.path)}</option>`).join('');
    const cards = disp.map((n) => {
      const ok = !!fl[String(n)], miss = !(fw[String(n)] || {}).ok;
      return `<button class="wz-d ${w.display === n ? 'sel' : ''} ${ok ? 'ok' : ''}" data-act="wizpick" data-n="${n}" aria-pressed="${w.display === n}" ${running ? 'disabled' : ''}>
        <b>${n}</b><span>${ok ? '✓ แล้ว' : (miss ? 'ไม่มีไฟล์' : 'ยังไม่ได้ลง')}</span></button>`;
    }).join('');
    return `<div class="wz-card"><h2>ลงโปรแกรมให้จอ</h2>
      <div class="wz-grid">${cards}</div>
      <div class="wz-form">
        <select data-wizport aria-label="พอร์ต USB" ${running ? 'disabled' : ''}><option value="">${ports ? 'เลือกพอร์ต USB' : 'เสียบสาย USB'}</option>${ports}</select>
        <button class="sec" data-act="wizrefresh" aria-label="รีเฟรชพอร์ต" ${running ? 'disabled' : ''}>↻</button>
      </div>
      <button class="wz-go" data-act="wizflash" ${running || !w.port || !cur.ok ? 'disabled' : ''}>ลงโปรแกรมจอ ${w.display}</button>
      ${!cur.ok ? `<p class="wz-warn">ไม่มีไฟล์เฟิร์มแวร์จอ ${w.display}</p>` : ''}
      ${wizJobHtml(job, w)}
    </div>`;
  }
  const disp = st.displays || [1, 2, 3, 4, 5];
  const cards = disp.map((n) => {
    const on = displayOnline(n);
    return `<div class="wz-d ${on ? 'ok' : ''}"><b>${n}</b><span>${on ? '● ออนไลน์' : '○ ยังไม่พบ'}</span></div>`;
  }).join('');
  return `<div class="wz-card"><h2>ตรวจจอ</h2><p class="mut">ต่อสาย LAN และไฟ แล้วรอสักครู่</p><div class="wz-grid">${cards}</div></div>`;
}

function wizBar() {
  const w = S.wiz, st = S.wizSt || {};
  const running = (st.job && st.job.state === 'running');
  const last = w.step === WIZ_STEPS.length - 1;
  const flashed = Object.keys(st.flashed || {}).length;
  return `${w.step > 0 ? '<button class="sec" data-act="wizback">‹ กลับ</button>' : ''}
    <span class="sp"></span>
    ${w.step === 0 && S.wizSeen ? '<button class="plain" data-act="wizskip">ข้าม</button>' : ''}
    <button data-act="wiznext" ${running ? 'disabled' : ''}>${w.step === 0 ? 'เริ่ม' : (last ? (w.nav ? 'เสร็จ' : 'ตั้งค่าแยก ›') : (w.step === 1 && !flashed ? 'ข้าม ›' : 'ถัดไป ›'))}</button>`;
}

function wizView() {
  return `<main id="main" tabindex="-1" class="wzmain"><div class="wiz">${wizDots()}<div id="wizbody">${wizBody()}</div></div></main>
    <div class="bar" id="wizbar">${wizBar()}</div>`;
}

// repaint only when something changed, and never while a dropdown is open
function wizPaint() {
  const w = S.wiz;
  if (!w) return;
  const b = document.getElementById('wizbody');
  if (!b) return;
  const f = document.activeElement;
  if (f && f.tagName === 'SELECT') return;
  const html = wizBody() + wizBar();
  if (html === w.html) return;
  w.html = html;
  b.innerHTML = wizBody();
  const bar = document.getElementById('wizbar');
  if (bar) bar.innerHTML = wizBar();
}

async function wizDone() {
  try { await api('/api/setup/done', {method: 'POST', body: {}}); } catch (e) { /* the wizard is optional */ }
  S.wiz = null;
  render();
}

async function wizAct(act, b) {
  const w = S.wiz;
  if (act === 'wizopen') { S.wiz = wizNew(1); S.wiz.nav = !!(b && b.dataset.nav); await wizRefresh(); render(); return true; }
  if (!w) return false;
  if (act === 'wiznext') {
    if (w.step === 0) { w.step = 1; w.base = null; await wizRefresh(); render(); return true; }
    if (w.step < WIZ_STEPS.length - 1) { w.step += 1; render(); return true; }
    await wizDone(); return true;
  }
  if (act === 'wizback' && w.nav && w.step === 1) { S.wiz = null; render(); return true; }
  if (act === 'wizback') { w.step = Math.max(0, w.step - 1); if (w.step === 1) { w.base = null; wizRefresh(); } render(); return true; }
  if (act === 'wizskip') { await wizDone(); return true; }
  if (act === 'wizpick') { w.display = Number(b.dataset.n); wizPaint(); return true; }
  if (act === 'wizrefresh') { await wizRefresh(); wizPaint(); return true; }
  if (act === 'wizflash') {
    try {
      const r = await api('/api/setup/flash', {method: 'POST', body: {display: w.display, port: w.port}});
      w.jobs[r.job.display] = r.job;
      S.wizSt = {...(S.wizSt || {}), job: r.job};
    } catch (e) { toast(e.message, true); }
    wizPaint(); return true;
  }
  return false;
}

document.addEventListener('change', (e) => {
  if (S.wiz && e.target.matches('[data-wizport]')) { S.wiz.port = e.target.value; wizPaint(); }
});
// remember whether "รายละเอียด" is open: the panel is redrawn while a job runs
document.addEventListener('toggle', (e) => {
  if (S.wiz && e.target.matches && e.target.matches('[data-wizlog]')) S.wiz.open = e.target.open;
}, true);

setInterval(async () => {
  if (!S.wiz || !S.me || S.wiz.step === 0) return;
  if (S.wiz.step === 1) await wizRefresh();
  wizPaint();
}, 1000);
