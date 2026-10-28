/* Admin-only test mode: left drawer to fake vehicles / hands / sensor faults on the real controller.
   The controller decides who may use it (config sim.user); this file only draws the controls. */
(function () {
  "use strict";
  let open = false, dock = null, bar = null, last = "";

  const simOf = () => (S.state && S.state.sim) || {on: false, left_s: 0, sensors: {}};
  const vdOf = () => (S.state && S.state.sim_display) || {on: false, left_s: 0, displays: []};
  const mine = () => !!(S.me && S.me.sim);
  const send = async (body) => {
    try { await api("/api/control", {method: "POST", body}); } catch (e) { toast(e.message || "ส่งไม่ได้", true); }
  };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const why = (r) => r === "display" ? "จอไม่ตอบ" : (String(r).startsWith("sensor:") ? "เซนเซอร์ " + String(r).slice(7) : String(r));

  function ensure() {
    if (dock) return;
    bar = document.createElement("div"); bar.id = "simbar";
    dock = document.createElement("div"); dock.id = "simdock";
    document.body.append(bar, dock);
    dock.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sim]"); if (!b || b.disabled) return;
      const a = b.dataset.sim;
      if (a === "tab") { open = !open; last = ""; draw(); return; }
      if (a === "on") send({cmd: "sim", on: b.dataset.on === "1"});
      else if (a === "vd") send({cmd: "sim_display", on: b.dataset.on === "1"});
      else if (a === "pulse") send({cmd: "sim_pulse", sensor: b.dataset.s});
      else send({cmd: "sim_sensor", sensor: b.dataset.s, state: a});
    });
  }

  function lanesHtml(sim) {
    const lanes = (S.state && S.state.lanes) || [];
    return lanes.map((l) => {
      const hand = l.type === "special";
      const sens = (l.sensors || []).map((sid) => {
        const st = sim.sensors[sid] || "empty";
        const seg = (k, t) => `<button type="button" class="${st === k ? "on" : ""}${k === "dead" ? " bad" : ""}" data-sim="${k}" data-s="${sid}">${t}</button>`;
        return `<div class="sm-s"><span class="sm-id mono">${sid}</span>
          <div class="sm-seg">${seg("empty", "ว่าง")}${seg("present", hand ? "มือ" : "รถ")}${seg("dead", "เสีย")}</div>
          <button type="button" class="sm-go" data-sim="pulse" data-s="${sid}" title="${hand ? "มือ" : "รถ"}ผ่านแล้วออก">ผ่าน</button></div>`;
      }).join("");
      const lamp = l.green ? "g" : (l.enabled ? "r" : "x");
      const note = l.enabled ? "" : `<div class="sm-why">ปิด: ${(l.reasons || []).map(why).join(", ") || "ปิดใช้งาน"}</div>`;
      return `<div class="sm-l"><div class="sm-h"><span class="sm-dot ${lamp}"></span><b>${esc(l.name || "เลน " + l.id)}</b>
        <span class="sm-q">คิว ${l.tickets || 0}</span></div>${note}${sens}</div>`;
    }).join("");
  }

  function step(n, title, help, on, act, left) {
    return `<div class="sm-step${on ? " on" : ""}"><span class="sm-n">${n}</span>
      <div class="sm-st"><b>${title}</b><small${on ? ` data-left="${act}"` : ""}>${on ? "เปิดอยู่ · เหลือ " + mmss(left) : help}</small></div>
      <button type="button" class="sm-tg${on ? " on" : ""}" data-sim="${act}" data-on="${on ? 0 : 1}" aria-pressed="${on}">${on ? "ปิด" : "เปิด"}</button></div>`;
  }

  function draw() {
    if (!S.me) { if (dock) { dock.style.display = "none"; bar.style.display = "none"; } return; }
    ensure();
    const sim = simOf(), vd = vdOf();
    const msg = [];
    if (sim.on) msg.push(`โหมดจำลองเปิดอยู่ · เหลือ ${mmss(sim.left_s)}`);
    if (vd.on) msg.push(`จอจำลอง: ไม่มีจอจริง ไฟเห็นเฉพาะในเว็บ · เหลือ ${mmss(vd.left_s)}`);
    bar.style.display = msg.length ? "block" : "none";
    bar.textContent = msg.join(" | ");
    if (!mine()) { dock.style.display = "none"; return; }
    dock.style.display = "block";
    const lanes = (S.state && S.state.lanes) || [];
    const noLanes = !lanes.length || (S.state && S.state.state === "CONFIG_ERROR");
    // timers change every second: update them in place, rebuild only on real changes (a rebuild eats clicks)
    const key = JSON.stringify([open, sim.on, sim.sensors, vd.on, noLanes,
      lanes.map((l) => [l.id, l.name, l.green, l.enabled, l.tickets, l.reasons])]);
    dock.querySelectorAll("[data-left]").forEach((el) => {
      el.textContent = "เปิดอยู่ · เหลือ " + mmss(el.dataset.left === "vd" ? vd.left_s : sim.left_s);
    });
    if (key === last) return;
    last = key;
    dock.className = open ? "open" : "";
    dock.innerHTML = `<button type="button" class="sm-tab" data-sim="tab" aria-label="เปิดแผงจำลอง">จำลอง</button>
      <div class="sm-body">
        <div class="sm-hd"><b>โหมดจำลอง</b><span class="mut small">admin</span>
          <button type="button" class="sm-x" data-sim="tab" aria-label="ปิดแผง">×</button></div>
        ${noLanes ? '<div class="sm-warn">ยังไม่มีเลนที่ใช้งานได้ ตั้งค่าเลนในหน้า ระบบ ก่อน แล้วค่อยกลับมาเปิดจำลอง</div>' : ""}
        ${step(1, "จอจำลอง", "ไม่ได้ต่อจอ: Pi ตอบแทนจอ ไฟเห็นในเว็บ", vd.on, "vd", vd.left_s)}
        ${step(2, "เซนเซอร์จำลอง", "ไม่อ่านเซนเซอร์จริง กดปุ่มแทนรถหรือมือ", sim.on, "on", sim.left_s)}
        <p class="sm-note">ห้ามเปิดจอจำลองตอนมีรถจริงวิ่งตามไฟ · ไฟและจอทำงานตามกติกาจริง</p>
        ${sim.on && !noLanes ? `<div class="sm-sec">เลน</div>${lanesHtml(sim)}` : ""}
      </div>`;
  }
  setInterval(draw, 500);
})();
