/* =====================================================================
 * SPECTRUM v2 — core/decoder.js
 *
 * 1. LOCALIZAÇÃO (sem conhecer parâmetros):
 *    Varre janelas retangulares de 2048 amostras (passo 256). Para cada
 *    bin inicial candidato kb0, faz a demodulação DBPSK diferencial em
 *    frequência:  z_j = X_j·X*_{j−1}·e^{−iΔθ_j}
 *    Um desalinhamento temporal δ gira todos os z_j por 2πδ/N (mesmo
 *    ângulo) → estimado por arg(Σ z_j²)/2, e a palavra de sync resolve a
 *    ambiguidade de π. Daí obtemos o início EXATO do símbolo (sub-amostra).
 * 2. CABEÇALHO: 4 símbolos → 16 bits sync + 48 bytes (CRC32).
 * 3. GRADE: DFT retangular de N pontos no centro da região plana de cada
 *    coluna. Preâmbulo → estimativa de canal por linha H_r.
 *    Pilotos → correção de ganho/fase por coluna. |Z| → luminância,
 *    arg Z → símbolos PSK → bits → whitening⁻¹ → deinterleave → RS.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_decoder(SPX) {
  'use strict';
  const { fft, fft2real } = SPX.fft;
  const { PROTO } = SPX.layout;
  const TWO_PI = 2 * Math.PI;

  function toMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length, m = new Float32Array(n), k = 1 / channels.length;
    for (const c of channels) for (let i = 0; i < n; i++) m[i] += c[i] * k;
    return m;
  }

  const SYNC_BITS = (() => { const b = []; for (let i = 0; i < 16; i++) b.push((PROTO.SYNC >> (15 - i)) & 1); return b; })();

  /** DFT retangular de N amostras a partir de `start` (zero fora do sinal). */
  function dftAt(mono, start, N, re, im) {
    for (let m = 0; m < N; m++) {
      const n = start + m;
      re[m] = n >= 0 && n < mono.length ? mono[n] : 0; im[m] = 0;
    }
    fft(re, im, false);
  }

  /** Demodula bits DBPSK dos carriers 1..C−1, dada a rotação estimada. */
  function demodBeaconSymbol(re, im, kb0, rotHint) {
    const C = PROTO.BEACON_CARRIERS, th = SPX.layout.beaconTheta();
    const zr = new Float64Array(C), zi = new Float64Array(C);
    let sr = 0, si = 0, pw = 0;
    for (let j = 1; j < C; j++) {
      const a = kb0 + j - 1, b = kb0 + j;
      // X_b · conj(X_a)
      let pr = re[b] * re[a] + im[b] * im[a];
      let pi = im[b] * re[a] - re[b] * im[a];
      const d = -(th[j] - th[j - 1]);
      const c = Math.cos(d), s = Math.sin(d);
      const r2 = pr * c - pi * s, i2 = pr * s + pi * c;
      zr[j] = r2; zi[j] = i2;
      const m = Math.hypot(r2, i2) || 1e-30;
      // z²/|z| (pondera por amplitude, remove modulação BPSK)
      sr += (r2 * r2 - i2 * i2) / m; si += (2 * r2 * i2) / m; pw += m;
    }
    let rot = 0.5 * Math.atan2(si, sr); // ambíguo em π
    if (rotHint != null) { // escolhe rot ou rot+π mais próximo da dica
      const d1 = Math.abs(angDiff(rot, rotHint)), d2 = Math.abs(angDiff(rot + Math.PI, rotHint));
      if (d2 < d1) rot += Math.PI;
    }
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const bits = new Uint8Array(C - 1), soft = new Float64Array(C - 1);
    for (let j = 1; j < C; j++) {
      const v = zr[j] * c - zi[j] * s;
      bits[j - 1] = v < 0 ? 1 : 0; soft[j - 1] = Math.abs(v);
    }
    const coherence = Math.hypot(sr, si) / (pw || 1); // 1 = perfeito
    return { bits, soft, rot, coherence };
  }
  function angDiff(a, b) { let d = (a - b) % TWO_PI; if (d > Math.PI) d -= TWO_PI; if (d < -Math.PI) d += TWO_PI; return d; }

  function bitsToBytes(bits, off, nBytes) {
    const out = new Uint8Array(nBytes);
    for (let i = 0; i < nBytes; i++) { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | (bits[off + i * 8 + b] & 1); out[i] = v; }
    return out;
  }

  /**
   * Procura o beacon e decodifica o cabeçalho.
   * Retorna { header, B (início do símbolo 0 da cópia), kb0, coherence, copy } ou null.
   */
  function locate(mono, fs, opts) {
    opts = opts || {};
    const Nh = PROTO.BEACON_N, C = PROTO.BEACON_CARRIERS, Ls = PROTO.BEACON_LS, Th = PROTO.BEACON_T, G = PROTO.BEACON_G;
    const hop = 256;
    const re = new Float64Array(Nh), im = new Float64Array(Nh);
    const aRe = new Float64Array(Nh / 2 + 1), aIm = new Float64Array(Nh / 2 + 1), bRe = new Float64Array(Nh / 2 + 1), bIm = new Float64Array(Nh / 2 + 1);
    const th = SPX.layout.beaconTheta();
    const cD = new Float64Array(17), sD = new Float64Array(17);
    for (let j = 1; j <= 16; j++) { const d = -(th[j] - th[j - 1]); cD[j] = Math.cos(d); sD[j] = Math.sin(d); }
    const mag = new Float64Array(Nh / 2 + 1), sorted = new Float64Array(Nh / 2 + 1);
    const DR = new Float64Array(Nh / 2 + 1), DI = new Float64Array(Nh / 2 + 1);
    const zr = new Float64Array(17), zi = new Float64Array(17);

    const scanRange = (from, to) => {
      for (let w = from; w + Nh <= to; w += 2 * hop) {
        // duas janelas por FFT complexa
        const w2 = w + hop;
        fft2real(mono.subarray(w, w + Nh), w2 + Nh <= mono.length ? mono.subarray(w2, w2 + Nh) : null, re, im, aRe, aIm, bRe, bIm);
        for (const [ws, XR, XI] of [[w, aRe, aIm], [w2, bRe, bIm]]) {
          if (ws + Nh > to) continue;
          const r = tryWindow(ws, XR, XI);
          if (r) return r;
        }
        if (opts.onProgress && ((w / hop) & 127) === 0) opts.onProgress((w - from) / (to - from));
      }
      return null;
    };

    function tryWindow(ws, XR, XI) {
      // referência de energia = mediana do espectro (robusta a tons fortes do hospedeiro)
      for (let k = 0; k <= Nh / 2; k++) { mag[k] = Math.hypot(XR[k], XI[k]); sorted[k] = mag[k]; }
      sorted.sort();
      const mean = Math.max(sorted[Nh >> 3], 1e-9); // 1º quartil
      if (sorted[Nh / 2] < 1e-7) return null;
      for (let k = 1; k <= Nh / 2; k++) { // D_k = X_k·conj(X_{k−1})
        DR[k] = XR[k] * XR[k - 1] + XI[k] * XI[k - 1];
        DI[k] = XI[k] * XR[k - 1] - XR[k] * XI[k - 1];
      }
      // teste de energia: portadoras do beacon bem acima da média do espectro
      for (let kb0 = 2; kb0 < Nh / 2 - C - 2; kb0++) {
        let e = 0;
        for (let j = 0; j < 17; j++) e += mag[kb0 + j];
        if (e < 17 * 3 * mean) continue;
        let sr = 0, si = 0;
        for (let j = 1; j <= 16; j++) {
          const pr = DR[kb0 + j], pi = DI[kb0 + j];
          const r2 = pr * cD[j] - pi * sD[j], i2 = pr * sD[j] + pi * cD[j];
          zr[j] = r2; zi[j] = i2;
          const m = Math.hypot(r2, i2) || 1e-30;
          sr += (r2 * r2 - i2 * i2) / m; si += 2 * r2 * i2 / m;
        }
        const rot = 0.5 * Math.atan2(si, sr), c = Math.cos(-rot), s = Math.sin(-rot);
        let match = 0;
        for (let j = 1; j <= 16; j++) {
          const bit = (zr[j] * c - zi[j] * s) < 0 ? 1 : 0;
          if (bit === SYNC_BITS[j - 1]) match++;
        }
        if (match >= 15 || match <= 1) {
          const res = fullBeacon(ws, kb0, match >= 15 ? rot : rot + Math.PI);
          if (res) return res;
        }
      }
      return null;
    }

    function fullBeacon(ws, kb0, rot) {
      // rot ≡ 2π(ws − B)/Nh  (mod 2π)  →  B = ws − d
      let d = ((rot % TWO_PI) + TWO_PI) % TWO_PI * Nh / TWO_PI;
      const B = ws - d;
      const center = Th / 2 + (G - Th) / 2; // deslocamento ideal dentro da região plana
      const bits = new Uint8Array((C - 1) * PROTO.BEACON_SYMBOLS);
      let coh = 0;
      for (let s = 0; s < PROTO.BEACON_SYMBOLS; s++) {
        const start = Math.round(B + s * Ls + center);
        dftAt(mono, start, Nh, re, im);
        const hint = TWO_PI * (start - B - s * Ls) / Nh;
        const r = demodBeaconSymbol(re, im, kb0, hint);
        bits.set(r.bits, s * (C - 1));
        coh += r.coherence / PROTO.BEACON_SYMBOLS;
      }
      for (let i = 0; i < 16; i++) if (bits[i] !== SYNC_BITS[i]) return null;
      const hb = bitsToBytes(bits, 16, PROTO.HEADER_BYTES);
      const header = SPX.layout.unpackHeader(hb);
      if (!header) return null;
      return { header, B, kb0, coherence: coh, copy: header.copy, windowStart: ws };
    }

    // ordem de busca: início (cópia 0), fim (cópia 1), depois o meio
    const span = Math.round((opts.firstSeconds || 12) * fs), len = mono.length;
    let r = scanRange(0, Math.min(len, span));
    if (!r && len > span) r = scanRange(Math.max(0, len - span), len);
    if (!r && len > 2 * span) r = scanRange(Math.max(0, span - 2 * Nh), Math.min(len, len - span + 2 * Nh));
    return r;
  }

  /**
   * Lê a matriz complexa da grade (normalizada: pilotos → 1).
   * Retorna { Z: Float32Array(rows·colsTot·2), S0, windows, noise }.
   */
  function readGrid(mono, loc, onProgress) {
    const h = loc.header, N = h.N, rows = h.rows, P = PROTO.PREAMBLE_COLS, nCols = P + h.cols;
    const S0 = loc.B + h.gridOffset;
    const theta = SPX.layout.rowTheta(rows, h.seed);
    const re = new Float64Array(N), im = new Float64Array(N);
    const aRe = new Float64Array(N / 2 + 1), aIm = new Float64Array(N / 2 + 1), bRe = new Float64Array(N / 2 + 1), bIm = new Float64Array(N / 2 + 1);
    const off = h.T / 2 + (h.L - h.T - N) / 2;
    const GUARD = 2; // bins k0−2,k0−3 e acima do topo: dentro da zona "carved" do encoder
    const Y = new Float64Array(nCols * rows * 2);
    const noiseAcc = new Float64Array(nCols);
    const segA = new Float32Array(N), segB = new Float32Array(N);
    const fill = (seg, start) => { for (let m = 0; m < N; m++) { const n = start + m; seg[m] = n >= 0 && n < mono.length ? mono[n] : 0; } };
    const starts = new Float64Array(nCols);
    for (let c = 0; c < nCols; c++) starts[c] = Math.round(S0 + c * h.L + off);
    for (let c = 0; c < nCols; c += 2) {
      fill(segA, starts[c]);
      const two = c + 1 < nCols;
      if (two) fill(segB, starts[c + 1]);
      fft2real(segA, two ? segB : null, re, im, aRe, aIm, bRe, bIm);
      for (let q = 0; q < (two ? 2 : 1); q++) {
        const cc = c + q, XR = q ? bRe : aRe, XI = q ? bIm : aIm;
        const dt = starts[cc] - S0;
        for (let r = 0; r < rows; r++) {
          const k = h.k0 + r;
          // remove fase-base e rotação do deslocamento da janela
          const ph = -(theta[r] + TWO_PI * ((k * dt) % N) / N);
          const c1 = Math.cos(ph), s1 = Math.sin(ph);
          const xr = XR[k] * 2 / N, xi = XI[k] * 2 / N;
          Y[(cc * rows + r) * 2] = xr * c1 - xi * s1;
          Y[(cc * rows + r) * 2 + 1] = xr * s1 + xi * c1;
        }
        // ruído: bins de guarda fora da banda (o carving deixa só ruído/vazamento)
        let nz = 0, nn = 0;
        for (let g = 1; g <= GUARD; g++) {
          for (const k of [h.k0 - g - 1, h.k0 + rows + g]) {
            if (k > 0 && k < N / 2) { nz += (XR[k] * XR[k] + XI[k] * XI[k]) * 4 / (N * N); nn++; }
          }
        }
        noiseAcc[cc] = nn ? Math.sqrt(nz / nn) : 0;
      }
      if (onProgress && (c & 31) === 0) onProgress(c / nCols);
    }
    // canal por linha (média do preâmbulo, todos com amplitude 1, símbolo 0)
    const Hr = new Float64Array(rows), Hi = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      let sr = 0, si = 0;
      for (let c = 0; c < P; c++) { sr += Y[(c * rows + r) * 2]; si += Y[(c * rows + r) * 2 + 1]; }
      Hr[r] = sr / P; Hi[r] = si / P;
    }
    const Z = new Float32Array(h.cols * rows * 2);
    const colGain = new Float32Array(h.cols);
    let evm = 0;
    for (let x = 0; x < h.cols; x++) {
      const cc = x + P;
      const tmp = new Float64Array(rows * 2);
      for (let r = 0; r < rows; r++) {
        const yr = Y[(cc * rows + r) * 2], yi = Y[(cc * rows + r) * 2 + 1];
        const d = Hr[r] * Hr[r] + Hi[r] * Hi[r] || 1e-30;
        tmp[r * 2] = (yr * Hr[r] + yi * Hi[r]) / d;
        tmp[r * 2 + 1] = (yi * Hr[r] - yr * Hi[r]) / d;
      }
      // ganho complexo da coluna pelos pilotos (linhas 0 e rows−1)
      const gr = 0.5 * (tmp[0] + tmp[(rows - 1) * 2]), gi = 0.5 * (tmp[1] + tmp[(rows - 1) * 2 + 1]);
      const gd = gr * gr + gi * gi || 1e-30;
      colGain[x] = Math.sqrt(gd);
      const p0r = tmp[0], p0i = tmp[1], p1r = tmp[(rows - 1) * 2], p1i = tmp[(rows - 1) * 2 + 1];
      evm += (Math.hypot(p0r - p1r, p0i - p1i) ** 2) / (2 * gd);
      for (let r = 0; r < rows; r++) {
        const vr = tmp[r * 2], vi = tmp[r * 2 + 1];
        Z[(x * rows + r) * 2] = (vr * gr + vi * gi) / gd;
        Z[(x * rows + r) * 2 + 1] = (vi * gr - vr * gi) / gd;
      }
    }
    // ruído relativo (no domínio normalizado)
    let hMean = 0; for (let r = 0; r < rows; r++) hMean += Math.hypot(Hr[r], Hi[r]); hMean /= rows;
    const nArr = Array.from(noiseAcc.subarray(P)).sort((a, b) => a - b);
    let gMean = 0; for (let x = 0; x < h.cols; x++) gMean += colGain[x]; gMean /= h.cols;
    const noiseRel = (nArr[nArr.length >> 1] || 0) / (hMean * gMean || 1e-30);
    const pilotEvmRel = Math.sqrt(evm / h.cols);
    return { Z, S0, rows, cols: h.cols, noiseRel, pilotEvmRel, colGain };
  }

  /** Pré-filtro passa-banda: mantém [k0−4, k0+rows+3] (bins de N) — inclui os bins de guarda do ruído. */
  function bandIsolate(mono, fs, h, onProgress) {
    const df = fs / h.N;
    return SPX.encoder.carve([mono], fs, (h.k0 - 4) * df, (h.k0 + h.rows + 3) * df, 120, onProgress, 'keep')[0];
  }

  /** Converte a grade em imagem de luminância (Uint8, w×h). */
  function gridToLuma(grid, h) {
    const w = h.imgW, H = h.imgH, rpp = h.rpp, rows = h.rows;
    const out = new Uint8ClampedArray(w * H);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < H; y++) {
        let acc = 0;
        for (let j = 0; j < rpp; j++) {
          const r = 1 + (H - 1 - y) * rpp + j;
          const zr = grid.Z[(x * rows + r) * 2], zi = grid.Z[(x * rows + r) * 2 + 1];
          const p2 = zr * zr + zi * zi; // potência da célula (relativa ao piloto)
          acc += 1 + 10 * Math.log10(Math.max(p2, 1e-18)) / h.DR;
        }
        out[y * w + x] = Math.round(SPX.util.clamp(acc / rpp, 0, 1) * 255);
      }
    }
    return out;
  }

  /** Demodula a camada de dados e aplica RS. */
  function decodePayload(grid, h, onProgress) {
    const m = h.modBits, M = 1 << m;
    const blocks = h.payloadBlocks;
    if (!m || !blocks) return null;
    const rows = h.rows, dataRows = rows - 2, cells = dataRows * h.cols;
    const perm = SPX.util.permutation(cells, SPX.util.subSeed(h.seed, 'perm'));
    const nBytes = blocks * 255, nBits = nBytes * 8;
    const nSym = Math.ceil(nBits / m);
    const bits = new Uint8Array(nSym * m);
    const rel = new Float32Array(nSym); // confiabilidade (distância à fronteira de decisão / ruído)
    const sigma = Math.max(grid.noiseRel, 1e-6);
    const grayInv = new Uint8Array(M);
    for (let v = 0; v < M; v++) grayInv[(v ^ (v >> 1)) & (M - 1)] = v;
    for (let j = 0; j < nSym; j++) {
      const cell = perm[j], x = Math.floor(cell / dataRows), r = 1 + (cell % dataRows);
      const zr = grid.Z[(x * rows + r) * 2], zi = grid.Z[(x * rows + r) * 2 + 1];
      let ang = Math.atan2(zi, zr); if (ang < 0) ang += TWO_PI;
      const pos = ang * M / TWO_PI;
      const g = Math.round(pos) % M;
      const v = grayInv[g];
      for (let b = 0; b < m; b++) bits[j * m + b] = (v >> (m - 1 - b)) & 1;
      const amp = Math.hypot(zr, zi);
      // distância perpendicular até a fronteira de decisão mais próxima
      const frac = Math.abs(pos - Math.round(pos));            // 0 = centro do símbolo, 0.5 = fronteira
      const dist = amp * Math.sin((0.5 - frac) * TWO_PI / M);
      rel[j] = dist / sigma;
    }
    const stream = bitsToBytes(bits, 0, nBytes);
    const byteRel = new Float32Array(nBytes);
    for (let i = 0; i < nBytes; i++) {
      let mn = Infinity;
      const s0 = Math.floor(i * 8 / m), s1 = Math.floor((i * 8 + 7) / m);
      for (let s = s0; s <= s1; s++) if (rel[s] < mn) mn = rel[s];
      byteRel[i] = mn;
    }
    // whitening⁻¹
    const wr = SPX.util.prng(SPX.util.subSeed(h.seed, 'white'));
    for (let i = 0; i < nBytes; i++) stream[i] ^= (wr() * 256) | 0;
    // deinterleave + RS
    const k = 255 - h.nsym;
    const data = new Uint8Array(blocks * k);
    let corrected = 0, failed = 0, bitErrors = 0, erasuresUsed = 0;
    const blockStatus = new Uint8Array(blocks);
    const cw = new Uint8Array(255), cr = new Float32Array(255);
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 255; i++) { cw[i] = stream[i * blocks + b]; cr[i] = byteRel[i * blocks + b]; }
      let res = null;
      const order = Array.from({ length: 255 }, (_, i) => i).sort((a, c) => cr[a] - cr[c]);
      const weak = order.filter(i => cr[i] < 1.5);
      // NUNCA usar nsym rasuras: sem redundância restante o RS sempre "acha"
      // uma palavra válida (falsa correção). Mantém ≥ 8 símbolos de verificação.
      const maxEr = Math.max(0, h.nsym - 8);
      const attempts = [[], weak.slice(0, maxEr), weak.slice(0, maxEr >> 1), order.slice(0, maxEr >> 1)];
      for (const er of attempts) {
        try { res = SPX.rs.decode(cw, h.nsym, er); res.er = er.length; break; } catch (e) { res = null; }
      }
      if (res) {
        data.set(res.data, b * k);
        corrected += res.corrected; erasuresUsed += res.er;
        const fixed = SPX.rs.encode(res.data, h.nsym);
        for (let i = 0; i < 255; i++) bitErrors += SPX.util.popcount8(fixed[i] ^ cw[i]);
        blockStatus[b] = 1;
      } else {
        data.set(cw.subarray(0, k), b * k); failed++;
      }
      if (onProgress && (b & 15) === 0) onProgress(b / blocks);
    }
    return { data, blocks, corrected, failed, bitErrors, erasuresUsed, blockStatus, rawBits: blocks * 255 * 8 };
  }

  /** Lê o contêiner de arquivo. */
  function parseContainer(bytes) {
    try {
      const r = new SPX.util.ByteReader(bytes);
      const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
      if (magic !== 'SPXF') return { ok: false, error: 'Assinatura do contêiner inválida' };
      const flags = r.u8(), mime = r.str(), name = r.str(), origW = r.u16(), origH = r.u16();
      const len = r.u32(), crc = r.u32();
      if (len > bytes.length - r.pos) return { ok: false, error: 'Comprimento inválido', mime, name };
      const file = r.bytes(len);
      const crcOk = SPX.util.crc32(file) === crc;
      return { ok: crcOk, crcOk, flags, mime, name, origW, origH, file, crc };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** Decodificação completa. */
  function decode(channels, fs, progress) {
    const P = progress || (() => {});
    const t0 = Date.now();
    const mono = toMono(channels);
    P({ stage: 'locate', p: 0, msg: 'Procurando beacon…' });
    const loc = locate(mono, fs, { onProgress: p => P({ stage: 'locate', p }) });
    if (!loc) return { ok: false, error: 'Beacon SPv2 não encontrado (áudio sem marca, reamostrado ou muito degradado).', ms: Date.now() - t0 };
    const h = loc.header;
    const warn = [];
    if (h.fs !== fs) warn.push(`Taxa de amostragem do arquivo (${fs} Hz) difere da codificada (${h.fs} Hz).`);
    P({ stage: 'filter', p: 0, msg: 'Isolando a banda da imagem…' });
    const band = bandIsolate(mono, fs, h, p => P({ stage: 'filter', p }));
    P({ stage: 'grid', p: 0, msg: 'Lendo grade espectral…' });
    const grid = readGrid(band, loc, p => P({ stage: 'grid', p }));
    const luma = gridToLuma(grid, h);
    let payload = null, container = null;
    if (h.modBits && h.payloadBlocks) {
      P({ stage: 'ecc', p: 0, msg: 'Demodulando fase + Reed–Solomon…' });
      payload = decodePayload(grid, h, p => P({ stage: 'ecc', p }));
      container = parseContainer(payload.data);
    }
    // grade em dB para o visualizador (modo alinhado)
    const gridDb = new Float32Array(h.cols * h.rows);
    for (let i = 0; i < gridDb.length; i++) gridDb[i] = 20 * Math.log10(Math.hypot(grid.Z[i * 2], grid.Z[i * 2 + 1]) + 1e-9);
    return {
      ok: true, ms: Date.now() - t0, header: h, warn,
      loc: { B: loc.B, kb0: loc.kb0, coherence: loc.coherence, copy: loc.copy, S0: grid.S0 },
      luma, w: h.imgW, hgt: h.imgH,
      snrDb: -20 * Math.log10(Math.max(grid.noiseRel, 1e-9)),
      pilotEvmDb: 20 * Math.log10(Math.max(grid.pilotEvmRel, 1e-9)),
      payload: payload ? { blocks: payload.blocks, corrected: payload.corrected, failed: payload.failed, bitErrors: payload.bitErrors, rawBits: payload.rawBits, erasuresUsed: payload.erasuresUsed } : null,
      container, gridDb,
    };
  }

  SPX.decoder = { _demodBeacon: demodBeaconSymbol, decode, locate, readGrid, bandIsolate, gridToLuma, toMono, parseContainer };
});
