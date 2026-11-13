/* =====================================================================
 * SPECTRUM v2 — ui/media.js
 * Imagens (carregamento, luminância, payload), áudio (decodificação,
 * player com AnalyserNode) e métricas de fidelidade (PSNR/SSIM).
 * ===================================================================== */
(function () {
  'use strict';
  const SPX = window.SPX;

  // ---------------------------------------------------------------- imagens
  function blobToBytes(blob) { return blob.arrayBuffer().then(b => new Uint8Array(b)); }
  function canvasToBlob(c, type, q) { return new Promise(res => c.toBlob(res, type, q)); }
  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Imagem inválida')); i.src = src; });
  }

  async function imageFromFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type || 'image/*' }));
    try {
      const img = await loadImg(url);
      return { name: file.name, mime: file.type || guessMime(bytes), bytes, img, w: img.naturalWidth, h: img.naturalHeight, url };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }
  function guessMime(b) {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    return 'application/octet-stream';
  }

  /** Redimensionamento de alta qualidade (reduções sucessivas por 2). */
  function resample(src, sw, sh, w, h) {
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= w && ch / 2 >= h) {
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(cw / 2)); c.height = Math.max(1, Math.round(ch / 2));
      const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, c.width, c.height); cur = c; cw = c.width; ch = c.height;
    }
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const x = out.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, w, h);
    return out;
  }

  /** Luminância Y' (Rec.709 sobre valores sRGB) em [0,1], com auto-níveis opcional. */
  function imageToLuma(info, w, h, opt) {
    const c = resample(info.img, info.w, info.h, w, h);
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const Y = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) Y[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    if (opt && opt.autolevel) {
      const hist = new Uint32Array(256); for (const v of Y) hist[Math.round(v * 255)]++;
      const pct = (p) => { let a = 0; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= p * Y.length) return i / 255; } return 1; };
      const lo = pct(0.005), hi = pct(0.995);
      if (hi - lo > 0.05) for (let i = 0; i < Y.length; i++) Y[i] = Math.max(0, Math.min(1, (Y[i] - lo) / (hi - lo)));
    }
    if (opt && opt.invert) for (let i = 0; i < Y.length; i++) Y[i] = 1 - Y[i];
    return Y;
  }
  function lumaToCanvas(Y, w, h, canvas) {
    const c = canvas || document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'), img = x.createImageData(w, h);
    const isFloat = Y instanceof Float32Array || Y instanceof Float64Array; // [0,1] ou já em 0..255
    for (let i = 0; i < w * h; i++) { const v = isFloat ? Math.round(Y[i] * 255) : Y[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0);
    return c;
  }

  // ------------------------------------------------------ amostras geradas
  async function sample(name) {
    if (name === 'monalisa') {
      const s = window.SPX_SAMPLES.monalisa;
      const bytes = Uint8Array.from(atob(s.data.split(',')[1]), ch => ch.charCodeAt(0));
      const img = await loadImg(s.data);
      return { name: s.name, mime: s.mime, bytes, img, w: img.naturalWidth, h: img.naturalHeight, url: s.data };
    }
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    const mono = '"JetBrains Mono", ui-monospace, monospace';
    if (name === 'testcard') {
      c.width = 640; c.height = 480;
      x.fillStyle = '#000'; x.fillRect(0, 0, 640, 480);
      x.strokeStyle = '#555'; x.lineWidth = 1;
      for (let i = 0; i <= 640; i += 40) { x.beginPath(); x.moveTo(i + .5, 0); x.lineTo(i + .5, 480); x.stroke(); }
      for (let j = 0; j <= 480; j += 40) { x.beginPath(); x.moveTo(0, j + .5); x.lineTo(640, j + .5); x.stroke(); }
      const g = x.createLinearGradient(40, 0, 600, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      x.fillStyle = g; x.fillRect(40, 400, 560, 40);
      for (let i = 0; i < 8; i++) { x.fillStyle = `hsl(0,0%,${i * 100 / 7}%)`; x.fillRect(40 + i * 70, 40, 70, 40); }
      x.strokeStyle = '#fff'; x.lineWidth = 6; x.beginPath(); x.arc(320, 240, 150, 0, 2 * Math.PI); x.stroke();
      x.lineWidth = 2; x.beginPath(); x.moveTo(320, 90); x.lineTo(320, 390); x.moveTo(170, 240); x.lineTo(470, 240); x.stroke();
      for (let k = 0; k < 12; k++) { x.fillStyle = k % 2 ? '#fff' : '#000'; x.fillRect(470 + k * 10, 120, 10, 60); x.fillRect(470 + k * 5, 200, 5, 60); x.fillRect(470 + k * 3, 280, 3, 60); }
      x.fillStyle = '#fff'; x.font = `bold 46px ${mono}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('SPECTRUM', 320, 225); x.font = `22px ${mono}`; x.fillText('v2 // 640×480', 320, 268);
      x.font = `14px ${mono}`; x.textAlign = 'left'; x.fillText('1px  2px  5px', 470, 112);
    } else if (name === 'mask') {
      c.width = 560; c.height = 640;
      x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
      x.save(); x.translate(40, 40); x.scale(7.6, 7.6); x.translate(-4, -4);
      const p = (d) => new Path2D(d);
      x.fillStyle = '#e8e8e8'; x.fill(p('M13 17c0-6 8.5-10 19-10s19 4 19 10c0 15-4.5 31-19 40C17.5 48 13 32 13 17z'));
      x.strokeStyle = '#000'; x.lineCap = 'round'; x.lineWidth = 2.6;
      x.stroke(p('M19.5 25.5c3 -1.6 6.5 -.8 9 1.4M44.5 25.5c-3 -1.6 -6.5 -.8 -9 1.4'));
      x.lineWidth = 1.6; x.stroke(p('M21 39c3.5 2.6 7 -1 11 -1s7.5 3.6 11 1')); x.stroke(p('M32 43.5v6.5'));
      x.fillStyle = '#9a9a9a'; x.fill(p('M23 31c2 2 4 3 7 3M41 31c-2 2 -4 3 -7 3')); x.lineWidth = 0.9; x.strokeStyle = '#777';
      x.stroke(p('M22.5 17.5c3 -1.2 6 -1.2 8 0M41.5 17.5c-3 -1.2 -6 -1.2 -8 0'));
      x.restore();
      x.fillStyle = '#ccc'; x.font = `bold 28px ${mono}`; x.textAlign = 'center'; x.fillText('SOMOS SINAL', 280, 612);
    } else { // text
      c.width = 900; c.height = 240;
      x.fillStyle = '#000'; x.fillRect(0, 0, 900, 240);
      x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = `bold 64px ${mono}`; x.fillText('ESTÁ NO ESPECTRO', 450, 92);
      x.font = `26px ${mono}`; x.fillText('quem souber olhar, verá.', 450, 168);
      x.strokeStyle = '#fff'; x.lineWidth = 3; x.strokeRect(14, 14, 872, 212);
    }
    const blob = await canvasToBlob(c, 'image/png');
    const bytes = await blobToBytes(blob);
    const url = URL.createObjectURL(blob);
    const img = await loadImg(url);
    return { name: name + '.png', mime: 'image/png', bytes, img, w: c.width, h: c.height, url };
  }

  // ------------------------------------------------------------- payload
  function buildContainer(f) {
    const w = new SPX.util.ByteWriter(f.bytes.length + 128);
    w.u8(0x53).u8(0x50).u8(0x58).u8(0x46);           // 'SPXF'
    w.u8(f.reencoded ? 1 : 0).str(f.mime || '').str(f.name || '').u16(f.origW).u16(f.origH);
    w.u32(f.bytes.length).u32(SPX.util.crc32(f.bytes)).bytes(f.bytes);
    return w.out();
  }
  const OVERHEAD = (info) => 4 + 1 + 2 + new TextEncoder().encode(info.mime || '').length + new TextEncoder().encode(info.name || '').length + 4 + 8;

  /**
   * Escolhe o payload: original (se couber) ou recodificação WebP/JPEG com
   * busca binária de qualidade; reduz a resolução apenas se necessário.
   */
  async function preparePayload(info, capacity, mode, log) {
    if (mode === 'none' || capacity <= 0) return null;
    const ov = OVERHEAD(info) + 16;
    if (mode === 'auto' && info.bytes.length + ov <= capacity) {
      return { container: buildContainer({ ...info, origW: info.w, origH: info.h }), desc: `arquivo original bit-a-bit (${info.mime}, ${SPX.util.fmtBytes(info.bytes.length)})`, exact: true };
    }
    const budget = capacity - ov;
    if (budget < 300) return null;
    const webpOk = await canvasToBlob(Object.assign(document.createElement('canvas'), { width: 2, height: 2 }), 'image/webp', 0.8).then(b => b && b.type === 'image/webp');
    const type = webpOk ? 'image/webp' : 'image/jpeg';
    let scale = 1;
    for (let attempt = 0; attempt < 14; attempt++) {
      const w = Math.max(8, Math.round(info.w * scale)), h = Math.max(8, Math.round(info.h * scale));
      const c = resample(info.img, info.w, info.h, w, h);
      let lo = 0.05, hi = 0.98, best = null;
      for (let it = 0; it < 7; it++) {
        const q = (lo + hi) / 2;
        const b = await canvasToBlob(c, type, q);
        if (b.size <= budget) { best = { b, q }; lo = q; } else hi = q;
      }
      if (!best) { const b = await canvasToBlob(c, type, 0.05); if (b.size <= budget) best = { b, q: 0.05 }; }
      if (best && (best.q >= 0.45 || scale < 0.2)) {
        const bytes = await blobToBytes(best.b);
        const name = info.name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
        log && log(`payload: ${type} ${w}×${h} q=${best.q.toFixed(2)} → ${SPX.util.fmtBytes(bytes.length)}`);
        return { container: buildContainer({ name, mime: type, bytes, origW: info.w, origH: info.h, reencoded: true }),
          desc: `${type.split('/')[1].toUpperCase()} ${w}×${h} · qualidade ${(best.q * 100).toFixed(0)}% · ${SPX.util.fmtBytes(bytes.length)}`, exact: false };
      }
      scale *= 0.82;
    }
    return null;
  }

  // ------------------------------------------------------------ áudio
  let workerForWav = null;
  function setWorker(w) { workerForWav = w; }
  function isWav(b) { return b.byteLength > 12 && String.fromCharCode(...new Uint8Array(b, 0, 4)) === 'RIFF' && String.fromCharCode(...new Uint8Array(b, 8, 4)) === 'WAVE'; }

  /** Decodifica e reamostra para fs (hospedeiro). */
  async function decodeAudioTo(buf, fs) {
    const ctx = new OfflineAudioContext(1, 1, fs);
    const ab = await ctx.decodeAudioData(buf.slice(0));
    const ch = []; for (let i = 0; i < Math.min(2, ab.numberOfChannels); i++) ch.push(ab.getChannelData(i).slice());
    return { channels: ch, fs: ab.sampleRate, duration: ab.duration };
  }
  /** Leitura na taxa nativa (WAV) ou, se não-WAV, numa taxa candidata. */
  async function readAudio(buf, fallbackFs) {
    if (isWav(buf) && workerForWav) {
      const r = await workerForWav.call('parseWav', { buffer: buf.slice(0) });
      if (r) return { channels: r.channels, fs: r.fs, native: true, info: `WAV ${r.format === 'float' ? 'float' : 'PCM'} ${r.bits} bits` };
    }
    const r = await decodeAudioTo(buf, sniffFs(buf) || fallbackFs || 48000);
    return { channels: r.channels, fs: r.fs, native: false, info: 'decodificado pelo navegador @ ' + r.fs + ' Hz' };
  }
  /** Taxa nativa sem decodificar: WAV (fmt), FLAC (STREAMINFO) ou MP3 (1º quadro). */
  function sniffFs(buf) { return describeAudio(buf).fs; }
  /** Formato, taxa e profundidade do arquivo original (para manter o tamanho de saída semelhante). */
  function describeAudio(buf, name) {
    const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 20));
    const tag = String.fromCharCode(...b.subarray(0, 4)), ftyp = String.fromCharCode(...b.subarray(4, 8));
    const d = { fmt: 'other', fs: null, bits: null, float: false, bytes: buf.byteLength, kbps: 0 };
    if (isWav(buf)) {
      d.fmt = 'wav'; d.fs = wavFs(buf);
      const f = wavFmt(buf); if (f) { d.bits = f.bits; d.float = f.tag === 3 || (f.tag === 0xFFFE && f.sub === 3); }
    } else if (tag === 'fLaC') { d.fmt = 'flac'; d.fs = SPX.flac.sniffRate(b); d.bits = SPX.flac.sniffBits(b); }
    else if (tag === 'OggS') d.fmt = 'ogg';
    else if (ftyp === 'ftyp') d.fmt = 'm4a';
    else if (tag.charCodeAt(0) === 0x1A && tag.charCodeAt(1) === 0x45) d.fmt = 'webm';
    else { const r = SPX.mp3.sniffRate(b); if (r) { d.fmt = 'mp3'; d.fs = r; } }
    if (d.fmt === 'other' && name) d.fmt = (name.split('.').pop() || 'other').toLowerCase().slice(0, 5);
    return d;
  }
  function wavFmt(buf) {
    const v = new DataView(buf); let o = 12;
    while (o + 8 <= buf.byteLength) {
      const id = String.fromCharCode(...new Uint8Array(buf, o, 4)), size = v.getUint32(o + 4, true);
      if (id === 'fmt ') return { tag: v.getUint16(o + 8, true), bits: v.getUint16(o + 22, true), sub: size >= 40 ? v.getUint16(o + 32, true) : 0 };
      o += 8 + size + (size & 1);
    }
    return null;
  }
  function wavFs(buf) {
    if (!isWav(buf)) return null;
    const v = new DataView(buf); let o = 12;
    while (o + 8 <= buf.byteLength) { const id = String.fromCharCode(...new Uint8Array(buf, o, 4)), size = v.getUint32(o + 4, true); if (id === 'fmt ') return v.getUint32(o + 12, true); o += 8 + size + (size & 1); }
    return null;
  }

  /** Player com AudioContext na taxa do sinal (preserva ultrassom a 96 kHz). */
  class Player {
    constructor() { this.ctx = null; this.buf = null; this.src = null; this.offset = 0; this.startAt = 0; this.playing = false; this.vol = 0.6; this.listeners = new Set(); }
    _ensure(fs) {
      if (this.ctx && this.ctx.sampleRate === fs) return;
      if (this.ctx) this.ctx.close();
      try { this.ctx = new AudioContext({ sampleRate: fs }); } catch (e) { this.ctx = new AudioContext(); }
      this.analyser = this.ctx.createAnalyser(); this.analyser.smoothingTimeConstant = 0; this.analyser.fftSize = 8192;
      this.analyser.minDecibels = -160; this.analyser.maxDecibels = 0;
      this.gain = this.ctx.createGain(); this.gain.gain.value = this.vol;
      this.analyser.connect(this.gain); this.gain.connect(this.ctx.destination);
    }
    load(channels, fs) {
      this.stop();
      this._ensure(fs);
      const b = this.ctx.createBuffer(channels.length, channels[0].length, fs);
      channels.forEach((c, i) => b.copyToChannel(c, i));
      this.buf = b; this.offset = 0; this.emit();
    }
    get duration() { return this.buf ? this.buf.duration : 0; }
    get currentTime() { return this.playing ? Math.min(this.duration, this.ctx.currentTime - this.startAt) : this.offset; }
    play() {
      if (!this.buf) return;
      this.ctx.resume();
      if (this.offset >= this.duration - 0.01) this.offset = 0;
      const s = this.ctx.createBufferSource(); s.buffer = this.buf; s.connect(this.analyser);
      s.start(0, this.offset); this.startAt = this.ctx.currentTime - this.offset; this.src = s; this.playing = true;
      s.onended = () => { if (this.src === s && this.playing) { this.playing = false; this.offset = 0; this.emit(); } };
      this.emit();
    }
    pause() { if (!this.playing) return; this.offset = this.currentTime; this.playing = false; try { this.src.stop(); } catch (e) {} this.emit(); }
    stop() { if (this.src) { this.playing = false; try { this.src.stop(); } catch (e) {} } this.offset = 0; this.emit(); }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(t) { const was = this.playing; if (was) { this.playing = false; try { this.src.stop(); } catch (e) {} } this.offset = Math.max(0, Math.min(this.duration, t)); if (was) this.play(); else this.emit(); }
    setVolume(v) { this.vol = v; if (this.gain) this.gain.gain.value = v; }
    on(fn) { this.listeners.add(fn); }
    emit() { for (const f of this.listeners) f(this); }
  }

  // -------------------------------------------------------- métricas
  function psnr(a, b) {
    let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
    const mse = se / a.length; return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  }
  /** SSIM médio em janelas 8×8 (passo 4), luminância 8 bits. */
  function ssim(a, b, w, h) {
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let acc = 0, n = 0;
    for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0, mb = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * w + x + i; ma += a[k]; mb += b[k]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cv = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * w + x + i; const da = a[k] - ma, db = b[k] - mb; va += da * da; vb += db * db; cv += da * db; }
      va /= 63; vb /= 63; cv /= 63;
      acc += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
    }
    return n ? acc / n : 1;
  }

  SPX.media = { imageFromFile, sample, imageToLuma, lumaToCanvas, resample, preparePayload, buildContainer, decodeAudioTo, readAudio, wavFs, sniffFs, describeAudio, isWav, setWorker, Player, psnr, ssim, canvasToBlob };
})();
