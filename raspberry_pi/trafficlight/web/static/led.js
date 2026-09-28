// 64x32 HUB75 frame renderer (same pixels as esp32_display_t3/src/main.cpp).
(function () {
  var F = {'A':'01110100011000111111100011000110001','B':'11110100011000111110100011000111110','C':'01110100011000010000100001000101110','D':'11110100011000110001100011000111110','E':'11111100001000011110100001000011111','F':'11111100001000011110100001000010000','G':'01110100011000010111100011000101111','H':'10001100011000111111100011000110001','I':'01110001000010000100001000010001110','K':'10001100101010011000101001001010001','L':'10000100001000010000100001000011111','M':'10001110111010110101100011000110001','N':'10001110011010110011100011000110001','O':'01110100011000110001100011000101110','P':'11110100011000111110100001000010000','R':'11110100011000111110101001001010001','S':'01111100001000001110000010000111110','T':'11111001000010000100001000010000100','U':'10001100011000110001100011000101110','W':'10001100011000110101101011010101010','0':'01110100011001110101110011000101110','1':'00100011000010000100001000010001110','2':'01110100010000100010001000100011111','3':'11110000010000101110000010000111110','4':'00010001100101010010111110001000010','5':'11111100001111000001000011000101110','6':'00110010001000011110100011000101110','7':'11111000010001000100010000100001000','8':'01110100011000101110100011000101110','9':'01110100011000101111000010001001100','/':'00001000100001000100010000100010000','.':'00000000000000000000000000110001100','-':'00000000000000011111000000000000000',' ':'00000000000000000000000000000000000'};
  var C = {R: '#ff2a1c', G: '#1fd23f', Y: '#ffd000', W: '#f3f2ea', B: '#12bfff', D: '#23323a', DW: '#3a3a35'};

  function build(f, a) {
    var m = {};
    function set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && x < 64 && y >= 0 && y < 32) m[x + ',' + y] = c; }
    function tw(s, sc, sp) { return s.length ? s.length * 5 * sc + (s.length - 1) * sp : 0; }
    function text(s, x, y, c, sc, sp) { sc = sc || 1; sp = (sp === undefined) ? sc : sp; var cx = x; for (var i = 0; i < s.length; i++) { var g = F[s[i]] || F[' ']; for (var r = 0; r < 7; r++) for (var k = 0; k < 5; k++) if (g[r * 5 + k] === '1') for (var p = 0; p < sc; p++) for (var q = 0; q < sc; q++) set(cx + k * sc + q, y + r * sc + p, c); cx += 5 * sc + sp; } }
    function ctext(s, y, c, sc, x0, w, sp) { sc = sc || 1; x0 = x0 || 0; w = w || 64; sp = (sp === undefined) ? sc : sp; text(s, x0 + Math.floor((w - tw(s, sc, sp)) / 2), y, c, sc, sp); }
    function border(t) { t = t || 1; for (var x = 0; x < 64; x++) for (var i = 0; i < t; i++) { set(x, i, C.R); set(x, 31 - i, C.R); } for (var y = 0; y < 32; y++) for (var j = 0; j < t; j++) { set(j, y, C.R); set(63 - j, y, C.R); } }
    function each(fn) { for (var y = 0; y < 32; y++) for (var x = 0; x < 64; x++) fn(x, y, x + 0.5, y + 0.5); }
    function ang(dx, dy) { var v = Math.atan2(dx, -dy) * 180 / Math.PI; return v < 0 ? v + 360 : v; }
    function seg(px, py, x1, y1, x2, y2) { var vx = x2 - x1, vy = y2 - y1, t = ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy); t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)); }
    function bigX() { for (var y = 0; y < 28; y++) for (var x = 0; x < 28; x++) { var d1 = x - y, d2 = x + y - 27; if (Math.abs(d1) <= 5 || Math.abs(d2) <= 5) set(18 + x, 2 + y, C.R); } }
    function bigArrow() { for (var y = 2; y <= 15; y++) { var hw = y - 2; for (var x = 31 - hw; x <= 32 + hw; x++) set(x, y, C.G); } for (y = 16; y <= 29; y++) for (x = 28; x <= 35; x++) set(x, y, C.G); }
    function smallArrow() { for (var y = 3; y <= 15; y++) { var hw = y - 3; for (var x = 14 - hw; x <= 15 + hw; x++) set(x, y, C.G); } for (y = 16; y <= 29; y++) for (x = 11; x <= 18; x++) set(x, y, C.G); }
    function side(mir) { function p(x, y) { set(mir ? 63 - x : x, y, C.G); } for (var y = 12; y <= 19; y++) for (var x = 6; x <= 39; x++) p(x, y); for (x = 40; x <= 55; x++) { var k = 55 - x; for (y = Math.max(1, 15 - k); y <= Math.min(30, 16 + k); y++) p(x, y); } }
    function ring(n, dot, check) { var cx = 15.5, cy = 16; each(function (x, y, px, py) { var d = Math.hypot(px - cx, py - cy); if (d >= 9.3 && d < 12.6) { var v = ang(px - cx, py - cy); if (v % 120 < 7 || v % 120 > 113) return; set(x, y, Math.floor(v / 120) < n ? C.B : C.D); } else if (dot && d <= 2.7) set(x, y, C.B); if (check && (seg(px, py, cx - 4.5, cy + 0.5, cx - 1.5, cy + 3.8) < 1.3 || seg(px, py, cx - 1.5, cy + 3.8, cx + 4.8, cy - 3.6) < 1.3)) set(x, y, C.W); }); }
    switch (f) {
      case 'START': border(); var sx = 18, sy = 16.5; each(function (x, y, px, py) { var d = Math.hypot(px - sx, py - sy), v = ang(px - sx, py - sy); if (d >= 7 && d < 9.6 && v > 38 && v < 322) set(x, y, C.W); if (Math.abs(px - sx) < 1.3 && py > sy - 10.5 && py < sy - 1) set(x, y, C.W); }); [34, 42, 50].forEach(function (x0, i) { for (var y = 15; y < 18; y++) for (var x = x0; x < x0 + 3; x++) set(x, y, i < 2 ? C.W : C.DW); }); break;
      case 'REBOOT': border(); var rx = 32, ry = 16.5; each(function (x, y, px, py) { var d = Math.hypot(px - rx, py - ry); if (d >= 8 && d < 10.6 && ang(px - rx, py - ry) >= 40) set(x, y, C.W); var tx = rx + 5, ty = ry - 9.3, bx = rx - 1; if (px >= bx && px <= tx && Math.abs(py - ty) <= 5.2 * (tx - px) / (tx - bx)) set(x, y, C.W); }); break;
      case 'LINKWAIT': border(); ctext('LINK', 7, C.W); ctext('WAIT', 18, C.W); break;
      case 'GO': bigArrow(); break;
      case 'HOLD': ring(0, true, false); ctext('HOLD', 12, C.W, 1, 31, 33); break;
      case 'HAND1': ring(1, true, false); text('1/3', 31, 9, C.W, 2, 1); break;
      case 'HAND2': ring(2, true, false); text('2/3', 31, 9, C.W, 2, 1); break;
      case 'HANDOK': ring(3, false, true); text('OK', 37, 9, C.W, 2, 2); break;
      case 'SENSOR': border(); ctext('SENSOR', 3, C.W); ctext(String(a || '?'), 12, C.W); ctext('BROKEN', 21, C.W); break;
      case 'LINKLOST': border(); ctext('LINK', 7, C.W); ctext('LOST', 18, C.W); break;
      case 'LINKOK': border(); ctext('LINK', 7, C.W); ctext('OK', 18, C.W); break;
      case 'CONFIG': border(); ctext('CONFIG', 7, C.W); ctext('ERROR', 18, C.W); break;
      case 'MAINT': border(); each(function (x, y, px, py) { if (x >= 30) return; if (seg(px, py, 6.5, 25.5, 15.5, 16.5) < 2.1) set(x, y, C.W); var d = Math.hypot(px - 19, py - 12.5), v = ang(px - 19, py - 12.5); if (d >= 2.6 && d < 6.4 && !(v > 15 && v < 75)) set(x, y, C.W); }); ctext('LANE', 7, C.W, 1, 28, 34); ctext('OFF', 18, C.W, 1, 28, 34); break;
      case 'UPDATE': border(); for (var y2 = 4; y2 <= 15; y2++) for (var x2 = 30; x2 <= 33; x2++) set(x2, y2, C.W); for (var y3 = 13; y3 <= 21; y3++) { var h3 = 21 - y3; for (var x3 = 31 - h3; x3 <= 32 + h3; x3++) set(x3, y3, C.W); } for (var x4 = 20; x4 <= 43; x4++) { set(x4, 25, C.W); set(x4, 26, C.W); } for (var y4 = 20; y4 <= 26; y4++) { set(20, y4, C.W); set(21, y4, C.W); set(42, y4, C.W); set(43, y4, C.W); } break;
      case 'STOPHINT': bigX(); each(function (x, y, px, py) { if (x < 48 || y < 18) return; var d = Math.hypot(px - 56, py - 25); if (d < 1.6 || (d >= 3.6 && d < 5)) set(x, y, C.B); }); break;
      case 'TEST': for (var tx = 0; tx < 64; tx++) { set(tx, 0, C.B); set(tx, 31, C.B); } for (var ty = 0; ty < 32; ty++) { set(0, ty, C.B); set(63, ty, C.B); } ctext('TEST', 4, C.W, 2); ctext(String(a || ''), 22, C.B); break;
      case 'ALLSTOP': border(2); bigX(); break;
      case 'CAUTION': for (var y5 = 2; y5 <= 29; y5++) { var hw5 = Math.floor((y5 - 2) * 15 / 27); for (var x5 = 31 - hw5; x5 <= 32 + hw5; x5++) set(x5, y5, C.Y); } break;
      case 'LEFT': side(true); break;
      case 'RIGHT': side(false); break;
      case 'GO_N': smallArrow(); ctext(String(a || 3).charAt(0), 5, C.W, 3, 30, 34); break;
      case 'STOP_N': for (var yy = 0; yy < 24; yy++) for (var xx = 0; xx < 24; xx++) { if (Math.abs(xx - yy) <= 3 || Math.abs(xx + yy - 23) <= 3) set(4 + xx, 4 + yy, C.R); } ctext(String(a || 3).charAt(0), 5, C.W, 3, 30, 34); break;
      default: bigX();
    }
    return m;
  }

  window.drawLED = function (canvas, frame, arg) {
    var key = frame + '|' + (arg || '');
    if (canvas._key === key) return;
    canvas._key = key;
    var m = build(frame, arg || ''), s = canvas.width / 64, ctx = canvas.getContext('2d');
    ctx.fillStyle = '#070807';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var y = 0; y < 32; y++) for (var x = 0; x < 64; x++) {
      var c = m[x + ',' + y];
      ctx.fillStyle = c || '#191b19';
      ctx.beginPath();
      ctx.arc(x * s + s / 2, y * s + s / 2, s * (c ? 0.44 : 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
  };
  window.GREEN_FRAMES = {GO: 1, LEFT: 1, RIGHT: 1, GO_N: 1};
})();
