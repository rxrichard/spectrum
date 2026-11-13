/* =====================================================================
 * SPECTRUM v2 — worker-bridge.js
 * Cria Web Workers a partir das funções-módulo já carregadas na página
 * (fn.toString() → Blob URL). Funciona em file:// sem servidor.
 * Protocolo: {id, cmd, args} → {id, type:'progress'|'result'|'error', data}
 * ===================================================================== */
(function () {
  'use strict';

  /** Corpo do worker (serializado; NÃO usa nada do escopo externo). */
  function SPX_WORKER_MAIN(SPX) {
    const store = new Map(); // áudio residente para o visualizador: id → {mono, fs, grid}
    const post = (id, type, data, transfer) => self.postMessage({ id, type, data }, transfer || []);

    const handlers = {
      encode(a, prog) {
        const r = SPX.encoder.encode(a, prog);
        return { value: r, transfer: r.channels.map(c => c.buffer) };
      },
      decode(a, prog) {
        const r = SPX.decoder.decode(a.channels, a.fs, prog);
        const tr = [];
        if (r.luma) tr.push(r.luma.buffer);
        if (r.gridDb) tr.push(r.gridDb.buffer);
        if (r.container && r.container.file) tr.push(r.container.file.buffer);
        return { value: r, transfer: tr };
      },
      mp3(a, prog) {
        const out = SPX.mp3.encode(a.channels, a.fs, a.kbps, (p) => prog({ p }));
        return { value: out, transfer: [out.buffer] };
      },
      flac(a, prog) {
        const out = SPX.flac.encode(a.channels, a.fs, a.bits, (p) => prog({ p }));
        return { value: out, transfer: [out.buffer] };
      },
      wav(a) {
        const buf = SPX.wav.encode(a.channels, a.fs, a.bits);
        return { value: buf, transfer: [buf] };
      },
      parseWav(a) {
        const r = SPX.wav.decode(a.buffer);
        return { value: r, transfer: r ? r.channels.map(c => c.buffer) : [] };
      },
      demoHost(a) {
        const ch = SPX.lab.demoHost(a.fs, a.seconds);
        return { value: ch, transfer: ch.map(c => c.buffer) };
      },
      setAudio(a) {
        const mono = SPX.decoder.toMono(a.channels);
        store.set(a.key, { mono, fs: a.fs, grid: null });
        return { value: { key: a.key, samples: mono.length } };
      },
      /** Detecta SPv2 e lê a matriz de células (modo "grade alinhada"). */
      analyzeGrid(a, prog) {
        const s = store.get(a.key); if (!s) throw new Error('Áudio não carregado');
        const loc = SPX.decoder.locate(s.mono, s.fs, { onProgress: p => prog({ stage: 'locate', p }) });
        if (!loc) { s.grid = null; return { value: null }; }
        const band = SPX.decoder.bandIsolate(s.mono, s.fs, loc.header);
        const g = SPX.decoder.readGrid(band, loc);
        const h = loc.header;
        const gridDb = new Float32Array(h.cols * h.rows);
        for (let i = 0; i < gridDb.length; i++) gridDb[i] = 20 * Math.log10(Math.hypot(g.Z[i * 2], g.Z[i * 2 + 1]) + 1e-9);
        s.grid = { header: h, S0: g.S0, gridDb };
        return { value: { header: h, S0: g.S0, B: loc.B, kb0: loc.kb0, snrDb: -20 * Math.log10(Math.max(g.noiseRel, 1e-9)) } };
      },
      spectrogram(a, prog) {
        const s = store.get(a.key); if (!s) throw new Error('Áudio não carregado');
        const q = Object.assign({}, a.q, { grid: s.grid, onProgress: (p) => prog({ p }) });
        const r = SPX.stft.spectrogram(s.mono, s.fs, q);
        return { value: r, transfer: [r.data.buffer] };
      },
      lab(a, prog) {
        const T = SPX.lab.TESTS[a.test];
        if (!T) throw new Error('Teste desconhecido');
        prog({ stage: 'degrade', msg: T.label });
        const deg = T.run(a.channels, a.fs);
        const r = SPX.decoder.decode(deg, a.fs, prog);
        const out = { test: a.test, label: T.label, ok: r.ok, error: r.error, snrDb: r.snrDb, payload: r.payload,
          containerOk: !!(r.container && r.container.ok), luma: r.luma, w: r.w, h: r.hgt, ms: r.ms };
        return { value: out, transfer: r.luma ? [r.luma.buffer] : [] };
      },
      degrade(a) {
        const T = SPX.lab.TESTS[a.test];
        const deg = T.run(a.channels, a.fs);
        return { value: deg, transfer: deg.map(c => c.buffer) };
      },
    };

    self.onmessage = (ev) => {
      const { id, cmd, args } = ev.data;
      const h = handlers[cmd];
      if (!h) { post(id, 'error', 'Comando desconhecido: ' + cmd); return; }
      try {
        let last = 0;
        const prog = (d) => { const now = Date.now(); if (now - last > 60 || d.msg) { last = now; post(id, 'progress', d); } };
        const r = h(args, prog);
        post(id, 'result', r.value, r.transfer);
      } catch (e) {
        post(id, 'error', (e && e.message) || String(e));
      }
    };
  }

  let blobUrl = null;
  function workerUrl() {
    if (blobUrl) return blobUrl;
    const parts = [];
    // lamejs (LGPL, script separado em assets/js/vendor) — injetado antes do modo estrito
    if (typeof self.lamejs === 'function') parts.push(self.lamejs.toString() + '\nlamejs();\n');
    parts.push('const SPX = {};\n');
    for (const m of self.SPX_MODULES) parts.push('(' + m.toString() + ')(SPX);\n');
    parts.push('(' + SPX_WORKER_MAIN.toString() + ')(SPX);\n');
    blobUrl = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
    return blobUrl;
  }

  /** Cliente RPC com promessas e callbacks de progresso. */
  class WorkerClient {
    constructor(name) {
      this.name = name; this.seq = 0; this.pending = new Map();
      this._spawn();
    }
    _spawn() {
      this.w = new Worker(workerUrl(), { name: this.name });
      this.w.onmessage = (ev) => {
        const { id, type, data } = ev.data, p = this.pending.get(id);
        if (!p) return;
        if (type === 'progress') { p.onProgress && p.onProgress(data); return; }
        this.pending.delete(id);
        type === 'result' ? p.resolve(data) : p.reject(new Error(data));
      };
      this.w.onerror = (e) => { for (const [, p] of this.pending) p.reject(new Error(e.message || 'Falha no worker')); this.pending.clear(); };
    }
    call(cmd, args, transfer, onProgress) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        this.w.postMessage({ id, cmd, args }, transfer || []);
      });
    }
    /** Aborta tudo o que está em andamento (ex.: usuário cancelou). */
    restart() {
      this.w.terminate();
      for (const [, p] of this.pending) p.reject(new Error('cancelado'));
      this.pending.clear();
      this._spawn();
    }
  }

  window.SPX = window.SPX || {};
  for (const m of self.SPX_MODULES) m(window.SPX);
  window.SPX.WorkerClient = WorkerClient;
})();
