/* =====================================================================
 * SPECTRUM v2 — ui/colormaps.js
 * Mapas de cor de 256 entradas (Uint8Array RGB intercalado).
 * ===================================================================== */
(function () {
  'use strict';
  function stops(list) {
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let j = 0; while (j < list.length - 2 && t > list[j + 1][0]) j++;
      const [ta, ca] = list[j], [tb, cb] = list[j + 1];
      const u = Math.max(0, Math.min(1, (t - ta) / (tb - ta || 1)));
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(ca[c] + (cb[c] - ca[c]) * u);
    }
    return out;
  }
  function poly(c) { // ajuste polinomial de 6ª ordem (aprox. do "plasma" do matplotlib)
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let ch = 0; ch < 3; ch++) {
        let v = c[6][ch];
        for (let k = 5; k >= 0; k--) v = v * t + c[k][ch];
        out[i * 3 + ch] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
    }
    return out;
  }
  const MAPS = {
    matrix: stops([[0, [0, 0, 0]], [0.18, [0, 22, 6]], [0.45, [0, 92, 26]], [0.75, [0, 230, 58]], [0.9, [70, 255, 110]], [1, [215, 255, 222]]]),
    thermal: stops([[0, [0, 0, 0]], [0.2, [40, 4, 60]], [0.4, [140, 16, 60]], [0.6, [228, 70, 20]], [0.8, [252, 180, 30]], [1, [255, 255, 230]]]),
    plasma: poly([
      [0.05873234392399702, 0.02333670892565664, 0.5433401826748754],
      [2.176514634195958, 0.2383834171260182, 0.7539604599784036],
      [-2.689460476458034, -7.455851135738909, 3.110799939717086],
      [6.130348345893603, 42.3461881477227, -28.51885465332158],
      [-11.10743619062271, -82.66631109428045, 60.13984767418263],
      [10.02306557647065, 71.41361770095349, -54.07218655560067],
      [-3.658713842777788, -22.93153465461149, 18.19190778539828]]),
    classic: stops([[0, [0, 0, 0]], [1, [240, 240, 232]]]),
    ice: stops([[0, [0, 0, 0]], [0.3, [6, 22, 70]], [0.6, [0, 140, 200]], [0.85, [120, 230, 255]], [1, [255, 255, 255]]]),
  };
  /** Desenha uma amostra horizontal do mapa num canvas. */
  function swatch(canvas, name) {
    const m = MAPS[name] || MAPS.matrix, ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let x = 0; x < canvas.width; x++) {
      const i = Math.round(x / (canvas.width - 1) * 255);
      for (let y = 0; y < canvas.height; y++) { const o = (y * canvas.width + x) * 4; img.data[o] = m[i * 3]; img.data[o + 1] = m[i * 3 + 1]; img.data[o + 2] = m[i * 3 + 2]; img.data[o + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
  }
  window.SPX.colormaps = { MAPS, swatch };
})();
