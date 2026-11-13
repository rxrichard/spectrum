/* =====================================================================
 * SPECTRUM v2 — core/wav.js
 * Leitura/escrita WAV sem dependências.
 *  • Escrita: PCM 16 bits (com dither TPDF), PCM 24 bits, IEEE float 32.
 *  • Leitura: PCM 8/16/24/32, float 32/64, WAVE_FORMAT_EXTENSIBLE.
 * Ler WAV manualmente preserva a taxa de amostragem nativa — o
 * decodeAudioData do navegador reamostra para a taxa do contexto, o que
 * destruiria a ortogonalidade das células.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_wav(SPX) {
  'use strict';

  function encode(channels, fs, bits) {
    bits = bits || 24;
    const nCh = channels.length, n = channels[0].length;
    const isFloat = bits === 32, bps = bits / 8;
    const dataBytes = n * nCh * bps;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, isFloat ? 3 : 1, true); v.setUint16(22, nCh, true);
    v.setUint32(24, fs, true); v.setUint32(28, fs * nCh * bps, true);
    v.setUint16(32, nCh * bps, true); v.setUint16(34, bits, true);
    wstr(36, 'data'); v.setUint32(40, dataBytes, true);
    let o = 44;
    const rnd = SPX.util.prng(0xD17E);
    if (isFloat) {
      const f = new Float32Array(buf, 44, n * nCh);
      for (let i = 0, j = 0; i < n; i++) for (let c = 0; c < nCh; c++) f[j++] = channels[c][i];
    } else if (bits === 16) {
      const a = new Int16Array(buf, 44, n * nCh);
      for (let i = 0, j = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
        const d = (rnd() - rnd()); // dither TPDF ±1 LSB
        let s = Math.round(channels[c][i] * 32767 + d);
        a[j++] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      }
    } else { // 24 bits
      const u = new Uint8Array(buf);
      for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
        let s = Math.round(channels[c][i] * 8388607);
        s = s > 8388607 ? 8388607 : s < -8388608 ? -8388608 : s;
        u[o++] = s & 255; u[o++] = (s >> 8) & 255; u[o++] = (s >> 16) & 255;
      }
    }
    return buf;
  }

  function decode(buf) {
    const v = new DataView(buf);
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; };
    if (buf.byteLength < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
    let o = 12, fmt = null, data = null;
    while (o + 8 <= buf.byteLength) {
      const id = str(o, 4); let size = v.getUint32(o + 4, true);
      if (id === 'fmt ') {
        let tag = v.getUint16(o + 8, true);
        const nCh = v.getUint16(o + 10, true), fs = v.getUint32(o + 12, true), bits = v.getUint16(o + 22, true);
        if (tag === 0xFFFE && size >= 40) tag = v.getUint16(o + 32, true); // subformato EXTENSIBLE
        fmt = { tag, nCh, fs, bits };
      } else if (id === 'data') {
        if (o + 8 + size > buf.byteLength) size = buf.byteLength - o - 8;
        data = { off: o + 8, size };
      }
      o += 8 + size + (size & 1);
    }
    if (!fmt || !data) return null;
    const { tag, nCh, fs, bits } = fmt, bps = bits / 8;
    const n = Math.floor(data.size / (bps * nCh));
    const ch = []; for (let c = 0; c < nCh; c++) ch.push(new Float32Array(n));
    let p = data.off;
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
      let s;
      if (tag === 3) s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
      else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) { let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (x & 0x800000) x -= 0x1000000; s = x / 8388608; }
      else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
      else s = 0;
      ch[c][i] = s; p += bps;
    }
    return { channels: ch, fs, bits, format: tag === 3 ? 'float' : 'pcm' };
  }

  SPX.wav = { encode, decode };
});
