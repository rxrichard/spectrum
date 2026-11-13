/* =====================================================================
 * SPECTRUM v2 — core/lab.js
 * Degradações para testes de resistência + gerador de hospedeiro demo.
 *
 * IMPORTANTE: "mp3sim"/"opussim" são SIMULAÇÕES perceptuais (passa-baixa
 * + ruído de quantização por banda crítica proporcional à energia local
 * + limiar de mascaramento). Não substituem um codec real; servem para
 * comparar configurações. O teste com Opus REAL (MediaRecorder) roda na
 * thread principal, em tempo real.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_lab(SPX) {
  'use strict';
  const { fft, makeWindow } = SPX.fft;

  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const clone = (chs) => chs.map(c => new Float32Array(c));

  function addNoise(chs, snrDb, seed) {
    const r = SPX.util.prng(seed || 99), out = clone(chs);
    for (const c of out) {
      const s = SPX.encoder.rms(c), sd = s * Math.pow(10, -snrDb / 20);
      for (let i = 0; i < c.length; i++) c[i] += sd * gauss(r);
    }
    return out;
  }
  function quantize(chs, bits) {
    const q = Math.pow(2, bits - 1);
    return chs.map(c => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = Math.round(c[i] * q) / q; return o; });
  }
  function gain(chs, db) { const g = Math.pow(10, db / 20); return chs.map(c => c.map(v => v * g)); }
  function crop(chs, n) { return chs.map(c => c.slice(Math.min(n, c.length))); }
  function pad(chs, n) { return chs.map(c => { const o = new Float32Array(c.length + n); o.set(c, n); return o; }); }
  function echo(chs, fs, ms, g) {
    const d = Math.round(ms * fs / 1000);
    return chs.map(c => { const o = new Float32Array(c); for (let i = d; i < c.length; i++) o[i] += g * c[i - d]; return o; });
  }
  function lowpass(chs, fs, fc) { return SPX.encoder.carve(chs, fs, fc, fs / 2, 100); }

  /** Reamostragem por sinc janelado (Kaiser-like via Blackman), 32 taps por lado. */
  function resample(x, fsIn, fsOut) {
    const ratio = fsOut / fsIn, n = Math.floor(x.length * ratio), out = new Float32Array(n);
    const taps = 32, cut = Math.min(1, ratio) * 0.97;
    for (let i = 0; i < n; i++) {
      const t = i / ratio, c = Math.floor(t);
      let acc = 0, ws = 0;
      for (let k = c - taps + 1; k <= c + taps; k++) {
        if (k < 0 || k >= x.length) continue;
        const d = t - k, a = Math.PI * d * cut;
        const s = d === 0 ? 1 : Math.sin(a) / a;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * d / taps) + 0.08 * Math.cos(2 * Math.PI * d / taps);
        acc += x[k] * s * w * cut; ws += s * w * cut;
      }
      out[i] = acc;
    }
    return out;
  }
  function resampleRT(chs, fs, fsMid) {
    return chs.map(c => { const a = resample(c, fs, fsMid), b = resample(a, fsMid, fs); const o = new Float32Array(c.length); o.set(b.subarray(0, c.length)); return o; });
  }

  /** Simulação de codec perceptual (MDCT-like via STFT). */
  function codecSim(chs, fs, profile, seed) {
    const P = {
      mp3_128: { fc: 16000, smr: 14, ath: -88 },
      mp3_192: { fc: 18500, smr: 18, ath: -92 },
      mp3_320: { fc: 20000, smr: 24, ath: -96 },
      opus_64: { fc: 20000, smr: 11, ath: -85 },
      opus_128: { fc: 20000, smr: 17, ath: -90 },
    }[profile] || { fc: 16000, smr: 14, ath: -88 };
    const N = 2048, hop = N / 4, win = makeWindow('sqrthann', N), df = fs / N;
    // bandas ~ 1/3 de oitava acima de 500 Hz, 100 Hz abaixo
    const edges = [0];
    let f = 100; while (f < fs / 2) { edges.push(Math.round(f / df)); f = f < 500 ? f + 100 : f * 1.26; }
    edges.push(N / 2 + 1);
    const athLin = Math.pow(10, P.ath / 20) * N / 4;
    const re = new Float64Array(N), im = new Float64Array(N);
    return chs.map(x => {
      const out = new Float32Array(x.length), len = x.length;
      for (let t = -N + hop; t < len; t += hop) {
        for (let m = 0; m < N; m++) { const n = t + m; re[m] = n >= 0 && n < len ? x[n] * win[m] : 0; im[m] = 0; }
        fft(re, im, false);
        for (let b = 0; b + 1 < edges.length; b++) {
          const ka = edges[b], kb = Math.min(N / 2, edges[b + 1] - 1);
          if (kb < ka) continue;
          let e = 0; for (let k = ka; k <= kb; k++) e += re[k] * re[k] + im[k] * im[k];
          const rmsB = Math.sqrt(e / (kb - ka + 1));
          const step = Math.max(rmsB * Math.pow(10, -P.smr / 20), athLin) * 1.7;
          for (let k = ka; k <= kb; k++) {
            if (k * df >= P.fc) { re[k] = im[k] = 0; continue; }
            // quantização uniforme: ruído ∝ energia da banda (SMR) + zera abaixo do limiar absoluto
            re[k] = Math.round(re[k] / step) * step;
            im[k] = Math.round(im[k] / step) * step;
          }
        }
        for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        im[0] = 0; im[N / 2] = 0;
        fft(re, im, true);
        for (let m = 0; m < N; m++) { const n = t + m; if (n >= 0 && n < len) out[n] += 0.5 * re[m] * win[m]; }
      }
      return out;
    });
  }

  const TESTS = {
    ref: { label: 'Referência (sem alteração)', run: (c) => c },
    q16: { label: 'Re-quantização 16 bits', run: (c) => quantize(c, 16) },
    q12: { label: 'Re-quantização 12 bits', run: (c) => quantize(c, 12) },
    gain: { label: 'Ganho −6 dB', run: (c) => gain(c, -6) },
    crop: { label: 'Corte do início (0,37 s) + atraso', run: (c, fs) => pad(crop(c, Math.round(0.37 * fs)), 1234) },
    noise40: { label: 'Ruído branco SNR 40 dB', run: (c) => addNoise(c, 40, 11) },
    noise25: { label: 'Ruído branco SNR 25 dB', run: (c) => addNoise(c, 25, 12) },
    echo: { label: 'Eco 80 ms (−12 dB)', run: (c, fs) => echo(c, fs, 80, 0.25) },
    lp16: { label: 'Passa-baixa 16 kHz', run: (c, fs) => lowpass(c, fs, 16000) },
    mp3_320: { label: 'Simulação MP3 320 kbps', run: (c, fs) => codecSim(c, fs, 'mp3_320') },
    mp3_128: { label: 'Simulação MP3 128 kbps', run: (c, fs) => codecSim(c, fs, 'mp3_128') },
    opus_64: { label: 'Simulação Opus 64 kbps', run: (c, fs) => codecSim(c, fs, 'opus_64') },
    resample: { label: 'Reamostragem ida-e-volta (44,1/48 kHz)', run: (c, fs) => resampleRT(c, fs, fs === 44100 ? 48000 : 44100) },
  };

  /** Hospedeiro de demonstração: groove eletrônico sintético (determinístico). */
  function demoHost(fs, seconds) {
    const n = Math.round(fs * seconds), L = new Float32Array(n), R = new Float32Array(n);
    const r = SPX.util.prng(0x1337);
    const bpm = 96, beat = 60 / bpm, step = beat / 4;
    const chords = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]]; // Am F G Em
    const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // pad (saw filtrado de forma simples, detune estéreo)
    let lpL = 0, lpR = 0;
    const ph = new Float64Array(12);
    for (let i = 0; i < n; i++) {
      const t = i / fs, bar = Math.floor(t / (beat * 4)) % 4, ch = chords[bar];
      let sL = 0, sR = 0;
      for (let v = 0; v < 3; v++) {
        const f = m2f(ch[v] - 12);
        ph[v * 2] = (ph[v * 2] + f * 1.003 / fs) % 1; ph[v * 2 + 1] = (ph[v * 2 + 1] + f * 0.997 / fs) % 1;
        sL += 2 * ph[v * 2] - 1; sR += 2 * ph[v * 2 + 1] - 1;
      }
      const cutoff = 0.05 + 0.03 * Math.sin(2 * Math.PI * t / 8);
      lpL += cutoff * (sL - lpL); lpR += cutoff * (sR - lpR);
      L[i] = 0.08 * lpL; R[i] = 0.08 * lpR;
    }
    // bateria + baixo
    const steps = Math.floor(seconds / step);
    for (let s = 0; s < steps; s++) {
      const st = Math.round(s * step * fs), bar = Math.floor(s / 16) % 4, pos = s % 16;
      if (pos % 4 === 0) { // kick
        for (let i = 0; i < 0.25 * fs && st + i < n; i++) { const t = i / fs; const f = 50 + 90 * Math.exp(-t * 30); const v = 0.5 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9); L[st + i] += v; R[st + i] += v; }
      }
      if (pos === 4 || pos === 12) { // snare
        for (let i = 0; i < 0.18 * fs && st + i < n; i++) { const t = i / fs; const v = (0.18 * (r() * 2 - 1) + 0.1 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 18); L[st + i] += v; R[st + i] += v * 0.9; }
      }
      if (pos % 2 === 0) { // hi-hat (ruído com "brilho")
        let prev = 0;
        for (let i = 0; i < 0.05 * fs && st + i < n; i++) { const t = i / fs; const w = r() * 2 - 1; const hp = w - prev; prev = w; const v = 0.05 * hp * Math.exp(-t * 70); L[st + i] += v * 0.8; R[st + i] += v; }
      }
      if (pos % 4 === 2 || pos === 0) { // baixo
        const f = m2f(chords[bar][0] - 24);
        for (let i = 0; i < step * 1.8 * fs && st + i < n; i++) { const t = i / fs; const v = 0.16 * Math.tanh(2 * Math.sin(2 * Math.PI * f * t)) * Math.exp(-t * 4); L[st + i] += v; R[st + i] += v; }
      }
    }
    // fade in/out
    const fd = Math.round(0.5 * fs);
    for (let i = 0; i < fd; i++) { const g = i / fd; L[i] *= g; R[i] *= g; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
    return [L, R];
  }

  SPX.lab = { TESTS, addNoise, quantize, gain, crop, pad, echo, lowpass, resample, resampleRT, codecSim, demoHost };
});
