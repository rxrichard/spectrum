/* =====================================================================
 * SPECTRUM v2 — ui/spectro-view.js
 * Componente de espectrograma.
 *
 *  MODO "full"  — análise completa: o worker calcula a STFT exatamente
 *                 para a janela visível (tempo × frequência) na resolução
 *                 de pixels do dispositivo. Contraste/brilho/gama/cores
 *                 são aplicados por LUT (instantâneo, sem recalcular).
 *                 Durante pan/zoom o último bitmap é reprojetado até a
 *                 nova renderização chegar.
 *  MODO "live"  — cascata em tempo real a partir de um AnalyserNode.
 *  "Congelar"   — trava a imagem (o áudio continua).
 * ===================================================================== */
(function () {
  'use strict';
  const SPX = window.SPX;
  const DB_MIN = -160, DB_SPAN = 160;

  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  const pow2near = (x) => Math.pow(2, Math.round(Math.log2(Math.max(64, x))));

  class SpectroView {
    constructor(el, opts) {
      this.el = el; this.opts = opts || {};
      this.worker = this.opts.worker;
      this.compact = !!this.opts.compact;
      this.M = this.compact ? { l: 44, r: 6, t: 6, b: 20 } : { l: 56, r: 10, t: 8, b: 24 };
      el.innerHTML = '';
      this.cImg = document.createElement('canvas');
      this.cOv = document.createElement('canvas');
      el.append(this.cImg, this.cOv);
      el.insertAdjacentHTML('beforeend', '<div class="busy">▮ CALCULANDO STFT…</div><div class="readout"></div><div class="frozen-tag">CONGELADO</div><div class="empty">' + (this.opts.emptyText || 'SEM SINAL') + '</div>');
      this.readout = el.querySelector('.readout');
      this.emptyEl = el.querySelector('.empty');
      this.bmp = document.createElement('canvas');
      this.live = document.createElement('canvas');
      this.params = { N: 'auto', window: 'hann', cmap: 'matrix', floor: -100, range: 60, gamma: 1, fscale: 'lin', aligned: false };
      this.mode = 'full'; this.frozen = false;
      this.key = null; this.fs = 48000; this.dur = 0;
      this.view = { t0: 0, t1: 1, f0: 0, f1: 24000 };
      this.grid = null; this.last = null; this.playhead = null; this.reqId = 0; this.timer = 0;
      this.overlayFn = null; // desenho extra (preview do plano)
      this._lutKey = ''; this._lut = null;
      this.onViewChange = null;
      this._bind();
      this._ro = new ResizeObserver(() => { this._resize(); });
      this._ro.observe(el);
      this._resize();
    }

    // ------------------------------------------------------------ dados
    async setAudio(channels, fs, label) {
      this.key = (this.opts.name || 'v') + ':' + (++SpectroView._seq);
      this.fs = fs; this.dur = channels[0].length / fs; this.grid = null; this.last = null;
      this.view = { t0: 0, t1: this.dur, f0: 0, f1: fs / 2 };
      this.label = label || '';
      this.emptyEl.style.display = 'none';
      const copy = channels.map(c => new Float32Array(c));
      await this.worker.call('setAudio', { key: this.key, channels: copy, fs }, copy.map(c => c.buffer));
      this._emitView();
      this.requestRender(0);
    }
    clear(text) {
      this.key = null; this.last = null; this.grid = null; this.dur = 0;
      this.emptyEl.textContent = text || this.opts.emptyText || 'SEM SINAL'; this.emptyEl.style.display = '';
      this._drawImg(); this._drawOverlay();
    }
    /** Detecta SPv2 no áudio carregado (necessário para enquadrar/grade alinhada). */
    async analyzeGrid() {
      if (!this.key) return null;
      this.el.classList.add('loading');
      try {
        const r = await this.worker.call('analyzeGrid', { key: this.key });
        this.grid = r;
        return r;
      } finally { this.el.classList.remove('loading'); }
    }

    // ------------------------------------------------------- parâmetros
    set(p) {
      const needRender = ['N', 'window', 'fscale', 'aligned'].some(k => k in p && p[k] !== this.params[k]);
      Object.assign(this.params, p);
      if (needRender) this.requestRender(); else { this._paintBitmap(); this._drawImg(); }
      if (this.mode === 'live' && this.player) this._setupAnalyser();
    }
    effectiveN() {
      if (this.params.N !== 'auto') return +this.params.N;
      const h = this.grid && this.grid.header;
      if (h) {
        // compromisso tempo×frequência ajustado à célula da imagem:
        // resolução de linha ≈ 2N/rpp, janela ≤ ~1,5 coluna
        const nf = 2 * h.N / h.rpp, nt = 1.5 * h.L;
        return Math.min(32768, pow2near(Math.sqrt(nf * nt)));
      }
      return Math.min(32768, pow2near(4096 * this.fs / 48000));
    }

    // ------------------------------------------------------------ vista
    setView(v, silent) {
      const fsH = this.fs / 2;
      let { t0, t1, f0, f1 } = Object.assign({}, this.view, v);
      const minT = Math.max(0.002, 64 / this.fs), minF = 20;
      if (t1 - t0 < minT) { const c = (t0 + t1) / 2; t0 = c - minT / 2; t1 = c + minT / 2; }
      if (f1 - f0 < minF) { const c = (f0 + f1) / 2; f0 = c - minF / 2; f1 = c + minF / 2; }
      const allowOut = v && v._allowOut; // enquadramento pode passar dos limites (letterbox)
      if (!allowOut) {
        if (t1 - t0 > this.dur) { t0 = 0; t1 = this.dur; }
        if (t0 < 0) { t1 -= t0; t0 = 0; } if (t1 > this.dur) { t0 -= t1 - this.dur; t1 = this.dur; }
        if (f1 - f0 > fsH) { f0 = 0; f1 = fsH; }
        if (f0 < 0) { f1 -= f0; f0 = 0; } if (f1 > fsH) { f0 -= f1 - fsH; f1 = fsH; }
      }
      this.view = { t0, t1, f0, f1 };
      this._drawImg(); this._drawOverlay();
      if (!silent) this.requestRender();
      this._emitView();
    }
    resetView() { this.setView({ t0: 0, t1: this.dur, f0: 0, f1: this.fs / 2 }); }
    _emitView() { this.onViewChange && this.onViewChange(this.view, this); }

    /** Enquadra a região SPv2 com a proporção correta da imagem (letterbox). */
    fitImage() {
      const g = this.grid; if (!g) return false;
      const h = g.header, P = SPX.layout.PROTO.PREAMBLE_COLS, df = this.fs / h.N;
      let t0 = (g.S0 + P * h.L) / this.fs, t1 = (g.S0 + (P + h.cols) * h.L) / this.fs;
      let f0 = (h.k0 + 0.5) * df, f1 = (h.k0 + h.rows - 1.5) * df;
      const { W, H } = this._plotSize();
      const A = h.imgW / h.imgH, Ap = W / H;
      if (Ap > A) { const s = (t1 - t0) * Ap / A, c = (t0 + t1) / 2; t0 = c - s / 2; t1 = c + s / 2; }
      else { const s = (f1 - f0) * A / Ap, c = (f0 + f1) / 2; f0 = c - s / 2; f1 = c + s / 2; }
      this.setView({ t0, t1, f0, f1, _allowOut: true });
      return true;
    }

    // ---------------------------------------------------------- render
    _plotSize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.el.getBoundingClientRect();
      const W = Math.max(8, Math.round((r.width - this.M.l - this.M.r) * dpr));
      const H = Math.max(8, Math.round((r.height - this.M.t - this.M.b) * dpr));
      return { W, H, dpr, cw: r.width, ch: r.height };
    }
    _resize() {
      const { dpr, cw, ch } = this._plotSize();
      for (const c of [this.cImg, this.cOv]) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      this._drawImg(); this._drawOverlay();
      this.requestRender(150);
    }
    requestRender(delay) {
      if (!this.key || this.mode !== 'full' || this.frozen) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._render(), delay == null ? 90 : delay);
    }
    async _render() {
      const id = ++this.reqId;
      const { W, H } = this._plotSize();
      const N = this.effectiveN();
      const v = Object.assign({}, this.view);
      const t0 = Math.max(0, v.t0), t1 = Math.min(this.dur, v.t1);
      const f0 = Math.max(0, v.f0), f1 = Math.min(this.fs / 2, v.f1);
      if (t1 <= t0 || f1 <= f0) return;
      // sub-região válida em pixels (letterbox fora do sinal fica preto)
      const x0 = Math.floor((t0 - v.t0) / (v.t1 - v.t0) * W), x1 = Math.ceil((t1 - v.t0) / (v.t1 - v.t0) * W);
      const y0 = Math.floor((v.f1 - f1) / (v.f1 - v.f0) * H), y1 = Math.ceil((v.f1 - f0) / (v.f1 - v.f0) * H);
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const binsInView = (f1 - f0) / (this.fs / N);
      const zp = binsInView < h ? Math.min(8, Math.pow(2, Math.ceil(Math.log2(h / binsInView)))) : 1;
      this.el.classList.add('loading');
      try {
        const r = await this.worker.call('spectrogram', { key: this.key, q: { t0, t1, f0, f1, width: w, height: h, N, zp, window: this.params.window, freqScale: this.params.fscale, aligned: this.params.aligned } });
        if (id !== this.reqId) return;
        this.last = { data: r.data, w: r.width, h: r.height, view: { t0, t1, f0, f1 }, stats: r, N };
        this.stats = r;
        this._paintBitmap(); this._drawImg(); this._drawOverlay();
        this.onRendered && this.onRendered(r);
      } catch (e) { if (id === this.reqId) console.warn(e); }
      finally { if (id === this.reqId) this.el.classList.remove('loading'); }
    }
    lut() {
      const p = this.params, k = [p.cmap, p.floor, p.range, p.gamma].join('|');
      if (k === this._lutKey) return this._lut;
      const map = SPX.colormaps.MAPS[p.cmap] || SPX.colormaps.MAPS.matrix;
      const L = new Uint8Array(256 * 3);
      for (let v = 0; v < 256; v++) {
        const dB = v * DB_SPAN / 255 + DB_MIN;
        let n = (dB - p.floor) / p.range; n = n < 0 ? 0 : n > 1 ? 1 : n; n = Math.pow(n, p.gamma);
        const i = Math.round(n * 255);
        L[v * 3] = map[i * 3]; L[v * 3 + 1] = map[i * 3 + 1]; L[v * 3 + 2] = map[i * 3 + 2];
      }
      this._lutKey = k; this._lut = L;
      return L;
    }
    _paintBitmap() {
      if (!this.last) return;
      const { data, w, h } = this.last, L = this.lut();
      this.bmp.width = w; this.bmp.height = h;
      const ctx = this.bmp.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
      for (let i = 0; i < w * h; i++) { const v = data[i] * 3; d[i * 4] = L[v]; d[i * 4 + 1] = L[v + 1]; d[i * 4 + 2] = L[v + 2]; d[i * 4 + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }
    _drawImg() {
      const c = this.cImg, ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      const px = this.M.l * dpr, py = this.M.t * dpr, W = c.width - (this.M.l + this.M.r) * dpr, H = c.height - (this.M.t + this.M.b) * dpr;
      if (this.mode === 'live') { if (this.live.width) { ctx.imageSmoothingEnabled = false; ctx.drawImage(this.live, px, py, W, H); } return; }
      if (!this.last) { this.overlayFn && this._clip(ctx, px, py, W, H, () => this.overlayFn(ctx, px, py, W, H, this)); return; }
      // reprojeta o último bitmap (feedback imediato em pan/zoom)
      const a = this.last.view, v = this.view;
      const X = (t) => px + (t - v.t0) / (v.t1 - v.t0) * W;
      const Y = (f) => py + (v.f1 - f) / (v.f1 - v.f0) * H;
      ctx.save(); ctx.beginPath(); ctx.rect(px, py, W, H); ctx.clip();
      ctx.imageSmoothingEnabled = this.params.fscale === 'lin';
      ctx.imageSmoothingQuality = 'high';
      if (this.params.fscale === 'lin' || (a.f0 === v.f0 && a.f1 === v.f1)) ctx.drawImage(this.bmp, X(a.t0), Y(a.f1), X(a.t1) - X(a.t0), Y(a.f0) - Y(a.f1));
      ctx.restore();
    }
    _clip(ctx, x, y, w, h, fn) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); fn(); ctx.restore(); }

    _drawOverlay() {
      const c = this.cOv, ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cw = c.width / dpr, ch = c.height / dpr;
      ctx.clearRect(0, 0, cw, ch);
      const { l, r, t, b } = this.M, W = cw - l - r, H = ch - t - b;
      ctx.strokeStyle = 'rgba(0,255,65,.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(l - .5, t - .5, W + 1, H + 1);
      ctx.font = (this.compact ? 9.5 : 10.5) + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = '#6f7d6e'; ctx.textBaseline = 'middle';
      const v = this.view;
      // eixo de frequência
      const logF = this.params.fscale === 'log' && this.mode === 'full';
      const fy = (f) => {
        if (!logF) return t + (v.f1 - f) / (v.f1 - v.f0) * H;
        const a = Math.log(Math.max(v.f0, 10)), bb = Math.log(Math.max(v.f1, 20));
        return t + (bb - Math.log(Math.max(f, 1))) / (bb - a) * H;
      };
      ctx.textAlign = 'right';
      const fTicks = [];
      if (logF) { for (const d of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000]) if (d >= v.f0 && d <= v.f1) fTicks.push(d); }
      else { const st = niceStep(v.f1 - v.f0, this.compact ? 4 : 8); for (let f = Math.ceil(v.f0 / st) * st; f <= v.f1 + 1e-6; f += st) fTicks.push(f); }
      for (const f of fTicks) {
        const y = fy(f); if (y < t - 1 || y > t + H + 1) continue;
        ctx.fillStyle = 'rgba(0,255,65,.08)'; ctx.fillRect(l, Math.round(y), W, 1);
        ctx.fillStyle = '#6f7d6e'; ctx.fillText(f >= 1000 ? (f / 1000).toFixed(f % 1000 ? (f % 100 ? 2 : 1) : 0) + 'k' : Math.round(f) + '', l - 6, y);
      }
      ctx.save(); ctx.translate(11, t + H / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#3c463b'; ctx.fillText('Hz', 0, 0); ctx.restore();
      // eixo do tempo
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      if (this.mode === 'live') {
        ctx.fillStyle = '#6f7d6e'; ctx.fillText('← passado', l + 40, t + H + 5); ctx.fillStyle = '#00ff41'; ctx.fillText('agora ●', l + W - 34, t + H + 5);
      } else {
        const st = niceStep(v.t1 - v.t0, this.compact ? 5 : 10);
        for (let s = Math.ceil(v.t0 / st) * st; s <= v.t1 + 1e-9; s += st) {
          const x = l + (s - v.t0) / (v.t1 - v.t0) * W;
          ctx.fillStyle = 'rgba(0,255,65,.06)'; ctx.fillRect(Math.round(x), t, 1, H);
          ctx.fillStyle = '#6f7d6e'; ctx.fillText(st < 0.1 ? s.toFixed(3) : st < 1 ? s.toFixed(2) : s.toFixed(st % 1 ? 1 : 0) + 's', x, t + H + 5);
        }
        // região da grade detectada
        if (this.grid && !this.compact) {
          const g = this.grid, h = g.header, P = SPX.layout.PROTO.PREAMBLE_COLS, df = this.fs / h.N;
          const xa = l + ((g.S0 + P * h.L) / this.fs - v.t0) / (v.t1 - v.t0) * W, xb = l + ((g.S0 + (P + h.cols) * h.L) / this.fs - v.t0) / (v.t1 - v.t0) * W;
          const ya = fy((h.k0 + h.rows - 1) * df), yb = fy(h.k0 * df);
          ctx.save(); ctx.beginPath(); ctx.rect(l, t, W, H); ctx.clip();
          ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(184,255,60,.45)'; ctx.strokeRect(xa, ya, xb - xa, yb - ya); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(184,255,60,.8)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText(`SPv2 ${h.imgW}×${h.imgH}`, Math.max(l + 4, xa + 4), Math.max(t + 12, ya - 3));
          ctx.restore();
        }
        if (this.playhead != null && this.playhead >= v.t0 && this.playhead <= v.t1) {
          const x = l + (this.playhead - v.t0) / (v.t1 - v.t0) * W;
          ctx.fillStyle = 'rgba(0,255,65,.9)'; ctx.fillRect(Math.round(x), t, 1, H);
          ctx.fillStyle = 'rgba(0,255,65,.12)'; ctx.fillRect(Math.round(x) - 3, t, 7, H);
        }
      }
      if (this.label && !this.compact) { ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(230,232,223,.55)'; ctx.fillText(this.label, l + W - 6, t + 6); }
    }
    setPlayhead(tSec) { this.playhead = tSec; if (this.mode === 'full') this._drawOverlay(); }

    // ------------------------------------------------------ interação
    _bind() {
      const el = this.el;
      const toLocal = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left - this.M.l, y: e.clientY - r.top - this.M.t, W: r.width - this.M.l - this.M.r, H: r.height - this.M.t - this.M.b }; };
      el.addEventListener('wheel', (e) => {
        if (!this.key || this.mode !== 'full') return;
        e.preventDefault();
        const p = toLocal(e), v = this.view, k = Math.exp(Math.sign(e.deltaY) * Math.min(0.5, Math.abs(e.deltaY) / 300));
        if (e.shiftKey || e.altKey) {
          const fc = v.f1 - (p.y / p.H) * (v.f1 - v.f0);
          this.setView({ f0: fc - (fc - v.f0) * k, f1: fc + (v.f1 - fc) * k });
        } else {
          const tc = v.t0 + (p.x / p.W) * (v.t1 - v.t0);
          this.setView({ t0: tc - (tc - v.t0) * k, t1: tc + (v.t1 - tc) * k });
        }
      }, { passive: false });
      let drag = null;
      el.addEventListener('pointerdown', (e) => {
        if (!this.key || this.mode !== 'full') return;
        el.setPointerCapture(e.pointerId); drag = { p: toLocal(e), v: Object.assign({}, this.view), moved: false };
      });
      el.addEventListener('pointermove', (e) => {
        const p = toLocal(e);
        if (drag) {
          const dx = (p.x - drag.p.x) / p.W * (drag.v.t1 - drag.v.t0), dy = (p.y - drag.p.y) / p.H * (drag.v.f1 - drag.v.f0);
          if (Math.abs(p.x - drag.p.x) + Math.abs(p.y - drag.p.y) > 3) drag.moved = true;
          if (drag.moved) this.setView({ t0: drag.v.t0 - dx, t1: drag.v.t1 - dx, f0: drag.v.f0 + dy, f1: drag.v.f1 + dy });
        }
        this._readout(p);
      });
      el.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved && this.onClickTime && this.mode === 'full') { const p = drag.p; this.onClickTime(this.view.t0 + p.x / p.W * (this.view.t1 - this.view.t0)); }
        drag = null;
      });
      el.addEventListener('dblclick', () => { if (this.key) this.resetView(); });
    }
    _readout(p) {
      if (!this.key || p.x < 0 || p.y < 0 || p.x > p.W || p.y > p.H) { this.readout.textContent = ''; return; }
      const v = this.view;
      if (this.mode === 'live') { const f = v.f1 - p.y / p.H * (v.f1 - v.f0); this.readout.textContent = `f ${(f / 1000).toFixed(3)} kHz`; return; }
      const tt = v.t0 + p.x / p.W * (v.t1 - v.t0);
      let f;
      if (this.params.fscale === 'log') { const a = Math.log(Math.max(v.f0, 10)), b = Math.log(Math.max(v.f1, 20)); f = Math.exp(b - p.y / p.H * (b - a)); }
      else f = v.f1 - p.y / p.H * (v.f1 - v.f0);
      let db = '';
      const L = this.last;
      if (L) {
        const x = Math.floor((tt - L.view.t0) / (L.view.t1 - L.view.t0) * L.w), y = Math.floor((L.view.f1 - f) / (L.view.f1 - L.view.f0) * L.h);
        if (x >= 0 && y >= 0 && x < L.w && y < L.h) db = ' · ' + (L.data[y * L.w + x] * DB_SPAN / 255 + DB_MIN).toFixed(1) + ' dB';
      }
      this.readout.textContent = `t ${tt.toFixed(3)} s · f ${(f / 1000).toFixed(3)} kHz${db}`;
    }

    // ------------------------------------------------------- tempo real
    setMode(mode, player) {
      this.mode = mode; this.player = player || this.player;
      cancelAnimationFrame(this._raf);
      if (mode === 'live') {
        const { W, H } = this._plotSize();
        this.live.width = W; this.live.height = H;
        const x = this.live.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
        this._lastT = null; this._acc = 0;
        this._setupAnalyser();
        const loop = () => { this._liveStep(); this._raf = requestAnimationFrame(loop); };
        this._raf = requestAnimationFrame(loop);
      } else this.requestRender(0);
      this._drawImg(); this._drawOverlay();
    }
    _setupAnalyser() {
      const an = this.player && this.player.analyser; if (!an) return;
      let N = this.params.N === 'auto' ? this.effectiveN() : +this.params.N;
      an.fftSize = Math.max(32, Math.min(32768, N));
      this._fbuf = new Float32Array(an.frequencyBinCount);
    }
    _liveStep() {
      const pl = this.player; if (!pl || !pl.analyser || this.frozen || !pl.playing) return;
      const an = pl.analyser; if (!this._fbuf || this._fbuf.length !== an.frequencyBinCount) this._setupAnalyser();
      an.getFloatFrequencyData(this._fbuf);
      const W = this.live.width, H = this.live.height, ctx = this.live.getContext('2d');
      // rolagem atrelada ao relógio do áudio: a duração inteira cabe na largura,
      // então a imagem se forma completa e na proporção certa durante a reprodução
      const now = pl.currentTime, pxPerSec = W / Math.max(1, pl.duration);
      if (this._lastT == null || now < this._lastT) this._lastT = now;
      this._acc = (this._acc || 0) + (now - this._lastT) * pxPerSec; this._lastT = now;
      const step = Math.floor(this._acc);
      if (step < 1) return;
      this._acc -= step;
      ctx.drawImage(this.live, step, 0, W - step, H, 0, 0, W - step, H);
      const col = ctx.createImageData(step, H), d = col.data, L = this.lut();
      const fsr = pl.ctx.sampleRate, nb = this._fbuf.length, df = fsr / 2 / nb, v = this.view;
      // AnalyserNode aplica Blackman e normaliza por N; compensa o ganho coerente (~0,42) → dBFS de senoide
      const corr = 20 * Math.log10(2 / 0.42);
      for (let y = 0; y < H; y++) {
        const fa = v.f1 - (y + 1) / H * (v.f1 - v.f0), fb = v.f1 - y / H * (v.f1 - v.f0);
        let ka = Math.floor(fa / df), kb = Math.ceil(fb / df), m = -Infinity;
        for (let k = Math.max(0, ka); k <= Math.min(nb - 1, kb); k++) if (this._fbuf[k] > m) m = this._fbuf[k];
        const dB = m + corr - 6;
        const v8 = Math.max(0, Math.min(255, Math.round((dB - DB_MIN) * 255 / DB_SPAN))) * 3;
        for (let s = 0; s < step; s++) { const o = (y * step + s) * 4; d[o] = L[v8]; d[o + 1] = L[v8 + 1]; d[o + 2] = L[v8 + 2]; d[o + 3] = 255; }
      }
      ctx.putImageData(col, W - step, 0);
      this._drawImg();
    }

    setFrozen(f) { this.frozen = f; this.el.classList.toggle('frozen', f); if (!f) this.requestRender(0); }

    // ---------------------------------------------------------- export
    async exportPNG(name) {
      const c = document.createElement('canvas'); c.width = this.cImg.width; c.height = this.cImg.height;
      const x = c.getContext('2d'); x.drawImage(this.cImg, 0, 0); x.drawImage(this.cOv, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      x.font = `${10 * dpr}px "JetBrains Mono", monospace`; x.fillStyle = 'rgba(0,255,65,.7)'; x.textAlign = 'left'; x.textBaseline = 'bottom';
      x.fillText(`SPECTRUM v2 · ${this.fs} Hz · N=${this.effectiveN()} · ${this.params.window} · ${this.params.cmap}`, (this.M.l + 6) * dpr, c.height - (this.M.b + 4) * dpr);
      const blob = await SPX.media.canvasToBlob(c, 'image/png');
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'espectro.png'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  }
  SpectroView._seq = 0;
  SPX.SpectroView = SpectroView;
})();
