/* =====================================================================
 * SPECTRUM v2 — core/mp3.js
 * Exportação MP3 (MPEG-1/2 Layer III) via lamejs — port JS do LAME
 * (assets/js/vendor/lame.min.js, LGPL-3.0, https://lame.sourceforge.io).
 * O lamejs é carregado como script separado e injetado nos workers.
 *
 * ATENÇÃO: MP3 é com perdas. O LAME aplica um passa-baixa que depende
 * do bitrate (≈ 20 kHz a 320 kbps, ≈ 17 kHz a 128 kbps) e quantiza bins
 * fracos. A imagem visual sobrevive se a banda ficar abaixo do corte;
 * a camada de dados (fase) exige o perfil Robusto para sobreviver.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_mp3(SPX) {
  'use strict';
  const RATES = [32000, 44100, 48000, 16000, 22050, 24000, 8000, 11025, 12000];

  /** Corte aproximado do passa-baixa do LAME por bitrate (CBR, 44,1/48 kHz). */
  function lowpassHz(kbps) {
    return kbps >= 320 ? 20000 : kbps >= 256 ? 19700 : kbps >= 192 ? 18600 : kbps >= 160 ? 17500 : kbps >= 128 ? 17000 : 15000;
  }
  function supported(fs) { return RATES.indexOf(fs) >= 0; }

  /** channels: Float32Array[] (1 ou 2) → Uint8Array (stream MP3 CBR). */
  function encode(channels, fs, kbps, onProgress) {
    const L = self.lamejs;
    if (!L || !L.Mp3Encoder) throw new Error('lamejs não carregado');
    if (!supported(fs)) throw new Error(`MP3 não suporta ${fs} Hz (máx. 48 kHz)`);
    const nCh = Math.min(2, channels.length), n = channels[0].length;
    const enc = new L.Mp3Encoder(nCh, fs, kbps);
    const BLOCK = 1152 * 16;
    const a = new Int16Array(BLOCK), b = new Int16Array(BLOCK);
    const r = SPX.util.prng(0xD17E);
    const toI16 = (src, dst, off, len) => {
      for (let i = 0; i < len; i++) {
        const s = Math.round(src[off + i] * 32767 + (r() - r())); // dither TPDF
        dst[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      }
    };
    const parts = []; let total = 0;
    for (let off = 0; off < n; off += BLOCK) {
      const len = Math.min(BLOCK, n - off);
      toI16(channels[0], a, off, len);
      if (nCh > 1) toI16(channels[1], b, off, len);
      const out = nCh > 1 ? enc.encodeBuffer(a.subarray(0, len), b.subarray(0, len)) : enc.encodeBuffer(a.subarray(0, len));
      if (out.length) { parts.push(out); total += out.length; }
      if (onProgress && ((off / BLOCK) & 3) === 0) onProgress(off / n);
    }
    const tail = enc.flush(); if (tail.length) { parts.push(tail); total += tail.length; }
    const mp3 = new Uint8Array(total);
    let p = 0; for (const x of parts) { mp3.set(new Uint8Array(x.buffer, x.byteOffset, x.length), p); p += x.length; }
    return mp3;
  }

  /** Lê a taxa de amostragem do primeiro quadro MP3 (pula tag ID3v2). */
  function sniffRate(bytes) {
    let i = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) // 'ID3'
      i = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
    const table = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    for (const end = Math.min(bytes.length - 4, i + 65536); i < end; i++) {
      if (bytes[i] !== 0xFF || (bytes[i + 1] & 0xE0) !== 0xE0) continue;
      const ver = (bytes[i + 1] >> 3) & 3, layer = (bytes[i + 1] >> 1) & 3, sr = (bytes[i + 2] >> 2) & 3;
      if (ver === 1 || layer !== 1 || sr === 3) continue; // exige Layer III válido
      return table[ver][sr];
    }
    return null;
  }

  SPX.mp3 = { encode, supported, lowpassHz, sniffRate };
});
