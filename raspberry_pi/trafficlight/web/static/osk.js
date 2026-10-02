/* On-screen keyboard for touch-only kiosk. Enabled by ?osk=1 (kept in localStorage), ?osk=0 turns it off. */
(function () {
  "use strict";
  var KEY = "tl_osk";
  try {
    var q = new URLSearchParams(location.search).get("osk");
    if (q === "1") localStorage.setItem(KEY, "1");
    if (q === "0") localStorage.removeItem(KEY);
    if (localStorage.getItem(KEY) !== "1") return;
  } catch (e) { return; }

  var st = document.createElement("style");
  st.textContent = "#osk{display:none;position:fixed;left:0;right:0;bottom:0;z-index:100001;padding:8px 8px calc(8px + env(safe-area-inset-bottom));\n  background:var(--soft);border-top:1px solid var(--line);box-shadow:0 -8px 30px rgba(0,0,0,.18);user-select:none;-webkit-user-select:none;touch-action:manipulation}\n.osk-r{display:flex;gap:6px;margin-bottom:6px;max-width:980px;margin-left:auto;margin-right:auto}\n.osk-r:last-child{margin-bottom:0}\n.osk-k{flex:1 1 0;min-width:0;height:52px;padding:0;border-radius:10px;background:var(--panel);color:var(--ink);font-size:20px;font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.18)}\n.osk-k:active{background:var(--fill)}\n.osk-k.fn{background:var(--fill);font-size:17px}\n.osk-k.fn.on{background:var(--ink);color:var(--panel)}\n.osk-k.go{background:var(--accent,#0A84FF);color:#fff}\nbody.osk-on{padding-bottom:var(--osk-h,0)}";
  document.head.appendChild(st);

  var L = {
    en: [["1234567890-=", "!@#$%^&*()_+"], ["qwertyuiop[]", "QWERTYUIOP{}"],
         ["asdfghjkl;'", 'ASDFGHJKL:"'], ["zxcvbnm,./", "ZXCVBNM<>?"]],
    th: [["ๅ/-ภถุึคตจขช", "+๑๒๓๔ู฿๕๖๗๘๙"], ["ๆไำพะัีรนยบล", '๐"ฎฑธํ๊ณฯญฐ,'],
         ["ฟหกดเ้่าสวง", "ฤฆฏโฌ็๋ษศซ."], ["ผปแอิืทมใฝ", "()ฉฮฺ์?ฒฬฦ"]]
  };
  var lang = "en", shift = false, cur = null, hidden = false, kb = null;

  function isField(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return ["text", "password", "number", "search", "email", "tel", "url", ""].indexOf((el.type || "").toLowerCase()) >= 0
      && !el.readOnly && !el.disabled;
  }
  function numeric(el) { return el && (el.type === "number" || el.inputMode === "numeric" || el.inputMode === "decimal"); }

  function fire(el, t) { el.dispatchEvent(new Event(t, { bubbles: true })); }
  function put(txt) {
    var el = cur; if (!el) return;
    if (numeric(el) && el.type === "number") {
      el.value = String(el.value) + txt; fire(el, "input"); return;
    }
    var s = el.selectionStart, e = el.selectionEnd;
    if (s == null) { el.value += txt; } else { el.setRangeText(txt, s, e, "end"); }
    fire(el, "input");
  }
  function back() {
    var el = cur; if (!el) return;
    if (el.type === "number") { el.value = String(el.value).slice(0, -1); fire(el, "input"); return; }
    var s = el.selectionStart, e = el.selectionEnd;
    if (s == null) { el.value = el.value.slice(0, -1); }
    else if (s !== e) { el.setRangeText("", s, e, "end"); }
    else if (s > 0) { el.setRangeText("", s - 1, s, "end"); }
    fire(el, "input");
  }
  function enter() {
    var el = cur; if (!el) return;
    if (el.tagName === "TEXTAREA") { put("\n"); return; }
    fire(el, "change");
    var o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    var ok = el.dispatchEvent(new KeyboardEvent("keydown", o));
    var f = el.form;
    if (ok && f) { if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
    el.blur(); hide();
  }

  function btn(label, cls, fn, flex) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "osk-k " + (cls || ""); b.textContent = label;
    if (flex) b.style.flex = flex;
    b.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
    b.addEventListener("click", function (ev) { ev.preventDefault(); fn(); });
    return b;
  }
  function row(keys) { var r = document.createElement("div"); r.className = "osk-r"; keys.forEach(function (k) { r.appendChild(k); }); return r; }

  function render() {
    kb.textContent = "";
    var num = numeric(cur);
    if (num) {
      "789 456 123".split(" ").forEach(function (g) {
        kb.appendChild(row(g.split("").map(function (c) { return btn(c, "", function () { put(c); }); })));
      });
      kb.appendChild(row([btn(".", "", function () { put("."); }), btn("0", "", function () { put("0"); }),
        btn("-", "", function () { put("-"); }), btn("⌫", "fn", back)]));
      kb.appendChild(row([btn("▾", "fn", hide), btn("Enter", "fn go", enter, "3")]));
      return;
    }
    L[lang].forEach(function (r, i) {
      var ks = r[shift ? 1 : 0].split("").map(function (c) {
        return btn(c, "", function () { put(c); if (shift) { shift = false; render(); } });
      });
      if (i === 3) {
        ks.unshift(btn("⇧", "fn" + (shift ? " on" : ""), function () { shift = !shift; render(); }, "1.5"));
        ks.push(btn("⌫", "fn", back, "1.5"));
      }
      kb.appendChild(row(ks));
    });
    kb.appendChild(row([
      btn("▾", "fn", hide),
      btn(lang === "en" ? "ไทย" : "EN", "fn", function () { lang = lang === "en" ? "th" : "en"; shift = false; render(); }, "1.5"),
      btn("", "sp", function () { put(" "); }, "5"),
      btn("Enter", "fn go", enter, "2")
    ]));
  }

  function place() {
    var h = kb.offsetHeight;
    document.documentElement.style.setProperty("--osk-h", h + "px");
    document.body.classList.add("osk-on");
    if (cur && cur.scrollIntoView) {
      var r = cur.getBoundingClientRect();
      if (r.bottom > innerHeight - h - 8 || r.top < 0) cur.scrollIntoView({ block: "center" });
    }
  }
  function show(el) {
    cur = el; hidden = false;
    if (!kb) {
      kb = document.createElement("div"); kb.id = "osk";
      kb.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
    }
    var host = el.closest("dialog") || document.body;
    if (kb.parentNode !== host) host.appendChild(kb);
    kb.style.display = "block";
    render(); place();
  }
  function hide() {
    hidden = true;
    if (kb) kb.style.display = "none";
    document.body.classList.remove("osk-on");
    document.documentElement.style.removeProperty("--osk-h");
  }

  document.addEventListener("focusin", function (e) { if (isField(e.target)) show(e.target); });
  document.addEventListener("pointerdown", function (e) {
    var t = e.target;
    if (isField(t) && (hidden || cur !== t)) setTimeout(function () { if (document.activeElement === t) show(t); }, 0);
  }, true);
  document.addEventListener("focusout", function () {
    setTimeout(function () { if (!isField(document.activeElement) && kb && !(kb.contains(document.activeElement))) hide(); }, 80);
  });
})();
