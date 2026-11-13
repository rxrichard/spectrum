/* =====================================================================
 * SPECTRUM v2 — core/stft.js
 * Espectrograma de visualização sob demanda (renderiza exatamente a
 * janela de tempo/frequência visível → qualidade máxima em qualquer zoom).
 *
 *  • Cada coluna de pixel = máximo de potência de até 8 quadros STFT que
 *    caem dentro dela ("peak-hold"), evitando aliasing temporal em zoom-out.
 *  • Cada linha de pixel = máximo dos bins que cobre (zoom-out) ou
 *    interpolação linear em dB entre bins (zoom-in).
 *  • Zero-padding opcional (zp) para interpolar o eixo de frequência.
 *  • Modo "grade alinhada": dentro da região SPv2 detectada, mostra a
 *    leitura OFDM exata de cada célula (a visão do decodificador).
 * Saída: Uint8Array (linha 0 = frequência mais alta), dB ∈ [−160, 0] → 0..255
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_stft(SPX) {
  'use strict';
  const { fft2real, makeWindow } = SPX.fft;
  const DB_MIN = -160, DB_SPAN = 160;
  const winCache = new Map();
  function getWin(type, N) {
    const key = type + N; let w = winCache.get(key);
    if (!w) { w = makeWindow(type, N); winCache.set(key, w); }
    return w;
  }

  function spectrogram(mono, fs, q) {
    const W = Math.max(1, q.width | 0), H = Math.max(1, q.height | 0);
    const N = q.N || 4096, zp = Math.max(1, q.zp || 1), Nf = N * zp;
    const win = getWin(q.window || 'hann', N);
    let wsum = 0; for (let i = 0; i < N; i++) wsum += win[i];
    const norm = (2 / wsum) * (2 / wsum);
    const t0 = q.t0 * fs, t1 = q.t1 * fs;
    const colSpan = (t1 - t0) / W;
    const sub = Math.max(1, Math.min(8, Math.ceil(colSpan / (N / 2))));
    const df = fs / Nf;
    const half = Nf / 2;

    // mapeamento linha → faixa de bins
    const rowA = new Float64Array(H), rowB = new Float64Array(H);
    const f0 = Math.max(0, q.f0), f1 = Math.min(fs / 2, q.f1);
    const logF = q.freqScale === 'log';
    const lf0 = Math.log(Math.max(f0, 10)), lf1 = Math.log(Math.max(f1, 20));
    for (let y = 0; y < H; y++) {
      const ua = (H - 1 - y) / H, ub = (H - y) / H; // y=0 → topo
      const fa = logF ? Math.exp(lf0 + ua * (lf1 - lf0)) : f0 + ua * (f1 - f0);
      const fb = logF ? Math.exp(lf0 + ub * (lf1 - lf0)) : f0 + ub * (f1 - f0);
      rowA[y] = fa / df; rowB[y] = fb / df;
    }

    const out = new Uint8Array(W * H);
    const re = new Float64Array(Nf), im = new Float64Array(Nf);
    const aRe = new Float64Array(half + 1), aIm = new Float64Array(half + 1), bRe = new Float64Array(half + 1), bIm = new Float64Array(half + 1);
    const segA = new Float64Array(Nf), segB = new Float64Array(Nf);
    const colPow = new Float64Array(half + 1);
    const frames = [];
    for (let x = 0; x < W; x++) for (let s = 0; s < sub; s++) frames.push(t0 + (x + (s + 0.5) / sub) * colSpan);
    const fill = (seg, center) => {
      const st = Math.round(center - N / 2);
      seg.fill(0);
      for (let m = 0; m < N; m++) { const n = st + m; if (n >= 0 && n < mono.length) seg[m] = mono[n] * win[m]; }
    };
    const hist = new Uint32Array(256);
    let fi = 0;
    for (let x = 0; x < W; x++) {
      colPow.fill(0);
      for (let s = 0; s < sub; s += 2) {
        fill(segA, frames[fi + s]);
        const two = s + 1 < sub;
        if (two) fill(segB, frames[fi + s + 1]);
        fft2real(segA, two ? segB : null, re, im, aRe, aIm, bRe, bIm);
        for (let k = 0; k <= half; k++) {
          let p = aRe[k] * aRe[k] + aIm[k] * aIm[k];
          if (two) { const p2 = bRe[k] * bRe[k] + bIm[k] * bIm[k]; if (p2 > p) p = p2; }
          if (p > colPow[k]) colPow[k] = p;
        }
      }
      fi += sub;
      for (let y = 0; y < H; y++) {
        const a = rowA[y], b = rowB[y];
        let p;
        const ka = Math.ceil(a), kb = Math.floor(b);
        if (kb >= ka) { p = 0; for (let k = Math.max(0, ka); k <= Math.min(half, kb); k++) if (colPow[k] > p) p = colPow[k]; }
        else {
          const c = 0.5 * (a + b), k = Math.floor(c), t = c - k;
          const pa = colPow[Math.max(0, Math.min(half, k))], pb = colPow[Math.max(0, Math.min(half, k + 1))];
          const da = 10 * Math.log10(pa + 1e-30), db = 10 * Math.log10(pb + 1e-30);
          p = Math.pow(10, (da + t * (db - da)) / 10);
        }
        const dB = 10 * Math.log10(p * norm + 1e-30);
        const v = Math.max(0, Math.min(255, Math.round((dB - DB_MIN) * 255 / DB_SPAN)));
        out[y * W + x] = v; hist[v]++;
      }
      if (q.onProgress && (x & 63) === 0) q.onProgress(x / W);
    }

    // ---- sobreposição da grade alinhada ---------------------------------
    let gridRef = null;
    if (q.grid && q.aligned) {
      const g = q.grid, h = g.header, P = SPX.layout.PROTO.PREAMBLE_COLS;
      const dfN = fs / h.N;
      // nível de referência: percentil alto do STFT dentro da região da grade
      const vals = [];
      const ref = (() => {
        for (let x = 0; x < W; x += 3) {
          const t = t0 + (x + 0.5) * colSpan, c = Math.floor((t - g.S0) / h.L) - P;
          if (c < 0 || c >= h.cols) continue;
          for (let y = 0; y < H; y += 3) {
            const f = (logF ? Math.exp(lf0 + ((H - 1 - y + 0.5) / H) * (lf1 - lf0)) : f0 + ((H - 1 - y + 0.5) / H) * (f1 - f0));
            const r = Math.round(f / dfN) - h.k0;
            if (r === 0 || r === h.rows - 1) vals.push(out[y * W + x]);
          }
        }
        vals.sort((a, b) => a - b);
        return vals.length ? vals[Math.floor(vals.length * 0.5)] * DB_SPAN / 255 + DB_MIN : -30;
      })();
      gridRef = ref;
      for (let x = 0; x < W; x++) {
        const t = t0 + (x + 0.5) * colSpan;
        const c = Math.floor((t - g.S0) / h.L) - P;
        if (c < 0 || c >= h.cols) continue;
        for (let y = 0; y < H; y++) {
          const f = logF ? Math.exp(lf0 + ((H - 1 - y + 0.5) / H) * (lf1 - lf0)) : f0 + ((H - 1 - y + 0.5) / H) * (f1 - f0);
          const r = Math.round(f / dfN) - h.k0;
          if (r < 0 || r >= h.rows) continue;
          const dB = g.gridDb[c * h.rows + r] + ref;
          out[y * W + x] = Math.max(0, Math.min(255, Math.round((dB - DB_MIN) * 255 / DB_SPAN)));
        }
      }
    }

    // percentis para auto-contraste
    const pct = (p) => { let acc = 0, tot = W * H; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * tot) return v * DB_SPAN / 255 + DB_MIN; } return 0; };
    return { data: out, width: W, height: H, p05: pct(0.05), p50: pct(0.5), p995: pct(0.995), sub, N, zp, gridRef, gridDR: q.grid ? q.grid.header.DR : null };
  }

  SPX.stft = { spectrogram, DB_MIN, DB_SPAN };
});
