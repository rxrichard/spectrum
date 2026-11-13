/* =====================================================================
 * SPECTRUM v2 — core/flac.js
 * Codificador FLAC próprio (sem dependências), SEM PERDAS:
 * a extração bit-a-bit continua garantida, com arquivo ~40–60% do WAV.
 *
 *  • blocos fixos de 4096 amostras
 *  • estéreo: escolhe por quadro entre L/R, L/S, S/R e M/S
 *  • subquadros: CONSTANT, FIXED (preditores de ordem 0–4) ou VERBATIM
 *  • resíduo: Rice particionado (ordem de partição ótima 0–8),
 *    parâmetros de 4 bits (RICE) ou 5 bits (RICE2) quando necessário
 *  • CRC-8 no cabeçalho de quadro, CRC-16 no rodapé (spec FLAC)
 * O MD5 do STREAMINFO fica zerado ("desconhecido"), permitido pela spec.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_flac(SPX) {
  'use strict';

  // ---- escritor de bits MSB-first -------------------------------------
  class BitWriter {
    constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
    ensure(k) {
      if (this.pos + k <= this.buf.length) return;
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + k + 1024)); b.set(this.buf.subarray(0, this.pos)); this.buf = b;
    }
    bits(v, n) {
      if (n === 0) return;
      if (n > 24) { this.bits(v >> 16, n - 16); this.bits(v & 0xFFFF, 16); return; } // ex.: canal "side" de 25 bits
      this.acc = (this.acc << n) | (v & ((1 << n) - 1)); this.n += n;
      while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 255; }
      this.acc &= (1 << this.n) - 1;
    }
    bigBits(v, n) { // até 48 bits, v ≥ 0 (pode exceder 2^32)
      if (n > 24) { this.bits(Math.floor(v / 16777216), n - 24); n = 24; }
      this.bits(v % 16777216, n);
    }
    unary(q) { while (q >= 24) { this.bits(0, 24); q -= 24; } this.bits(1, q + 1); }
    align() { if (this.n) this.bits(0, 8 - this.n); }
  }

  // ---- CRCs -----------------------------------------------------------
  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; CRC8[i] = c;
    let d = i << 8; for (let k = 0; k < 8; k++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xFFFF : (d << 1) & 0xFFFF; CRC16[i] = d;
  }
  const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
  const crc16 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xFFFF) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

  const RATE_CODE = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

  // ---- preditores fixos ----------------------------------------------
  /** Calcula o resíduo de ordem `ord` em `res` (para i ≥ ord). */
  function fixedResidual(x, n, ord, res) {
    switch (ord) {
      case 0: for (let i = 0; i < n; i++) res[i] = x[i]; break;
      case 1: for (let i = 1; i < n; i++) res[i] = x[i] - x[i - 1]; break;
      case 2: for (let i = 2; i < n; i++) res[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: for (let i = 3; i < n; i++) res[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      case 4: for (let i = 4; i < n; i++) res[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
    }
  }
  /** Soma |resíduo| para as ordens 0–4 de uma vez (estimativa de custo). */
  function orderCosts(x, n) {
    const s = [0, 0, 0, 0, 0];
    let a = 0, b = 0, c = 0, d = 0; // diferenças anteriores
    for (let i = 0; i < n; i++) {
      const e0 = x[i];
      if (i >= 4) s[0] += Math.abs(e0);
      const e1 = i >= 1 ? e0 - x[i - 1] : 0;
      const e2 = i >= 2 ? e1 - a : 0;
      const e3 = i >= 3 ? e2 - b : 0;
      const e4 = i >= 4 ? e3 - c : 0;
      if (i >= 4) { s[1] += Math.abs(e1); s[2] += Math.abs(e2); s[3] += Math.abs(e3); s[4] += Math.abs(e4); }
      a = e1; b = e2; c = e3; d = e4;
    }
    void d;
    return s;
  }

  // ---- Rice particionado ----------------------------------------------
  const MAX_PO = 8;
  /** Escolhe ordem de partição e parâmetros; devolve {po, ks, bits, rice2}. */
  function planRice(u, n, ord) {
    // somas na partição mais fina possível
    let pmax = 0; while (pmax < MAX_PO && (n % (1 << (pmax + 1))) === 0 && (n >> (pmax + 1)) > ord) pmax++;
    let best = null;
    const fine = 1 << pmax, fl = n >> pmax;
    const sums = new Float64Array(fine);
    for (let p = 0; p < fine; p++) {
      const s0 = p === 0 ? ord : p * fl, s1 = (p + 1) * fl;
      let s = 0; for (let i = s0; i < s1; i++) s += u[i];
      sums[p] = s;
    }
    for (let po = pmax; po >= 0; po--) {
      const parts = 1 << po, merge = 1 << (pmax - po), pl = n >> po;
      const ks = new Uint8Array(parts);
      let bits = 0, rice2 = false;
      for (let p = 0; p < parts; p++) {
        let s = 0; for (let j = 0; j < merge; j++) s += sums[p * merge + j];
        const cnt = pl - (p === 0 ? ord : 0);
        let k = 0;
        if (cnt > 0 && s > cnt) { k = Math.floor(Math.log2(s / cnt)); }
        // refina k ±1 pelo custo estimado cnt·(k+1) + s/2^k
        let bk = k, bc = Infinity;
        for (let kk = Math.max(0, k - 1); kk <= Math.min(30, k + 1); kk++) {
          const c = cnt * (kk + 1) + Math.floor(s / Math.pow(2, kk));
          if (c < bc) { bc = c; bk = kk; }
        }
        ks[p] = bk; bits += bc; if (bk > 14) rice2 = true;
      }
      bits += parts * (rice2 ? 5 : 4) + 6;
      if (!best || bits < best.bits) best = { po, ks, bits, rice2 };
    }
    return best;
  }

  const zz = (r) => r >= 0 ? 2 * r : -2 * r - 1;

  /** Custo (bits) e plano de um subquadro. */
  function planSubframe(x, n, bps, tmp, u) {
    let allSame = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { allSame = false; break; }
    if (allSame) return { type: 'const', bits: 8 + bps };
    const costs = orderCosts(x, n);
    let ord = 0; for (let o = 1; o <= 4; o++) if (o < n && costs[o] < costs[ord]) ord = o;
    fixedResidual(x, n, ord, tmp);
    for (let i = ord; i < n; i++) u[i] = zz(tmp[i]);
    const rp = planRice(u, n, ord);
    const fixedBits = 8 + ord * bps + rp.bits;
    const verb = 8 + n * bps;
    if (verb <= fixedBits) return { type: 'verbatim', bits: verb };
    return { type: 'fixed', ord, rp, bits: fixedBits };
  }

  function writeSubframe(bw, x, n, bps, plan, tmp, u) {
    bw.ensure(n * 8 + 64);
    if (plan.type === 'const') { bw.bits(0, 1); bw.bits(0, 6); bw.bits(0, 1); bw.bits(x[0], bps); return; }
    if (plan.type === 'verbatim') { bw.bits(0, 1); bw.bits(1, 6); bw.bits(0, 1); for (let i = 0; i < n; i++) bw.bits(x[i], bps); return; }
    const { ord, rp } = plan;
    bw.bits(0, 1); bw.bits(0b001000 | ord, 6); bw.bits(0, 1);
    for (let i = 0; i < ord; i++) bw.bits(x[i], bps);
    fixedResidual(x, n, ord, tmp);
    for (let i = ord; i < n; i++) u[i] = zz(tmp[i]);
    bw.bits(rp.rice2 ? 1 : 0, 2); bw.bits(rp.po, 4);
    const parts = 1 << rp.po, pl = n >> rp.po, pbits = rp.rice2 ? 5 : 4;
    for (let p = 0; p < parts; p++) {
      const k = rp.ks[p]; bw.bits(k, pbits);
      const s0 = p === 0 ? ord : p * pl, s1 = (p + 1) * pl;
      const mask = k ? (1 << k) - 1 : 0;
      for (let i = s0; i < s1; i++) {
        const v = u[i];
        const q = k ? Math.floor(v / (1 << k)) : v;
        bw.unary(q);
        if (k) bw.bits(v & mask, k);
      }
    }
  }

  function utf8Num(bw, v) {
    if (v < 0x80) { bw.bits(v, 8); return; }
    let bytes = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
    const lead = [0, 0, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC][bytes];
    bw.bits(lead | (Math.floor(v / Math.pow(2, 6 * (bytes - 1))) & (0x7F >> bytes)), 8);
    for (let i = bytes - 2; i >= 0; i--) bw.bits(0x80 | (Math.floor(v / Math.pow(2, 6 * i)) & 0x3F), 8);
  }

  /** Quantiza Float32 → inteiros com dither TPDF (16 bits) ou arredondamento (24). */
  function quantize(ch, bps) {
    const q = bps === 24 ? 8388607 : 32767, lo = -q - 1;
    const r = SPX.util.prng(0xF1AC);
    const out = new Int32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let s = Math.round(ch[i] * q + (bps === 16 ? r() - r() : 0));
      out[i] = s > q ? q : s < lo ? lo : s;
    }
    return out;
  }

  /** channels: Float32Array[] → Uint8Array (.flac). bps: 16 | 24. */
  function encode(channels, fs, bps, onProgress) {
    bps = bps === 24 ? 24 : 16;
    const nCh = channels.length, total = channels[0].length, B = 4096;
    if (nCh > 8) throw new Error('FLAC: máx. 8 canais');
    const pcm = channels.map(c => quantize(c, bps));
    const bw = new BitWriter(Math.max(1 << 20, total * nCh * bps / 16));
    // ---- cabeçalho + STREAMINFO
    bw.bits(0x664C, 16); bw.bits(0x6143, 16);               // "fLaC"
    bw.bits(1, 1); bw.bits(0, 7); bw.bits(34, 24);          // último bloco de metadados, tipo 0, 34 bytes
    bw.bits(B, 16); bw.bits(B, 16); bw.bits(0, 24); bw.bits(0, 24);
    bw.bits(fs >>> 4, 16); bw.bits(fs & 15, 4);              // 20 bits de taxa
    bw.bits(nCh - 1, 3); bw.bits(bps - 1, 5);
    bw.bigBits(total, 36);
    for (let i = 0; i < 16; i++) bw.bits(0, 8);             // MD5 desconhecido
    // ---- quadros
    const tmp = new Int32Array(B), u = new Float64Array(B);
    const mid = new Int32Array(B), side = new Int32Array(B);
    const views = [];
    let frame = 0;
    for (let off = 0; off < total; off += B, frame++) {
      const n = Math.min(B, total - off);
      for (let c = 0; c < nCh; c++) views[c] = pcm[c].subarray(off, off + n);
      // escolha do arranjo estéreo
      let assign = nCh - 1, subs = views.map(v => [v, bps]);
      if (nCh === 2) {
        const L = views[0], R = views[1];
        for (let i = 0; i < n; i++) { side[i] = L[i] - R[i]; mid[i] = (L[i] + R[i]) >> 1; }
        const S = side.subarray(0, n), M = mid.subarray(0, n);
        const cL = planSubframe(L, n, bps, tmp, u).bits, cR = planSubframe(R, n, bps, tmp, u).bits;
        const cS = planSubframe(S, n, bps + 1, tmp, u).bits, cM = planSubframe(M, n, bps, tmp, u).bits;
        const opts = [[cL + cR, 1, [[L, bps], [R, bps]]], [cL + cS, 8, [[L, bps], [S, bps + 1]]], [cS + cR, 9, [[S, bps + 1], [R, bps]]], [cM + cS, 10, [[M, bps], [S, bps + 1]]]];
        opts.sort((a, b) => a[0] - b[0]);
        assign = opts[0][1]; subs = opts[0][2];
      }
      // cabeçalho do quadro
      bw.ensure(64 + n * nCh * 4);
      const start = bw.pos;
      bw.bits(0xFFF8, 16);
      const bsCode = n === B ? 12 : 7;
      bw.bits(bsCode, 4); bw.bits(RATE_CODE[fs] || 0, 4);
      bw.bits(assign, 4); bw.bits(bps === 24 ? 6 : 4, 3); bw.bits(0, 1);
      utf8Num(bw, frame);
      if (bsCode === 7) bw.bits(n - 1, 16);
      bw.bits(crc8(bw.buf, start, bw.pos), 8);
      // subquadros
      for (const [x, b] of subs) {
        const plan = planSubframe(x, n, b, tmp, u);
        writeSubframe(bw, x, n, b, plan, tmp, u);
      }
      bw.align();
      const c16 = crc16(bw.buf, start, bw.pos);
      bw.bits(c16, 16);
      if (onProgress && (frame & 31) === 0) onProgress(off / total);
    }
    return bw.buf.slice(0, bw.pos);
  }

  /** Taxa de amostragem a partir do STREAMINFO. */
  function sniffRate(bytes) {
    if (bytes.length < 42 || bytes[0] !== 0x66 || bytes[1] !== 0x4C || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;
    return (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  }
  function sniffBits(bytes) {
    if (!sniffRate(bytes)) return null;
    return (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1;
  }

  SPX.flac = { encode, sniffRate, sniffBits, _BitWriter: BitWriter };
});
