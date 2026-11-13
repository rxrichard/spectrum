/* =====================================================================
 * SPECTRUM v2 — core/util.js
 * CRC32, PRNG determinístico, permutações, leitura/escrita binária.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_util(SPX) {
  'use strict';

  // ---- CRC-32 (IEEE 802.3, polinômio refletido 0xEDB88320) ----------
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[i] = c >>> 0;
  }
  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- PRNG mulberry32: rápido, 32 bits, reprodutível por semente ----
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Mistura de semente com rótulo, para sub-fluxos independentes. */
  function subSeed(seed, label) {
    let h = (seed ^ 0x9E3779B9) >>> 0;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    return h;
  }

  /** Permutação Fisher–Yates de [0..n) determinística (interleaving). */
  function permutation(n, seed) {
    const p = new Uint32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const r = prng(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    return p;
  }

  // ---- Escrita/leitura binária little-endian -------------------------
  class ByteWriter {
    constructor(cap = 64) { this.buf = new Uint8Array(cap); this.len = 0; }
    _grow(n) {
      if (this.len + n <= this.buf.length) return;
      let c = this.buf.length * 2; while (c < this.len + n) c *= 2;
      const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.len)); this.buf = b;
    }
    u8(v) { this._grow(1); this.buf[this.len++] = v & 0xFF; return this; }
    u16(v) { this.u8(v); this.u8(v >>> 8); return this; }
    u24(v) { this.u16(v); this.u8(v >>> 16); return this; }
    u32(v) { this.u16(v); this.u16(v >>> 16); return this; }
    bytes(a) { this._grow(a.length); this.buf.set(a, this.len); this.len += a.length; return this; }
    str(s) { const e = new TextEncoder().encode(s); this.u8(Math.min(255, e.length)); this.bytes(e.subarray(0, 255)); return this; }
    out() { return this.buf.slice(0, this.len); }
  }
  class ByteReader {
    constructor(buf) { this.buf = buf; this.pos = 0; }
    need(n) { if (this.pos + n > this.buf.length) throw new Error('ByteReader: fim inesperado'); }
    u8() { this.need(1); return this.buf[this.pos++]; }
    u16() { return this.u8() | (this.u8() << 8); }
    u24() { return this.u16() | (this.u8() << 16); }
    u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
    bytes(n) { this.need(n); const b = this.buf.slice(this.pos, this.pos + n); this.pos += n; return b; }
    str() { const n = this.u8(); return new TextDecoder().decode(this.bytes(n)); }
  }

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function fmtTime(s) {
    if (!isFinite(s)) return '--:--';
    const m = Math.floor(s / 60), r = s - m * 60;
    return String(m).padStart(2, '0') + ':' + r.toFixed(2).padStart(5, '0');
  }
  function popcount8(x) { x = x - ((x >> 1) & 0x55); x = (x & 0x33) + ((x >> 2) & 0x33); return (x + (x >> 4)) & 0x0F; }

  SPX.util = { crc32, prng, subSeed, permutation, ByteWriter, ByteReader, clamp, nextPow2, fmtBytes, fmtTime, popcount8 };
});
