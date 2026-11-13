/* =====================================================================
 * SPECTRUM v2 — core/fft.js
 * Radix-2 FFT complexa in-place (Float64), com planos em cache.
 *
 * Convenção: X[k] = Σ x[n]·e^{-i2πkn/N}   (direta)
 *            x[n] = (1/N)·Σ X[k]·e^{+i2πkn/N} (inversa)
 *
 * Todos os módulos do núcleo são escritos como funções `SPX_xxx(SPX)`
 * para poderem ser serializados (fn.toString()) e injetados em Web
 * Workers criados via Blob — isso permite rodar o projeto direto de
 * file:// sem servidor (importScripts/ES modules falham em file://).
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_fft(SPX) {
  'use strict';
  const plans = new Map();

  function plan(n) {
    let p = plans.get(n);
    if (p) return p;
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT: tamanho deve ser potência de 2 (' + n + ')');
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    p = { n, rev, cos, sin };
    plans.set(n, p);
    return p;
  }

  /** FFT complexa in-place. inverse=true aplica e^{+i} e escala 1/N. */
  function fft(re, im, inverse) {
    const n = re.length, p = plan(n), rev = p.rev, C = p.cos, S = p.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = C[k], wi = sgn * S[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  /**
   * Duas FFTs reais pelo preço de uma complexa:
   * z = a + i·b  →  A_k = (Z_k + Z*_{N-k})/2 ,  B_k = (Z_k − Z*_{N-k})/(2i)
   * Preenche (aRe,aIm,bRe,bIm) para k = 0..N/2.
   */
  function fft2real(a, b, re, im, aRe, aIm, bRe, bIm) {
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] = a[i]; im[i] = b ? b[i] : 0; }
    fft(re, im, false);
    const h = n >> 1;
    for (let k = 0; k <= h; k++) {
      const nk = (n - k) & (n - 1);
      const zr = re[k], zi = im[k], cr = re[nk], ci = -im[nk];
      aRe[k] = 0.5 * (zr + cr); aIm[k] = 0.5 * (zi + ci);
      if (bRe) { bRe[k] = 0.5 * (zi - ci); bIm[k] = -0.5 * (zr - cr); }
    }
  }

  /** Janelas de análise. periodic=true para STFT/OLA. */
  function makeWindow(type, n) {
    const w = new Float64Array(n);
    const TWO_PI = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const x = i / n;
      switch (type) {
        case 'rect': w[i] = 1; break;
        case 'hamming': w[i] = 0.54 - 0.46 * Math.cos(TWO_PI * x); break;
        case 'blackman': w[i] = 0.42 - 0.5 * Math.cos(TWO_PI * x) + 0.08 * Math.cos(2 * TWO_PI * x); break;
        case 'bh4': // Blackman-Harris 4 termos (lóbulos laterais ~ −92 dB)
          w[i] = 0.35875 - 0.48829 * Math.cos(TWO_PI * x) + 0.14128 * Math.cos(2 * TWO_PI * x) - 0.01168 * Math.cos(3 * TWO_PI * x); break;
        case 'gauss': { const s = 0.4, t = (i - n / 2) / (s * n / 2); w[i] = Math.exp(-0.5 * t * t); break; }
        case 'sqrthann': w[i] = Math.sqrt(0.5 - 0.5 * Math.cos(TWO_PI * x)); break;
        case 'hann': default: w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * x);
      }
    }
    return w;
  }

  SPX.fft = { fft, fft2real, plan, makeWindow };
});
