/* =====================================================================
 * SPECTRUM v2 — core/layout.js
 * Protocolo SPv2 + planejamento de capacidade.
 *
 * ┌─────────── tempo ───────────────────────────────────────────────┐
 * │ lead-in │ BEACON #0 │ P │ coluna 0 … coluna W−1 │ BEACON #1 │ tail │
 * └──────────────────────────────────────────────────────────────────┘
 * Frequência (dentro da banda [k0, k0+rows) com FFT de N pontos):
 *   linha 0 ............ piloto inferior (amplitude 1, fase conhecida)
 *   linhas 1..rows−2 ... pixels (rpp linhas de bin por linha de pixel)
 *   linha rows−1 ....... piloto superior
 *
 * Cada CÉLULA (bin k, coluna c) é uma senoide centrada no bin:
 *   s(n) = a·cos(2πk(n−S₀)/N + φ),  n relativo ao início da grade S₀
 * Como k é inteiro, a senoide é N-periódica: uma IFFT por coluna gera
 * o sinal inteiro da coluna (tiling). Entre colunas há crossfade
 * sin²/cos² de T amostras; a região plana (peso 1) tem ≥ N amostras,
 * então uma DFT retangular alinhada lê cada célula de forma EXATA
 * (ortogonalidade OFDM): |X| = a·N/2, arg X = φ (+ rotação conhecida).
 *
 *  a  = 10^(−(1−Y)·DR/20)   → luminância Y aparece linear em dB
 *  φ  = θ_k + 2π·sym/M      → camada de dados invisível (PSK)
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_layout(SPX) {
  'use strict';

  const PROTO = {
    MAGIC: 0x5350,          // 'SP'
    VERSION: 2,
    SYNC: 0xB5C3,           // palavra de sincronismo (16 bits) do beacon
    BEACON_N: 2048,         // FFT do beacon
    BEACON_G: 1024,         // guarda extra (tolerância de alinhamento)
    BEACON_T: 256,          // crossfade entre símbolos do beacon
    BEACON_CARRIERS: 128,   // portadoras DBPSK (diferencial em frequência)
    BEACON_SYMBOLS: 4,      // símbolos por cópia (4×127 bits ≥ 16 sync + 384 cabeçalho)
    BEACON_COPIES: 2,
    HEADER_BYTES: 48,       // 44 de campos + CRC32
    PREAMBLE_COLS: 2,       // colunas de referência de canal
    BEACON_SEED: 0x5EC7A1,  // fases-base fixas das portadoras do beacon
  };
  PROTO.BEACON_LS = PROTO.BEACON_N + PROTO.BEACON_G;                        // comprimento nominal de um símbolo
  PROTO.BEACON_COPY_LEN = PROTO.BEACON_LS * PROTO.BEACON_SYMBOLS; // uma cópia (início; a outra vai no fim)
  PROTO.BEACON_LEN = PROTO.BEACON_COPY_LEN;

  const MOD_BITS = { off: 0, bpsk: 1, qpsk: 2, '8psk': 3 };

  /** Fases-base do beacon (fixas, conhecidas por todos). */
  let _beaconTheta = null;
  function beaconTheta() {
    if (_beaconTheta) return _beaconTheta;
    const r = SPX.util.prng(PROTO.BEACON_SEED);
    _beaconTheta = new Float64Array(PROTO.BEACON_CARRIERS);
    for (let i = 0; i < _beaconTheta.length; i++) _beaconTheta[i] = r() * 2 * Math.PI;
    return _beaconTheta;
  }

  /** Fases-base por linha da grade (dependem da semente do arquivo). */
  function rowTheta(rows, seed) {
    const r = SPX.util.prng(SPX.util.subSeed(seed, 'rows'));
    const t = new Float64Array(rows);
    for (let i = 0; i < rows; i++) t[i] = r() * 2 * Math.PI;
    return t;
  }

  // ---- Cabeçalho (vai no beacon) -------------------------------------
  function packHeader(h) {
    const w = new SPX.util.ByteWriter(64);
    w.u16(PROTO.MAGIC).u8(PROTO.VERSION).u8(h.copy | 0)
     .u32(h.fs).u8(Math.round(Math.log2(h.N))).u16(h.k0).u16(h.rows).u16(h.cols)
     .u32(h.L).u16(h.T).u32((h.gridOffset + 0x80000000) >>> 0)
     .u8(h.DR).u16(h.imgW).u16(h.imgH).u8(h.rpp)
     .u8(h.modBits).u8(h.nsym).u24(h.payloadBlocks)
     .u32(h.seed >>> 0).u8(h.flags | 0);
    while (w.len < 44) w.u8(0);
    const body = w.out();
    const out = new Uint8Array(PROTO.HEADER_BYTES);
    out.set(body.subarray(0, 44));
    const c = SPX.util.crc32(body);
    out[44] = c & 255; out[45] = (c >>> 8) & 255; out[46] = (c >>> 16) & 255; out[47] = c >>> 24;
    return out;
  }
  function unpackHeader(bytes) {
    if (bytes.length < PROTO.HEADER_BYTES) return null;
    const c = SPX.util.crc32(bytes, 0, 44);
    const cr = (bytes[44] | (bytes[45] << 8) | (bytes[46] << 16) | (bytes[47] << 24)) >>> 0;
    if (c !== cr) return null;
    const r = new SPX.util.ByteReader(bytes);
    if (r.u16() !== PROTO.MAGIC) return null;
    const ver = r.u8(); if (ver !== PROTO.VERSION) return null;
    const h = { copy: r.u8(), fs: r.u32(), N: 1 << r.u8(), k0: r.u16(), rows: r.u16(), cols: r.u16(),
      L: r.u32(), T: r.u16(), gridOffset: r.u32() - 0x80000000, DR: r.u8(), imgW: r.u16(), imgH: r.u16(), rpp: r.u8(),
      modBits: r.u8(), nsym: r.u8(), payloadBlocks: r.u24(), seed: r.u32(), flags: r.u8() };
    return h;
  }

  /**
   * Planejamento de capacidade.
   * opts: { fs, N|'auto', fLow, fHigh, totalSamples|null, duration (s, se sem host),
   *         imgW, imgH, fillBand, fillDuration, modulation, nsym, payloadBytes,
   *         transRatio, autoDuration }
   */
  /**
   * Planejamento. Duas formas de fixar o tempo:
   *  • totalSamples (hospedeiro) ou duration (s, sem hospedeiro) → o tempo manda,
   *    e o N automático escolhe a MAIOR resolução que cabe nesse tempo;
   *  • autoDuration (sem hospedeiro, duração 0) → resolução nativa manda e a
   *    duração é derivada (pode ficar longa para imagens grandes).
   * regionStart/regionLength (amostras) limitam a imagem a um trecho do áudio.
   */
  function plan(o) {
    if (o.N !== 'auto' && o.N) return planFor(o, +o.N);
    const native = nativeN(o);
    if (!o.totalSamples && o.autoDuration) return planFor(o, native);
    // tempo fixo: testa N = 256…16384 e fica com o de maior escala (empate → N "nativo" mais próximo)
    let best = null;
    for (let N = 256; N <= 16384; N *= 2) {
      const r = planFor(o, N, true);
      if (!r.ok) continue;
      const score = r.scale + 1e-6 * (16 - Math.abs(Math.log2(N) - Math.log2(native)));
      if (!best || score > best.score) best = { score, N };
    }
    return planFor(o, best ? best.N : native);
  }
  function nativeN(o) {
    const bandHz = Math.min(o.fHigh, o.fs / 2 - o.fs / 1024) - Math.max(0, o.fLow);
    let N = 1024; while (N < 16384 && Math.floor(bandHz / (o.fs / N)) - 2 < o.imgH) N *= 2;
    return N;
  }

  function planFor(o, N, quiet) {
    const fs = o.fs;
    const nyq = fs / 2;
    const warnings = [], suggestions = [];
    let fLow = Math.max(0, Math.min(o.fLow, nyq - 100));
    let fHigh = Math.min(o.fHigh, nyq - fs / 1024);
    if (fHigh <= fLow + 200) { fHigh = Math.min(nyq * 0.98, fLow + 2000); warnings.push('Banda inválida para fs = ' + fs + ' Hz — ajustada.'); }
    const bandHz = fHigh - fLow;
    const df = fs / N;
    const k0 = Math.ceil(fLow / df);
    const k1 = Math.floor(fHigh / df);
    const bandBins = k1 - k0 + 1;
    const maxImgRows = Math.max(1, bandBins - 2);

    const T = Math.max(32, Math.round(N * (o.transRatio || 0.25)));
    const margin = Math.max(16, N >> 3);
    const Lmin = N + T + margin;
    const P = PROTO.PREAMBLE_COLS;
    const pad = Math.round(0.08 * fs);
    // fim da região: fade da última coluna + cópia final do beacon + folga
    const tail = T + PROTO.BEACON_COPY_LEN + pad;
    const overhead = pad + PROTO.BEACON_COPY_LEN + T + T + tail; // tudo que não é coluna

    let totalSamples = o.totalSamples || 0;
    const hasHost = !!o.totalSamples;
    if (!hasHost && !o.autoDuration) totalSamples = Math.round((o.duration || 10) * fs);
    // região da imagem dentro do áudio
    let regionStart = 0, regionLen = totalSamples;
    if (hasHost || !o.autoDuration) {
      regionStart = Math.max(0, Math.min(Math.round(o.regionStart || 0), totalSamples - 1));
      regionLen = totalSamples - regionStart;
      if (o.regionLength > 0) regionLen = Math.min(regionLen, Math.round(o.regionLength));
    }
    const leadIn = regionStart + pad;
    const gridStart = leadIn + PROTO.BEACON_COPY_LEN + T; // S₀ (absoluto, no arquivo)
    let maxCols = (!hasHost && o.autoDuration) ? Infinity : Math.floor((regionLen - overhead) / Lmin) - P;
    if (maxCols < 4) {
      return { ok: false, error: `Tempo curto demais para N = ${N}: são necessários pelo menos ${((overhead + (P + 4) * Lmin) / fs).toFixed(2)} s (há ${(regionLen / fs).toFixed(2)} s).`, N, fs };
    }

    // Escala única (preserva proporção) apenas se a capacidade não basta.
    const sRows = maxImgRows / o.imgH, sCols = maxCols / o.imgW;
    const s = Math.min(1, sRows, sCols);
    const w = Math.max(1, Math.floor(o.imgW * s + 1e-9));
    const h = Math.max(1, Math.floor(o.imgH * s + 1e-9));
    // duração mínima para a resolução nativa (melhor N), útil como sugestão
    const nativeSeconds = (() => {
      let best = Infinity;
      for (let n = 256; n <= 16384; n *= 2) {
        if (Math.floor(bandHz / (fs / n)) - 2 < o.imgH) continue;
        const t = Math.max(32, Math.round(n * (o.transRatio || 0.25)));
        const lm = n + t + Math.max(16, n >> 3);
        const ov = pad + PROTO.BEACON_COPY_LEN + 2 * t + t + PROTO.BEACON_COPY_LEN + pad;
        best = Math.min(best, (ov + (o.imgW + P) * lm) / fs);
      }
      return best;
    })();
    if (s < 1 && !quiet) {
      const lim = sRows < sCols ? 'banda' : 'tempo';
      warnings.push(`${o.imgW}×${o.imgH} nativo não cabe em ${(regionLen / fs).toFixed(1)} s nesta banda (limite: ${lim}). Imagem reduzida para ${w}×${h} (${(s * 100).toFixed(0)}%).`);
      if (isFinite(nativeSeconds)) suggestions.push(`Resolução nativa exige ≥ ${nativeSeconds.toFixed(1)} s com a banda atual.`);
      suggestions.push(`Para mais pixels no mesmo tempo, alargue a banda (ex.: "Ampla · 1–20 kHz") — capacidade ≈ banda × tempo.`);
      if (sRows < 1 && fs < 96000) suggestions.push('Ou exporte a 96 kHz com a banda ultrassônica (22–46 kHz).');
    }

    const rpp = o.fillBand ? Math.max(1, Math.min(32, Math.floor(maxImgRows / h))) : 1;
    const rows = h * rpp + 2;
    const cols = w;

    let L = Lmin;
    if (!hasHost && o.autoDuration) {
      L = Math.round(Lmin * 1.6); // colunas um pouco mais longas → melhor leitura em visualizadores genéricos
      totalSamples = overhead + (cols + P) * L;
      regionLen = totalSamples;
    } else if (o.fillDuration) {
      L = Math.max(Lmin, Math.floor((regionLen - overhead) / (cols + P)));
    }
    const gridEnd = gridStart + (cols + P) * L;
    const beaconStarts = [leadIn, gridEnd + T];         // início da cópia 0 e da cópia 1
    const regionEnd = Math.min(totalSamples, beaconStarts[1] + PROTO.BEACON_COPY_LEN + pad);

    // ---- Camada de dados -------------------------------------------
    const modBits = MOD_BITS[o.modulation] || 0;
    const dataCells = (rows - 2) * cols;
    const rawBits = dataCells * modBits;
    const rawBytes = Math.floor(rawBits / 8);
    const nsym = o.nsym || 32;
    const fullBlocks = Math.floor(rawBytes / 255);      // blocos RS(255, 255−nsym) completos
    const payloadCapacity = modBits ? fullBlocks * (255 - nsym) : 0;
    const payloadBytes = Math.min(o.payloadBytes || 0, payloadCapacity);
    const payloadBlocks = payloadBytes ? Math.ceil(payloadBytes / (255 - nsym)) : 0;
    if (modBits && o.payloadBytes > payloadCapacity && !quiet) {
      warnings.push(`Payload de ${SPX.util.fmtBytes(o.payloadBytes)} não cabe (capacidade ${SPX.util.fmtBytes(payloadCapacity)}).`);
    }

    // Capacidade "física" de pixels (princípio da incerteza tempo-frequência)
    const pixelCapacity = maxImgRows * (isFinite(maxCols) ? maxCols : cols);

    return {
      ok: true, fs, N, df, k0, k1, bandBins, fLow: k0 * df, fHigh: (k0 + rows - 1) * df, bandFLow: fLow, bandFHigh: fHigh,
      T, margin, L, Lmin, leadIn, tail, gridStart, gridEnd, beaconStarts, P, totalSamples, duration: totalSamples / fs,
      regionStart, regionEnd, regionSeconds: (regionEnd - regionStart) / fs, imageSeconds: (gridEnd - gridStart) / fs, nativeSeconds,
      maxImgRows, maxCols: isFinite(maxCols) ? maxCols : null, scale: s, w, h, rpp, rows, cols,
      colSeconds: L / fs, cellHz: df,
      modBits, nsym, dataCells, rawBytes, payloadCapacity, payloadBytes, payloadBlocks,
      pixelCapacity, warnings, suggestions, hasHost,
    };
  }

  SPX.layout = { PROTO, MOD_BITS, plan, packHeader, unpackHeader, beaconTheta, rowTheta };
});
