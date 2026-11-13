/* =====================================================================
 * SPECTRUM v2 — ui/fx.js
 * Efeitos discretos: chuva digital no cabeçalho, glitch ocasional no
 * título, relógio. Respeita prefers-reduced-motion e pausa fora da aba.
 * ===================================================================== */
(function () {
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // relógio
  const clock = document.getElementById('st-clock');
  const tick = () => { const d = new Date(); clock.textContent = d.toTimeString().slice(0, 8) + ' ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop().toUpperCase(); };
  tick(); setInterval(tick, 1000);

  // glitch no título
  const title = document.getElementById('title');
  const glitch = () => {
    if (!reduce && !document.hidden) { title.classList.add('on'); setTimeout(() => title.classList.remove('on'), 90 + Math.random() * 140); }
    setTimeout(glitch, 4000 + Math.random() * 7000);
  };
  setTimeout(glitch, 2500);

  // chuva digital (glifos hex + katakana meio-largura), 18 fps
  const c = document.getElementById('rain');
  if (!c || reduce) return;
  const ctx = c.getContext('2d');
  const glyphs = '0123456789ABCDEFｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ∿≋⌁'.split('');
  let cols = [], fs = 13, last = 0;
  const resize = () => {
    const r = c.getBoundingClientRect();
    c.width = r.width; c.height = r.height;
    cols = Array.from({ length: Math.ceil(r.width / fs) }, () => Math.random() * -40);
  };
  window.addEventListener('resize', resize); resize();
  const draw = (t) => {
    requestAnimationFrame(draw);
    if (document.hidden || t - last < 55) return; last = t;
    ctx.fillStyle = 'rgba(3,3,3,.18)'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = fs + 'px "JetBrains Mono", monospace';
    for (let i = 0; i < cols.length; i++) {
      const y = cols[i] * fs;
      if (y > 0) {
        ctx.fillStyle = Math.random() < 0.06 ? '#d8ffe0' : '#00ff41';
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * fs, y);
      }
      cols[i] += 0.55 + (i % 3) * 0.15;
      if (y > c.height + 40 && Math.random() > 0.96) cols[i] = Math.random() * -20;
    }
  };
  requestAnimationFrame(draw);
})();
