/* =====================================================================
 * SPECTRUM v2 — core/encoder.js
 * Pintura espectral por síntese OFDM-like (IFFT por coluna + crossfade).
 *
 * Pipeline:
 *   1. (opcional) "Carving": remove a energia do hospedeiro na banda da
 *      imagem via STFT (√Hann, 75% overlap, máscara com transição suave).
 *      → a imagem fica limpa no espectrograma e a leitura é quase exata.
 *   2. Beacon: 2 cópias × 4 símbolos DBPSK em frequência com o
 *      cabeçalho (parâmetros de decodificação) protegido por CRC32.
 *   3. Grade: 2 colunas de preâmbulo (referência de canal) + W colunas
 *      de pixels; pilotos nas linhas extremas.
 *   4. Nível: RMS da camada relativo ao RMS do hospedeiro (dB),
 *      mascaramento adaptativo opcional por coluna.
 *   5. Mixagem + proteção contra clipping (escala linear global).
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_encoder(SPX) {
  'use strict';
  const { fft, makeWindow } = SPX.fft;
  const { PROTO } = SPX.layout;
  const TWO_PI = 2 * Math.PI;

  /** Peso de crossfade sin²/cos² para uma coluna [S, S+L) com transição T. */
  function colWeight(n, S, L, T) {
    const a = n - (S - T / 2);
    if (a < 0) return 0;
    if (a < T) { const s = Math.sin(0.5 * Math.PI * a / T); return s * s; }
    const b = n - (S + L - T / 2);
    if (b < 0) return 1;
    if (b < T) { const c = Math.cos(0.5 * Math.PI * b / T); return c * c; }
    return 0;
  }

  /**
   * Soma em `out` um segmento N-periódico x (IFFT) com peso de coluna.
   * ref = amostra de referência de fase (x[0] corresponde a n ≡ ref mod N).
   */
  function addSegment(out, x, N, ref, S, L, T, gain) {
    const n0 = Math.max(0, Math.floor(S - T / 2));
    const n1 = Math.min(out.length, Math.ceil(S + L + T / 2));
    const mask = N - 1;
    for (let n = n0; n < n1; n++) {
      const w = colWeight(n, S, L, T);
      if (w === 0) continue;
      out[n] += gain * w * x[((n - ref) % N + N) & mask];
    }
  }

  // ---- 1. Carving do hospedeiro ---------------------------------------
  /**
   * Filtro espectral por STFT (√Hann, hop N/4 → reconstrução perfeita).
   * mode 'cut'  → atenua [fA,fB] (carving do hospedeiro)
   * mode 'keep' → mantém só [fA,fB] (pré-filtro do decodificador: elimina o
   *              hospedeiro fora da banda, cujo vazamento pela janela
   *              retangular da leitura OFDM seria dominante).
   */
  function carve(channels, fs, fA, fB, depthDb, onProgress, mode) {
    const keep = mode === 'keep';
    let N = 4096; while (N * 48000 < 4096 * fs && N < 16384) N *= 2;
    const hop = N >> 2, win = makeWindow('sqrthann', N);
    const df = fs / N;
    const kA = Math.floor(fA / df), kB = Math.ceil(fB / df), taper = 4;
    const floor = Math.pow(10, -Math.abs(depthDb) / 20);
    const gain = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) {
      let g = 1; // g = ganho "dentro→fora" com transição cosseno de `taper` bins
      if (k >= kA && k <= kB) g = floor;
      else if (k < kA && k >= kA - taper) { const t = (kA - k) / (taper + 1); g = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(Math.PI * t)); }
      else if (k > kB && k <= kB + taper) { const t = (k - kB) / (taper + 1); g = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(Math.PI * t)); }
      gain[k] = keep ? (1 - g) / (1 - floor) : g;
    }
    const re = new Float64Array(N), im = new Float64Array(N);
    const out = channels.map(c => new Float32Array(c.length));
    const len = channels[0].length;
    // processa canais em pares: z = a + i·b (ambos reais → espectros hermitianos)
    for (let ci = 0; ci < channels.length; ci += 2) {
      const a = channels[ci], b = channels[ci + 1];
      const oa = out[ci], ob = b ? out[ci + 1] : null;
      let frame = 0;
      for (let t = -N + hop; t < len; t += hop, frame++) {
        for (let m = 0; m < N; m++) {
          const n = t + m, inside = n >= 0 && n < len;
          re[m] = inside ? a[n] * win[m] : 0;
          im[m] = inside && b ? b[n] * win[m] : 0;
        }
        fft(re, im, false);
        // a máscara é real e simétrica → aplica direto em Z (preserva a separação a/b)
        for (let k = 0; k <= N / 2; k++) {
          const g = gain[k];
          re[k] *= g; im[k] *= g;
          if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
        }
        fft(re, im, true);
        for (let m = 0; m < N; m++) {
          const n = t + m;
          if (n < 0 || n >= len) continue;
          oa[n] += 0.5 * re[m] * win[m];          // Σ hann (hop N/4) = 2
          if (ob) ob[n] += 0.5 * im[m] * win[m];
        }
        if (onProgress && (frame & 255) === 0) onProgress((t + N) / len);
      }
    }
    return out;
  }

  // ---- bits ↔ bytes ---------------------------------------------------
  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    return bits;
  }

  /** Constrói o fluxo codificado: RS por bloco → interleave → whitening. */
  function buildCodedStream(container, plan, seed) {
    const k = 255 - plan.nsym, blocks = plan.payloadBlocks;
    const padded = new Uint8Array(blocks * k);
    padded.set(container.subarray(0, Math.min(container.length, padded.length)));
    const cws = [];
    for (let b = 0; b < blocks; b++) cws.push(SPX.rs.encode(padded.subarray(b * k, (b + 1) * k), plan.nsym));
    const stream = new Uint8Array(blocks * 255);
    // interleave por byte: byte i de todos os blocos fica adjacente →
    // uma rajada de erros se espalha por blocos diferentes.
    for (let i = 0; i < 255; i++) for (let b = 0; b < blocks; b++) stream[i * blocks + b] = cws[b][i];
    const r = SPX.util.prng(SPX.util.subSeed(seed, 'white'));
    for (let i = 0; i < stream.length; i++) stream[i] ^= (r() * 256) | 0;
    return stream;
  }

  /** Símbolos M-PSK (código Gray) para todas as células de dados, já permutados. */
  function buildSymbols(plan, stream, seed) {
    const m = plan.modBits, M = 1 << m, cells = plan.dataCells;
    const sym = new Uint8Array(cells);
    if (!m) return sym;
    const bits = bytesToBits(stream);
    const fill = SPX.util.prng(SPX.util.subSeed(seed, 'fill'));
    const perm = SPX.util.permutation(cells, SPX.util.subSeed(seed, 'perm'));
    for (let j = 0; j < cells; j++) {
      let v = 0;
      for (let b = 0; b < m; b++) {
        const idx = j * m + b;
        const bit = idx < bits.length ? bits[idx] : (fill() < 0.5 ? 1 : 0);
        v = (v << 1) | bit;
      }
      sym[perm[j]] = (v ^ (v >> 1)) & (M - 1); // Gray
    }
    return sym;
  }

  // ---- 2. Beacon -------------------------------------------------------
  function beaconBits(headerBytes) {
    const total = (PROTO.BEACON_CARRIERS - 1) * PROTO.BEACON_SYMBOLS;
    const bits = new Uint8Array(total);
    for (let i = 0; i < 16; i++) bits[i] = (PROTO.SYNC >> (15 - i)) & 1;
    const hb = bytesToBits(headerBytes);
    bits.set(hb, 16);
    const r = SPX.util.prng(0xBEAC);
    for (let i = 16 + hb.length; i < total; i++) bits[i] = r() < 0.5 ? 1 : 0;
    return bits;
  }
  function beaconStartBin(plan) {
    const Nh = PROTO.BEACON_N, dfh = plan.fs / Nh, C = PROTO.BEACON_CARRIERS;
    const lo = Math.ceil(plan.fLow / dfh), hi = Math.floor(plan.fHigh / dfh);
    // na BASE da banda da imagem: codecs com perdas cortam agudos primeiro,
    // então o beacon (parâmetros) sobrevive mesmo se o topo da imagem se perder
    let kb0 = lo;
    void hi;
    kb0 = Math.max(2, Math.min(kb0, Nh / 2 - C - 2));
    return kb0;
  }
  function synthBeacon(out, plan, headers) {
    const Nh = PROTO.BEACON_N, Ls = PROTO.BEACON_LS, Th = PROTO.BEACON_T, C = PROTO.BEACON_CARRIERS;
    const theta = SPX.layout.beaconTheta();
    const kb0 = beaconStartBin(plan);
    const re = new Float64Array(Nh), im = new Float64Array(Nh);
    for (let q = 0; q < PROTO.BEACON_COPIES; q++) {
      const bits = beaconBits(headers[q]);
      for (let s = 0; s < PROTO.BEACON_SYMBOLS; s++) {
        const B = plan.beaconStarts[q] + s * Ls;
        re.fill(0); im.fill(0);
        let flip = 0;
        for (let j = 0; j < C; j++) {
          if (j > 0) flip ^= bits[s * (C - 1) + j - 1];
          const ph = theta[j] + Math.PI * flip;
          const k = kb0 + j;
          re[k] = 0.5 * Nh * Math.cos(ph); im[k] = 0.5 * Nh * Math.sin(ph);
          re[Nh - k] = re[k]; im[Nh - k] = -im[k];
        }
        fft(re, im, true);
        addSegment(out, re, Nh, B, B, Ls, Th, 1);
      }
    }
    return kb0;
  }

  // ---- 3. Grade ----------------------------------------------------------
  /**
   * luma: Float32Array(h·w) em [0,1], linha 0 = topo da imagem.
   * gains: ganho por coluna (mascaramento), comprimento P+cols.
   */
  function synthGrid(out, plan, luma, symbols, seed, DR, gains, onProgress) {
    const { N, k0, rows, cols, rpp, P, L, T, gridStart: S0 } = plan;
    const theta = SPX.layout.rowTheta(rows, seed);
    const M = 1 << plan.modBits;
    const dataRows = rows - 2;
    const re = new Float64Array(N), im = new Float64Array(N);
    const ampLUT = new Float64Array(256);
    for (let i = 0; i < 256; i++) ampLUT[i] = Math.pow(10, -(1 - i / 255) * DR / 20);
    const half = 0.5 * N;
    for (let c = 0; c < P + cols; c++) {
      re.fill(0); im.fill(0);
      const isPre = c < P, x = c - P;
      for (let r = 0; r < rows; r++) {
        let a = 1, ph = theta[r];
        if (!isPre && r > 0 && r < rows - 1) {
          const y = plan.h - 1 - Math.floor((r - 1) / rpp);             // linha de pixel (0 = topo)
          const Y = luma[y * plan.w + x];
          a = ampLUT[Math.max(0, Math.min(255, Math.round(Y * 255)))];
          if (M > 1) ph += TWO_PI * symbols[x * dataRows + (r - 1)] / M;
        }
        const k = k0 + r;
        re[k] = half * a * Math.cos(ph); im[k] = half * a * Math.sin(ph);
        re[N - k] = re[k]; im[N - k] = -im[k];
      }
      fft(re, im, true);
      addSegment(out, re, N, S0, S0 + c * L, L, T, gains ? gains[c] : 1);
      if (onProgress && (c % 8 === 0 || c === P + cols - 1)) onProgress(c / (P + cols - 1), c);
    }
  }

  // ---- utilitários de nível ---------------------------------------------
  function rms(x, a = 0, b = x.length) {
    let s = 0; a = Math.max(0, a); b = Math.min(x.length, b);
    for (let i = a; i < b; i++) s += x[i] * x[i];
    return b > a ? Math.sqrt(s / (b - a)) : 0;
  }

  /**
   * Codificação completa.
   * args: { host: Float32Array[] | null, fs, plan, luma, container (Uint8Array|null),
   *         seed, DR, levelDb, carve, carveDepth, masking (0..1), gamma }
   */
  function encode(args, progress) {
    const P = progress || (() => {});
    const { plan, fs } = args;
    const seed = args.seed >>> 0;
    const total = plan.totalSamples;
    const t0 = Date.now();

    // 1. hospedeiro
    let host = args.host ? args.host.map(c => {
      if (c.length === total) return c;
      const o = new Float32Array(total); o.set(c.subarray(0, total)); return o;
    }) : null;
    const hostRmsOrig = host ? rms(host[0]) : 0;
    let hostCarved = false;
    if (host && args.carve) {
      P({ stage: 'carve', p: 0, msg: 'Removendo hospedeiro da banda…' });
      const kb0 = beaconStartBin(plan), dfh = fs / PROTO.BEACON_N;
      const fA = Math.min(plan.fLow, kb0 * dfh) - 4 * plan.df;
      const fB = Math.max(plan.fHigh, (kb0 + PROTO.BEACON_CARRIERS) * dfh) + 4 * plan.df;
      // carving só no trecho da imagem; fora dele o hospedeiro fica intacto (crossfade de 50 ms)
      const a = Math.max(0, plan.regionStart), b = Math.min(total, plan.regionEnd);
      const fade = Math.round(0.05 * fs), x0 = Math.max(0, a - fade), x1 = Math.min(total, b + fade);
      const seg = host.map(c => c.subarray(x0, x1));
      const cut = carve(seg, fs, fA, fB, args.carveDepth == null ? 90 : args.carveDepth, p => P({ stage: 'carve', p }));
      host = host.map((c, ci) => {
        const o = new Float32Array(c);
        for (let n = x0; n < x1; n++) {
          const g = n < a ? (n - x0) / Math.max(1, a - x0) : n >= b ? (x1 - n) / Math.max(1, x1 - b) : 1;
          const w = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, g)));
          o[n] = (1 - w) * c[n] + w * cut[ci][n - x0];
        }
        return o;
      });
      hostCarved = true;
    }

    // 2. cabeçalho + fluxo de dados
    const stream = plan.modBits && args.container && plan.payloadBlocks ? buildCodedStream(args.container, plan, seed) : new Uint8Array(0);
    const symbols = buildSymbols(plan, stream, seed);
    const headers = [];
    for (let q = 0; q < PROTO.BEACON_COPIES; q++) {
      const B0 = plan.beaconStarts[q];
      headers.push(SPX.layout.packHeader({
        copy: q, fs, N: plan.N, k0: plan.k0, rows: plan.rows, cols: plan.cols, L: plan.L, T: plan.T,
        gridOffset: plan.gridStart - B0, DR: args.DR, imgW: plan.w, imgH: plan.h, rpp: plan.rpp,
        modBits: plan.modBits, nsym: plan.nsym, payloadBlocks: stream.length ? plan.payloadBlocks : 0,
        seed, flags: (hostCarved ? 1 : 0) | (args.masking > 0 ? 2 : 0),
      }));
    }

    // 3. ganhos por coluna (mascaramento adaptativo)
    const nCols = plan.P + plan.cols;
    let gains = null;
    if (host && args.masking > 0) {
      const mono = host[0];
      const g = new Float64Array(nCols), lv = new Float64Array(nCols);
      const ref = rms(mono, plan.gridStart, plan.gridEnd) || 1e-9;
      for (let c = 0; c < nCols; c++) {
        const S = plan.gridStart + c * plan.L;
        lv[c] = 20 * Math.log10((rms(mono, S, S + plan.L) + 1e-9) / ref);
      }
      // suaviza (média móvel de 5 colunas) e limita a ±9 dB·intensidade
      const lim = 9 * args.masking;
      for (let c = 0; c < nCols; c++) {
        let s = 0, n = 0;
        for (let d = -2; d <= 2; d++) { const i = c + d; if (i >= 0 && i < nCols) { s += lv[i]; n++; } }
        g[c] = Math.pow(10, SPX.util.clamp(args.masking * s / n, -lim, lim * 0.5) / 20);
      }
      gains = g;
    }

    // 4. síntese da camada
    const layer = new Float32Array(total);
    P({ stage: 'beacon', p: 0, msg: 'Sintetizando beacon…' });
    const kb0 = synthBeacon(layer, plan, headers);
    P({ stage: 'grid', p: 0, msg: 'Pintando espectro…' });
    synthGrid(layer, plan, args.luma, symbols, seed, args.DR, gains, (p, c) => P({ stage: 'grid', p, col: c }));

    // 5. nível relativo + mixagem
    const hostGridRms = host ? rms(host[0], plan.gridStart, plan.gridEnd) : 0;
    const hostRefRms = host ? Math.max(hostGridRms, hostRmsOrig * 0.25) : 0;
    const layerRms = rms(layer, plan.gridStart, plan.gridEnd) || 1e-9;
    let layerGain;
    const useHost = host && hostRefRms > 1e-4;
    if (useHost) layerGain = hostRefRms * Math.pow(10, args.levelDb / 20) / layerRms;
    else {
      let pk = 0; for (let i = 0; i < total; i++) { const a = Math.abs(layer[i]); if (a > pk) pk = a; }
      layerGain = 0.89 / (pk || 1);
    }
    const nCh = host ? host.length : 1;
    const out = [];
    let peak = 0;
    for (let ch = 0; ch < nCh; ch++) {
      const o = new Float32Array(total);
      const h = host ? host[ch] : null;
      for (let i = 0; i < total; i++) {
        const v = (h ? h[i] : 0) + layerGain * layer[i];
        o[i] = v; const a = Math.abs(v); if (a > peak) peak = a;
      }
      out.push(o);
    }
    let limitGain = 1;
    if (peak > 0.98) {
      limitGain = 0.98 / peak;
      for (const o of out) for (let i = 0; i < total; i++) o[i] *= limitGain;
    }

    const embedRms = layerRms * layerGain * limitGain;
    const stats = {
      ms: Date.now() - t0,
      samples: total, channels: nCh, fs,
      kb0, hostCarved,
      layerRmsDb: 20 * Math.log10(embedRms + 1e-12),
      hostRmsDb: host ? 20 * Math.log10(hostGridRms * limitGain + 1e-12) : null,
      embedToHostDb: useHost ? 20 * Math.log10(embedRms / (hostGridRms * limitGain + 1e-12)) : null,
      peakDb: 20 * Math.log10(peak * limitGain + 1e-12),
      limiterDb: 20 * Math.log10(limitGain),
      payloadStreamBytes: stream.length,
    };
    return { channels: out, stats, header: SPX.layout.unpackHeader(headers[0]) };
  }

  SPX.encoder = { encode, carve, colWeight, beaconStartBin, bytesToBits, rms };
});
