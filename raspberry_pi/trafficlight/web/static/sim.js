/* Admin-only test mode: left drawer to fake vehicles / hands / sensor faults on the real controller.
   The controller decides who may use it (config sim.user); this file only draws the controls. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let open = false, dock = null, bar = null, last = "";

  const simOf = () => (S.state && S.state.sim) || {on: false, left_s: 0, sensors: {}};
  const mine = () => !!(S.me && S.me.sim);
  const send = async (body) => {
    try { await api("/api/control", {method: "POST", body}); } catch (e) { toast(e.message || "ส่งไม่ได้", true); }
  };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function ensure() {
    if (dock) return;
    bar = document.createElement("div"); bar.id = "simbar";
    dock = document.createElement("div"); dock.id = "simdock";
    document.body.append(bar, dock);
    dock.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sim]"); if (!b) return;
      const a = b.dataset.sim;
      if (a === "tab") { open = !open; last = ""; draw(); return; }
      if (a === "on") send({cmd: "sim", on: b.dataset.on === "1"});
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
        const c = (k, t) => `<button type="button" class="sec sm${st === k ? " on" : ""}" data-sim="${k}" data-s="${sid}">${t}</button>`;
        return `<div class="sm-s"><span class="mono">${sid}</span>
          <button type="button" class="sm-go" data-sim="pulse" data-s="${sid}">ผ่าน</button>
          ${c("present", hand ? "มือ" : "รถ")}${c("empty", "ว่าง")}${c("dead", "เสีย")}</div>`;
      }).join("");
      const lamp = l.green ? "เขียว" : (l.enabled ? "แดง" : "ปิด");
      return `<div class="sm-l"><div class="sm-h"><b>เลน ${l.id}</b><span class="sm-lamp ${l.green ? "g" : ""}">${lamp}</span>
        <span class="mut small">คิว ${l.tickets || 0}</span></div>${sens}</div>`;
    }).join("");
  }

  function draw() {
    if (!S.me) { if (dock) { dock.style.display = "none"; bar.style.display = "none"; } return; }
    ensure();
    const sim = simOf();
    bar.style.display = sim.on ? "block" : "none";
    bar.textContent = sim.on ? `โหมดจำลองเปิดอยู่ · เหลือ ${mmss(sim.left_s)}` : "";
    if (!mine()) { dock.style.display = "none"; return; }
    dock.style.display = "block";
    const key = JSON.stringify([open, sim, (S.state && S.state.lanes || []).map((l) => [l.id, l.green, l.enabled, l.tickets])]);
    if (key === last) return;
    last = key;
    dock.className = open ? "open" : "";
    dock.innerHTML = `<button type="button" class="sm-tab" data-sim="tab" aria-label="จำลอง">${open ? "‹" : "จำลอง"}</button>
      <div class="sm-body"><div class="sm-top"><b>จำลอง</b>
        <button type="button" class="${sim.on ? "sec" : ""}" data-sim="on" data-on="${sim.on ? 0 : 1}">${sim.on ? "ปิดโหมดจำลอง" : "เปิดโหมดจำลอง"}</button></div>
        ${sim.on ? lanesHtml(sim) : '<p class="mut small">เปิดแล้วจะไม่อ่านเซนเซอร์จริง ไฟและจอทำงานตามกติกาจริง</p>'}</div>`;
  }
  setInterval(draw, 500);
})();
