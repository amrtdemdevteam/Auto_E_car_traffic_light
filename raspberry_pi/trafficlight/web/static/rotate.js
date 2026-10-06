/* Turn the whole page 180 degrees for a touch screen mounted upside down (its own menu cannot flip).
 * Per browser only: kept in localStorage "tl_rot"; ?rot=180 turns it on, ?rot=0 off; any element with
 * data-rotscreen toggles it. Touch still hits the right button because the browser hit-tests the turned page.
 *
 * Page code that measures positions itself (clientX - rect.left: map drag, drawing, 3D orbit, popups)
 * would come out mirrored, so while turned clientX/Y and getBoundingClientRect are reported in the page's
 * own (unturned) coordinates. Everything stays consistent with what the person sees. */
(function () {
  "use strict";
  var KEY = "tl_rot";
  var root = document.documentElement;
  var on = false;
  try {
    var q = new URLSearchParams(location.search).get("rot");
    if (q === "180") localStorage.setItem(KEY, "180");
    if (q === "0") localStorage.removeItem(KEY);
    on = localStorage.getItem(KEY) === "180";
  } catch (e) { on = false; }

  var st = document.createElement("style");
  // html is exactly the viewport and turns about its centre; body scrolls instead of the window.
  // Modal dialogs live in the top layer (not inside html), so they are turned on their own.
  // `rotate` (not `transform`) so the dialog open animation keeps working.
  st.textContent = "html.rot180{height:100%;overflow:hidden;rotate:180deg}\n" +
    "html.rot180 body{height:100%;overflow:auto;overscroll-behavior:contain}\n" +
    "html.rot180 dialog[open]{rotate:180deg}\n" +
    ".rotbtn{font-size:14px}";
  (document.head || root).appendChild(st);

  function W() { return root.clientWidth; }
  function H() { return root.clientHeight; }
  function patchXY(proto) {
    if (!proto) return;
    ["clientX", "clientY"].forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(proto, k);
      if (!d || !d.get) return;
      var get = d.get;
      Object.defineProperty(proto, k, {configurable: true, enumerable: d.enumerable, get: function () {
        var v = get.call(this);
        if (!on) return v;
        return (k === "clientX" ? W() : H()) - v;
      }});
    });
  }
  patchXY(window.MouseEvent && MouseEvent.prototype);
  patchXY(window.Touch && Touch.prototype);
  var gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    var r = gbcr.call(this);
    if (!on || this === root) return r;
    return new DOMRect(W() - r.right, H() - r.bottom, r.width, r.height);
  };

  function apply() {
    root.classList.toggle("rot180", on);
    document.querySelectorAll("[data-rotscreen]").forEach(function (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function toggle() {
    on = !on;
    try { if (on) localStorage.setItem(KEY, "180"); else localStorage.removeItem(KEY); } catch (e) { /* this time only */ }
    apply();
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-rotscreen]");
    if (!b) return;
    e.preventDefault();
    toggle();
  });
  apply();
  window.T3Rotate = {toggle: toggle, isOn: function () { return on; }};
})();
