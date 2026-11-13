/* =====================================================================
 * SPECTRUM v2 — ui/app.js
 * Orquestração da interface: Codificar · Análise · Extração · Lab.
 * Três workers: job (codificar/decodificar), view (espectrogramas), lab.
 * ===================================================================== */
(function () {
  'use strict';
  const SPX = window.SPX, U = SPX.util, M = SPX.media;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------------------------------------------------------------- base
  const jobW = new SPX.WorkerClient('spx-job');
  const viewW = new SPX.WorkerClient('spx-view');
  let labW = new SPX.WorkerClient('spx-lab');
  M.setWorker(jobW);
  $('#st-threads').textContent = 'WORKERS: 3 · ' + (navigator.hardwareConcurrency || '?') + ' CPU';

  const S = { img: null, host: null, plan: null, encoded: null, an: null, ex: null, exOrig: null, busy: false };

  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), err ? 5200 : 2600);
  }
  function setProgress(el, p) { el.classList.toggle('on', p != null); el.firstElementChild.style.width = ((p || 0) * 100).toFixed(1) + '%'; }
  function log(el, text, cursor) { el.innerHTML = ''; el.textContent = text; if (cursor) el.insertAdjacentHTML('beforeend', '<span class="cur"></span>'); }
  const fmtHz = (f) => f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f.toFixed(1) + ' Hz';
  const metric = (l, v, cls, small) => `<div class="metric ${cls || ''}"><div class="l">${l}</div><div class="v">${v}${small ? `<small>${small}</small>` : ''}</div></div>`;
  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stem = (n) => (n || 'arquivo').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40);

  // ------------------------------------------------------------- abas
  function showView(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'analyze' && S.pendingAnalyze) { const p = S.pendingAnalyze; S.pendingAnalyze = null; loadAnalyzer(p.channels, p.fs, p.label); }
    if (name === 'lab') renderLabMetrics();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

  // ------------------------------------------------------ drag & drop
  function dropzone(el, input, onFile) {
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }

  // =================================================================
  //  01 · CODIFICAR
  // =================================================================
  const BANDS = { high: [11000, 20000], mid: [5000, 20000], wide: [1000, 20000], mp3: [4000, 15500], ultra: [22000, 46000] };
  function settings() {
    const band = $('#opt-band').value;
    let [fLow, fHigh] = band === 'custom' ? [+$('#opt-flo').value, +$('#opt-fhi').value] : BANDS[band];
    return {
      band, fLow, fHigh, fs: resolveFs(), N: $('#opt-n').value,
      fillBand: $('#opt-fillband').checked, fillDuration: $('#opt-filldur').checked,
      levelDb: +$('#opt-level').value, DR: +$('#opt-dr').value, carve: $('#opt-carve').checked, masking: +$('#opt-mask').value,
      modulation: $('#opt-mod').value, nsym: +$('#opt-nsym').value, payload: $('#opt-payload').value,
      imgDur: Math.max(0, +$('#opt-imgdur').value || 0), start: Math.max(0, +$('#opt-start').value || 0), trim: $('#opt-trim').checked, autolevel: $('#opt-autolevel').checked, invert: $('#opt-invert').checked,
      transRatio: +$('#adv-trans').value, carveDepth: +$('#adv-carvedepth').value, seed: +$('#adv-seed').value,
    };
  }
  /** Taxa de saída: "igual ao original" usa a taxa nativa do hospedeiro (48 kHz sem hospedeiro). */
  function resolveFs() {
    const v = $('#opt-fs').value;
    return v === 'host' ? ((S.host && S.host.srcFs) || 48000) : +v;
  }
  const MP3_STD = [128, 160, 192, 256, 320];
  /** Resolve o formato de saída. "auto" = mesmo formato/qualidade do arquivo original. */
  function resolveOut(fs) {
    let v = $('#opt-out').value, why = '';
    if (v === 'auto') {
      const src = S.host && S.host.src;
      if (!src) { v = 'flac16'; why = 'sem arquivo original → FLAC (sem perdas, compacto)'; }
      else if (src.fmt === 'wav') { v = src.float ? 'wav32' : src.bits >= 24 ? 'wav24' : 'wav16'; why = `original WAV ${src.float ? 'float' : src.bits + ' bits'}`; }
      else if (src.fmt === 'flac') { v = src.bits >= 24 ? 'flac24' : 'flac16'; why = `original FLAC ${src.bits} bits`; }
      else { const k = MP3_STD.find(x => x >= src.kbps * 0.95) || 320; v = 'mp3-' + k; why = `original ${src.fmt.toUpperCase()} ≈ ${Math.round(src.kbps)} kbps`; }
    }
    if (v.startsWith('mp3') && !SPX.mp3.supported(fs)) { v = 'flac16'; why = `MP3 não suporta ${fs} Hz → FLAC`; }
    const m = /^(wav|flac|mp3)-?(\d+)$/.exec(v) || [null, 'flac', '16'];
    const kind = m[1], q = +m[2];
    const label = kind === 'mp3' ? `MP3 ${q} kbps` : kind === 'flac' ? `FLAC ${q} bits` : q === 32 ? 'WAV float 32' : `WAV ${q} bits`;
    return { key: v, kind, bits: kind === 'mp3' ? 16 : q, kbps: kind === 'mp3' ? q : 0, lossless: kind !== 'mp3', label, why,
      ext: kind === 'mp3' ? 'mp3' : kind, mime: kind === 'mp3' ? 'audio/mpeg' : kind === 'flac' ? 'audio/flac' : 'audio/wav' };
  }
  function syncLabels() {
    const s = settings();
    $('#v-level').textContent = s.levelDb + ' dB';
    $('#v-dr').textContent = s.DR + ' dB';
    $('#v-mask').textContent = s.masking ? (s.masking * 100).toFixed(0) + '%' : 'off';
    $('#v-band').textContent = (s.fLow / 1000).toFixed(1) + '–' + (s.fHigh / 1000).toFixed(1) + ' kHz';
    $('#v-trans').textContent = s.transRatio.toFixed(3);
    $('#v-carvedepth').textContent = s.carveDepth + ' dB';
    $('#band-custom').hidden = s.band !== 'custom';
    $('#time-host').hidden = !S.host;
    $('#v-dur').textContent = s.imgDur > 0 ? s.imgDur + ' s' : 'auto';
    if (S.host) {
      const hd = S.host.channels[0].length / S.host.fs;
      $('#opt-start-range').max = Math.max(0, hd - 1).toFixed(1);
      $('#v-start').textContent = s.start.toFixed(1) + ' s';
      $('#v-start-hint').textContent = `de ${hd.toFixed(1)} s` + (s.imgDur > 0 ? ` · imagem em ${s.start.toFixed(1)}–${Math.min(hd, s.start + s.imgDur).toFixed(1)} s` : '');
    }
    const o = resolveOut(s.fs);
    $('#v-out').textContent = o.label;
    if ($('#opt-fs').value === 'host') $('#opt-fs').options[0].textContent = `igual ao original (${(s.fs / 1000).toFixed(s.fs % 1000 ? 1 : 0)} kHz)`;
  }

  function estimatePayloadBytes(s) {
    if (!S.img || s.modulation === 'off' || s.payload === 'none') return 0;
    return S.img.bytes.length + 64 + S.img.name.length;
  }
  /** Trecho do hospedeiro usado (amostras). */
  function hostRange(s) {
    if (!S.host) return null;
    const n = S.host.channels[0].length, fs = S.host.fs;
    const a = Math.min(n - 1, Math.round(s.start * fs));
    const len = s.imgDur > 0 ? Math.min(n - a, Math.round(s.imgDur * fs)) : n - a;
    return { a, len, n };
  }
  /** Opções do planejador a partir das configurações (tempo, região, recorte). */
  function planOptions(s, extra) {
    const r = hostRange(s);
    const o = {
      fs: s.fs, N: s.N, fLow: s.fLow, fHigh: s.fHigh,
      imgW: S.img.w, imgH: S.img.h, fillBand: s.fillBand, fillDuration: s.fillDuration,
      modulation: s.modulation, nsym: s.nsym, payloadBytes: s.payload === 'auto' ? estimatePayloadBytes(s) : 0, transRatio: s.transRatio,
    };
    if (!r) { o.totalSamples = null; o.duration = s.imgDur > 0 ? s.imgDur : null; o.autoDuration = !(s.imgDur > 0); }
    else if (s.trim) { o.totalSamples = r.len; o.regionStart = 0; o.regionLength = 0; }  // hospedeiro recortado
    else { o.totalSamples = r.n; o.regionStart = r.a; o.regionLength = r.len; }        // áudio inteiro, imagem no trecho
    return Object.assign(o, extra || {});
  }
  function computePlan() {
    const s = settings();
    if (!S.img) { S.plan = null; renderCapacity(s); return; }
    S.plan = SPX.layout.plan(planOptions(s));
    if (s.band === 'ultra' && s.fs < 96000 && S.plan.ok) S.plan.warnings.unshift('Banda ultrassônica requer 96 kHz — ajuste a taxa de saída.');
    if (S.plan.ok && s.fHigh > s.fs / 2) S.plan.warnings.push(`f máx (${s.fHigh} Hz) acima de Nyquist (${s.fs / 2} Hz) — banda limitada.`);
    renderCapacity(s);
    renderPreviewPlan();
  }
  let planTimer = 0;
  const schedulePlan = () => { syncLabels(); clearTimeout(planTimer); planTimer = setTimeout(computePlan, 40); };

  function renderCapacity(s) {
    const P = S.plan, mEl = $('#cap-metrics'), bars = $('#cap-bars'), msgs = $('#cap-msgs');
    if (!P) {
      mEl.innerHTML = metric('status', 'aguardando imagem', 'warn');
      bars.innerHTML = ''; msgs.innerHTML = '<div class="msg tip">Carregue uma imagem (ou escolha uma amostra) para calcular a capacidade.</div>';
      $('#cap-head').textContent = ''; return;
    }
    if (!P.ok) { mEl.innerHTML = metric('status', 'inviável', 'bad'); bars.innerHTML = ''; msgs.innerHTML = `<div class="msg err">${P.error}</div>`; return; }
    const native = P.scale >= 1;
    $('#cap-head').textContent = native ? '✓ resolução nativa' : '⚠ reduzida';
    mEl.innerHTML = [
      metric('resolução', `${P.w}×${P.h}`, native ? '' : 'warn', native ? 'nativa' : (P.scale * 100).toFixed(0) + '%'),
      metric('N · Δf', P.N, '', P.df.toFixed(1) + ' Hz'),
      metric('coluna Δt', (P.colSeconds * 1000).toFixed(1), '', 'ms'),
      metric('imagem', P.imageSeconds.toFixed(1), '', `s de ${P.duration.toFixed(1)} s`),
      metric('banda real', `${(P.fLow / 1000).toFixed(1)}–${(P.fHigh / 1000).toFixed(1)}`, '', 'kHz'),
      metric('bins/linha', P.rpp, '', 'rpp'),
      metric('pixels máx', P.maxCols ? `${P.maxImgRows}×${P.maxCols}` : `${P.maxImgRows}×∞`, ''),
      metric('payload máx', P.modBits ? U.fmtBytes(P.payloadCapacity) : 'off', P.modBits ? '' : 'warn'),
    ].join('');
    const rowsPct = P.h / P.maxImgRows, colsPct = P.maxCols ? P.w / P.maxCols : 1;
    const est = estimatePayloadBytes(s);
    const payPct = P.payloadCapacity ? est / P.payloadCapacity : 0;
    const bar = (label, pct, txt) => `<div class="hint" style="display:flex;justify-content:space-between"><span>${label}</span><span>${txt}</span></div><div class="capbar ${pct > 1 ? 'over' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div>`;
    bars.innerHTML = bar('linhas na banda', rowsPct, `${P.h * P.rpp + 2} / ${P.bandBins} bins`) +
      bar('colunas no tempo', colsPct, P.maxCols ? `${P.w} / ${P.maxCols}` : `${P.w} (duração automática: ${P.duration.toFixed(1)} s)`) +
      (P.modBits && s.payload !== 'none' ? bar('arquivo original vs capacidade', payPct, `${U.fmtBytes(est)} / ${U.fmtBytes(P.payloadCapacity)}${payPct > 1 && s.payload === 'auto' ? ' → será recodificado' : ''}`) : '');
    const ms = [];
    for (const w of P.warnings) if (!/não cabe/.test(w) || s.payload === 'none') ms.push(`<div class="msg">${w}</div>`);
    for (const t of P.suggestions) ms.push(`<div class="msg tip">↳ ${t}</div>`);
    if (P.modBits && s.payload !== 'none') {
      if (payPct <= 1 && s.payload === 'auto') ms.push(`<div class="msg tip">Extração completa devolverá o <b>arquivo original bit-a-bit</b> (${S.img.mime}).</div>`);
      else ms.push(`<div class="msg tip">O arquivo será recodificado (WebP) na maior qualidade que caiba em ${U.fmtBytes(P.payloadCapacity)} — a cor volta na extração.</div>`);
    }
    ms.push(`<div class="msg tip">Capacidade física: célula ${P.df.toFixed(1)} Hz × ${(P.colSeconds * 1000).toFixed(0)} ms (produto Δf·Δt = ${(P.df * P.colSeconds).toFixed(2)} ≥ 1, limite de incerteza). Pixels ≈ banda × duração / (Δf·Δt).</div>`);
    msgs.innerHTML = ms.join('');
  }

  // ------------------------------------------- preview do plano de pintura
  const preview = new SPX.SpectroView($('#enc-preview'), { worker: viewW, compact: true, name: 'prev', emptyText: 'PLANO DE PINTURA' });
  S.prevReveal = 1;
  function coloredLuma() {
    const P = S.plan; if (!P || !P.ok || !S.img) return null;
    const key = [S.img.name, P.w, P.h, $('#opt-autolevel').checked, $('#opt-invert').checked].join('|');
    if (S._cl && S._cl.key === key) return S._cl.c;
    const Y = M.imageToLuma(S.img, P.w, P.h, { autolevel: $('#opt-autolevel').checked, invert: $('#opt-invert').checked });
    const c = document.createElement('canvas'); c.width = P.w; c.height = P.h;
    const x = c.getContext('2d'), im = x.createImageData(P.w, P.h), map = SPX.colormaps.MAPS.matrix;
    for (let i = 0; i < Y.length; i++) { const k = Math.round((0.12 + 0.88 * Y[i]) * 255) * 3; im.data[i * 4] = map[k]; im.data[i * 4 + 1] = map[k + 1]; im.data[i * 4 + 2] = map[k + 2]; im.data[i * 4 + 3] = 255; }
    x.putImageData(im, 0, 0);
    S._cl = { key, c };
    return c;
  }
  preview.overlayFn = (ctx, px, py, W, H) => {
    const P = S.plan;
    ctx.fillStyle = '#000'; ctx.fillRect(px, py, W, H);
    if (!P || !P.ok) return;
    const dur = P.duration, nyq = P.fs / 2;
    const X = (smp) => px + (smp / P.fs) / dur * W, Yf = (f) => py + (1 - f / nyq) * H;
    // hospedeiro (esquemático)
    if (S.host) { const g = ctx.createLinearGradient(0, py + H, 0, py); g.addColorStop(0, 'rgba(0,140,40,.55)'); g.addColorStop(0.6, 'rgba(0,60,18,.35)'); g.addColorStop(1, 'rgba(0,20,6,.2)'); ctx.fillStyle = g; ctx.fillRect(px, py, W, H); }
    // banda limpa
    if (S.host && $('#opt-carve').checked) { ctx.fillStyle = '#000'; ctx.fillRect(X(P.regionStart), Yf(P.fHigh + 4 * P.df), X(P.regionEnd) - X(P.regionStart), Yf(P.fLow - 4 * P.df) - Yf(P.fHigh + 4 * P.df)); }
    // beacon
    ctx.fillStyle = 'rgba(184,255,60,.85)';
    for (const B0 of P.beaconStarts) ctx.fillRect(X(B0), Yf(P.fHigh), Math.max(1.5, X(B0 + SPX.layout.PROTO.BEACON_COPY_LEN) - X(B0)), Math.max(2, (Yf(P.fLow) - Yf(P.fHigh)) * 0.18));
    // pilotos + preâmbulo
    const gx0 = X(P.gridStart), gx1 = X(P.gridEnd), pre = X(P.gridStart + P.P * P.L);
    ctx.fillStyle = 'rgba(0,255,65,.9)'; ctx.fillRect(gx0, Yf(P.fHigh), Math.max(1, pre - gx0), Yf(P.fLow) - Yf(P.fHigh));
    ctx.fillRect(gx0, Yf(P.fHigh) - 0.5, gx1 - gx0, 1); ctx.fillRect(gx0, Yf(P.fLow) - 0.5, gx1 - gx0, 1);
    // imagem (revelada progressivamente durante a codificação)
    const c = coloredLuma();
    if (c) {
      const rv = S.prevReveal, iw = (gx1 - pre);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c, 0, 0, Math.max(1, Math.round(P.w * rv)), P.h, pre, Yf(P.fHigh - P.df), iw * rv, Yf(P.fLow + P.df) - Yf(P.fHigh - P.df));
      if (rv < 1) { ctx.fillStyle = '#b8ff3c'; ctx.fillRect(pre + iw * rv, Yf(P.fHigh), 1.5, Yf(P.fLow) - Yf(P.fHigh)); }
    }
  };
  function renderPreviewPlan() {
    if (S.encodedFresh) return; // mostrando o resultado real
    preview.clear('PLANO DE PINTURA');
    preview.view = { t0: 0, t1: S.plan && S.plan.ok ? S.plan.duration : 1, f0: 0, f1: S.plan && S.plan.ok ? S.plan.fs / 2 : 24000 };
    preview.emptyEl.style.display = S.plan && S.plan.ok ? 'none' : '';
    $('#prev-mode').textContent = 'plano de pintura (esquemático)';
    preview._drawImg(); preview._drawOverlay();
  }

  // ------------------------------------------------------- imagem
  async function setImage(info) {
    S.img = info; S._cl = null; S.encodedFresh = false;
    const th = $('#img-thumb'); th.textContent = ''; th.style.backgroundImage = `url("${info.url}")`;
    $('#img-name').textContent = info.name;
    $('#img-info').textContent = `${info.w}×${info.h} · ${info.mime} · ${U.fmtBytes(info.bytes.length)}`;
    log($('#enc-log'), 'imagem carregada: ' + info.name, true);
    schedulePlan();
  }
  dropzone($('#img-drop'), $('#img-file'), async (f) => { try { await setImage(await M.imageFromFile(f)); } catch (e) { toast(e.message, true); } });
  $$('[data-sample]').forEach(b => b.addEventListener('click', async () => { try { await setImage(await M.sample(b.dataset.sample)); } catch (e) { toast(e.message, true); } }));

  // ------------------------------------------------------- hospedeiro
  async function decodeHost() {
    if (!S.host) return;
    const s = settings();
    if (S.host.fs === s.fs) return;
    log($('#enc-log'), 'reamostrando hospedeiro para ' + s.fs + ' Hz…', true);
    if (S.host.demo) S.host.channels = await jobW.call('demoHost', { fs: s.fs, seconds: S.host.seconds });
    else S.host.channels = (await M.decodeAudioTo(S.host.buf, s.fs)).channels;
    S.host.fs = s.fs;
    renderHost();
  }
  function renderHost() {
    const h = S.host;
    $('#host-thumb').textContent = h ? '∿' : '∿';
    $('#host-name').textContent = h ? h.name : 'Sem hospedeiro (portadora pura)';
    $('#host-info').textContent = h ? `${(h.channels[0].length / h.fs).toFixed(1)} s · ${h.channels.length} canal(is) · ${h.fs} Hz` +
      (h.src ? ` · ${h.src.fmt.toUpperCase()}${h.src.bits ? ' ' + (h.src.float ? 'float' : h.src.bits + ' bits') : ''}${h.src.fmt === 'wav' || h.src.fmt === 'flac' ? '' : ' ≈ ' + Math.round(h.src.kbps) + ' kbps'} · ${U.fmtBytes(h.src.bytes)}` : '') : 'Solte WAV/FLAC/MP3/OGG… ou use a demo';
    syncLabels(); schedulePlan();
  }
  dropzone($('#host-drop'), $('#host-file'), async (f) => {
    try {
      log($('#enc-log'), 'decodificando hospedeiro…', true);
      const buf = await f.arrayBuffer(), s = settings();
      const src = M.describeAudio(buf, f.name);
      const fsOut = $('#opt-fs').value === 'host' ? (src.fs || 48000) : s.fs;
      const r = await M.decodeAudioTo(buf, fsOut);
      src.kbps = src.bytes * 8 / r.duration / 1000;
      S.host = { name: f.name, buf, channels: r.channels, fs: fsOut, srcFs: src.fs, src };
      S.encodedFresh = false; renderHost();
      log($('#enc-log'), 'hospedeiro pronto: ' + f.name, true);
    } catch (e) { toast('Não foi possível decodificar o áudio: ' + e.message, true); }
  });
  $('#host-demo').addEventListener('click', async () => {
    const s = settings();
    log($('#enc-log'), 'sintetizando trilha demo…', true);
    const ch = await jobW.call('demoHost', { fs: s.fs, seconds: 90 });
    S.host = { name: 'demo_groove.synth (90 s)', channels: ch, fs: s.fs, demo: true, seconds: 90 };
    S.encodedFresh = false; renderHost();
    log($('#enc-log'), 'trilha demo pronta', true);
  });
  $('#host-clear').addEventListener('click', () => { S.host = null; S.encodedFresh = false; renderHost(); });

  // ------------------------------------------------------- parâmetros
  const PROFILES = {
    visual: { 'opt-dr': 42, 'opt-nsym': 32, 'opt-level': -24, 'opt-mod': 'qpsk' },
    balanced: { 'opt-dr': 32, 'opt-nsym': 64, 'opt-level': -21, 'opt-mod': 'qpsk' },
    robust: { 'opt-dr': 24, 'opt-nsym': 128, 'opt-level': -18, 'opt-mod': 'qpsk', 'opt-band': 'mp3' },
  };
  $('#opt-profile').addEventListener('change', () => {
    const pr = PROFILES[$('#opt-profile').value]; if (!pr) return;
    for (const [id, v] of Object.entries(pr)) $('#' + id).value = v;
    if (pr['opt-band']) $('#opt-band').dispatchEvent(new Event('change'));
    S.encodedFresh = false; schedulePlan();
  });
  ['opt-dr', 'opt-nsym', 'opt-level', 'opt-mod'].forEach(id => $('#' + id).addEventListener('input', (e) => { if (e.isTrusted) $('#opt-profile').value = 'custom'; }));
  $('#opt-band').addEventListener('change', () => {
    const b = $('#opt-band').value;
    if (b === 'ultra') $('#opt-fs').value = '96000';
    else if (b !== 'custom' && $('#opt-fs').value === '96000' && !S.userFs96) $('#opt-fs').value = 'host';
    if (b !== 'custom') { $('#opt-flo').value = BANDS[b][0]; $('#opt-fhi').value = BANDS[b][1]; }
    onFsMaybeChanged();
  });
  async function onFsMaybeChanged() { S.encodedFresh = false; syncLabels(); try { await decodeHost(); } catch (e) { toast(e.message, true); } schedulePlan(); }
  $('#opt-fs').addEventListener('change', () => { S.userFs96 = $('#opt-fs').value === '96000'; onFsMaybeChanged(); });
  $$('#view-encode input, #view-encode select, #view-lab input').forEach(el => {
    if (['opt-fs', 'opt-band', 'opt-profile', 'opt-out', 'img-file', 'host-file'].includes(el.id)) return;
    el.addEventListener('input', () => { S.encodedFresh = false; schedulePlan(); });
  });

  // ------------------------------------------------------- tempo
  const setDur = (v) => { $('#opt-imgdur').value = v; if (v > 0) $('#opt-dur-range').value = Math.min(120, v); S.encodedFresh = false; schedulePlan(); };
  $('#opt-dur-range').addEventListener('input', () => setDur(+$('#opt-dur-range').value));
  $('#opt-imgdur').addEventListener('input', () => { const v = +$('#opt-imgdur').value; if (v > 0) $('#opt-dur-range').value = Math.min(120, v); });
  $$('[data-dur]').forEach(b => b.addEventListener('click', () => setDur(+b.dataset.dur)));
  $('#opt-start-range').addEventListener('input', () => { $('#opt-start').value = $('#opt-start-range').value; S.encodedFresh = false; schedulePlan(); });
  $('#opt-start').addEventListener('input', () => { $('#opt-start-range').value = $('#opt-start').value; });

  // ------------------------------------------------------- codificação
  $('#btn-encode').addEventListener('click', encodeNow);
  async function encodeNow() {
    if (S.busy) return;
    if (!S.img) { toast('Carregue uma imagem primeiro.', true); return; }
    await decodeHost();
    computePlan();
    let P = S.plan; const s = settings();
    if (!P || !P.ok) { toast(P ? P.error : 'Plano inválido', true); return; }
    S.busy = true; $('#btn-encode').disabled = true;
    const el = $('#enc-log'), pr = $('#enc-progress');
    const t0 = performance.now();
    try {
      S.encodedFresh = false; S.prevReveal = 0; renderPreviewPlan();
      log(el, `luminância ${P.w}×${P.h}…`, true);
      const luma = M.imageToLuma(S.img, P.w, P.h, { autolevel: s.autolevel, invert: s.invert });
      let pay = null;
      if (P.modBits && s.payload !== 'none') {
        log(el, 'preparando payload (capacidade ' + U.fmtBytes(P.payloadCapacity) + ')…', true);
        pay = await M.preparePayload(S.img, P.payloadCapacity, s.payload, (m) => log(el, m, true));
        if (!pay) toast('Payload não coube — só a camada visual será gravada.', true);
      }
      // replaneja com o tamanho real do contêiner
      P = SPX.layout.plan(planOptions(s, { modulation: pay ? s.modulation : 'off', payloadBytes: pay ? pay.container.length : 0 }));
      const seed = s.seed > 0 ? s.seed >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0];
      const hr = hostRange(s);
      const host = S.host ? S.host.channels.map(c => s.trim ? c.slice(hr.a, hr.a + hr.len) : new Float32Array(c)) : null;
      setProgress(pr, 0);
      const res = await jobW.call('encode', {
        host, fs: s.fs, plan: P, luma, container: pay ? pay.container : null, seed, DR: s.DR, levelDb: s.levelDb,
        carve: s.carve, carveDepth: s.carveDepth, masking: s.masking,
      }, host ? host.map(c => c.buffer) : [], (d) => {
        const p = d.stage === 'carve' ? d.p * 0.35 : d.stage === 'grid' ? 0.35 + d.p * 0.6 : (d.p || 0) * 0.35;
        setProgress(pr, p);
        if (d.stage === 'grid') { S.prevReveal = d.p; preview._drawImg(); }
        if (d.msg) log(el, d.msg, true);
      });
      const luma8 = new Uint8ClampedArray(luma.length); for (let i = 0; i < luma.length; i++) luma8[i] = Math.round(luma[i] * 255);
      S.encoded = { channels: res.channels, fs: s.fs, stats: res.stats, header: res.header, plan: P, luma8, img: S.img, pay, seed,
        base: 'spectrum_' + stem(S.img.name), name: 'spectrum_' + stem(S.img.name), settings: s, exports: {},
        srcBytes: S.host && S.host.src ? S.host.src.bytes : null, srcLabel: S.host && S.host.src ? S.host.name : null };
      const out = resolveOut(s.fs);
      const blob = await exportAudio(S.encoded, out, (p) => setProgress(pr, 0.95 + 0.05 * p));
      setProgress(pr, 1);
      const ms = performance.now() - t0;
      S.prevReveal = 1; S.encodedFresh = true;
      $('#prev-mode').textContent = 'espectrograma real da saída';
      await preview.setAudio(res.channels, s.fs);
      preview.set({ floor: -110, range: 80 });
      renderEncodeOut();
      S.pendingAnalyze = { channels: res.channels, fs: s.fs, label: S.encoded.name };
      S.exSource = null;
      S.busy = false; $('#btn-encode').disabled = false; // libera antes do log final (evita clique ignorado)
      log(el, `✓ codificado em ${(ms / 1000).toFixed(2)} s · ${P.w}×${P.h} · ${out.label} · ${U.fmtBytes(blob.size)}${sizeDelta(blob.size)}`);
      setTimeout(() => setProgress(pr, null), 600);
    } catch (e) {
      console.error(e); toast('Falha na codificação: ' + e.message, true); log(el, '✗ ' + e.message); setProgress(pr, null);
    } finally { S.busy = false; $('#btn-encode').disabled = false; }
  }
  preview.onRendered = (r) => { // auto-contraste do preview
    if (preview._autoDone === preview.key) return; preview._autoDone = preview.key;
    const floor = Math.max(r.p50 - 10, r.p995 - 95); preview.set({ floor, range: Math.max(30, r.p995 - floor + 2) });
  };

  function renderEncodeOut() {
    const E = S.encoded, st = E.stats, P = E.plan;
    $('#enc-out').hidden = false;
    $('#enc-metrics').innerHTML = [
      metric('imagem no espectro', `${P.w}×${P.h}`),
      metric('duração', (st.samples / E.fs).toFixed(2), '', 's'),
      metric('embutido / host', st.embedToHostDb != null ? st.embedToHostDb.toFixed(1) : '—', '', st.embedToHostDb != null ? 'dB' : 'sem host'),
      metric('pico', st.peakDb.toFixed(1), st.peakDb > -0.5 ? 'warn' : '', 'dBFS'),
      metric('limitador', st.limiterDb.toFixed(1), st.limiterDb < -0.1 ? 'warn' : '', 'dB'),
      metric('payload', E.pay ? U.fmtBytes(E.pay.container.length) : 'nenhum', E.pay ? '' : 'warn'),
      metric('conteúdo', E.pay ? (E.pay.exact ? 'original' : 'recodificado') : 'visual', ''),
      metric('tempo', (st.ms / 1000).toFixed(2), '', 's'),
      ...(() => {
        const out = resolveOut(E.fs), blob = E.exports[out.key]; if (!blob) return [];
        const r = E.srcBytes ? blob.size / E.srcBytes : null;
        return [metric('arquivo', U.fmtBytes(blob.size), '', out.label),
          metric('vs original', r == null ? '—' : (r >= 1 ? '+' : '') + ((r - 1) * 100).toFixed(0) + '%', r != null && r > 1.25 ? 'warn' : '', r == null ? 'sem original' : U.fmtBytes(E.srcBytes))];
      })(),
    ].join('');
    renderOutput();
  }
  /** Gera (e guarda em cache) o arquivo no formato pedido. */
  async function exportAudio(E, out, onProgress) {
    if (E.exports[out.key]) return E.exports[out.key];
    log($('#enc-log'), `gerando ${out.label}${out.kind === 'mp3' ? ' (LAME)' : ''}…`, true);
    const ch = E.channels.map(c => new Float32Array(c)), tr = ch.map(c => c.buffer);
    let data;
    if (out.kind === 'wav') data = await jobW.call('wav', { channels: ch, fs: E.fs, bits: out.bits }, tr);
    else if (out.kind === 'flac') data = await jobW.call('flac', { channels: ch, fs: E.fs, bits: out.bits }, tr, (d) => onProgress && onProgress(d.p));
    else data = await jobW.call('mp3', { channels: ch, fs: E.fs, kbps: out.kbps }, tr, (d) => onProgress && onProgress(d.p));
    const blob = new Blob([data], { type: out.mime });
    E.exports[out.key] = blob;
    return blob;
  }
  function sizeDelta(bytes) {
    const E = S.encoded; if (!E || !E.srcBytes) return '';
    const d = (bytes / E.srcBytes - 1) * 100;
    return ` (${d >= 0 ? '+' : ''}${d.toFixed(0)}% vs original)`;
  }
  async function renderOutput() {
    const E = S.encoded; if (!E) return;
    const out = resolveOut(E.fs), blob = E.exports[out.key];
    $('#btn-download').textContent = `⤓ BAIXAR ${out.label.toUpperCase()}${blob ? ' · ' + U.fmtBytes(blob.size) : ''}`;
    const P = E.plan, msgs = [];
    if (out.why) msgs.push(`<div class="msg tip">Formato automático: ${out.why} → <b>${out.label}</b>.</div>`);
    if (blob && E.srcBytes) {
      const ratio = blob.size / E.srcBytes;
      if (ratio > 1.25) msgs.push(`<div class="msg">Saída ${((ratio - 1) * 100).toFixed(0)}% maior que o original (${U.fmtBytes(E.srcBytes)}). ${out.kind === 'wav' ? 'FLAC tem as mesmas garantias com ~35–55% do tamanho.' : out.kind === 'flac' ? 'Para ficar do tamanho de um original comprimido, use MP3 (com perdas).' : 'Escolha um bitrate menor.'}</div>`);
    }
    if (out.kind === 'mp3') {
      const cut = SPX.mp3.lowpassHz(out.kbps);
      if (P.fHigh > cut) msgs.push(`<div class="msg">MP3 ${out.kbps} kbps corta acima de ≈ ${(cut / 1000).toFixed(1)} kHz: o topo da imagem (até ${(P.fHigh / 1000).toFixed(1)} kHz) se perde. Use a banda "Compatível MP3" ou bitrate maior.</div>`);
      const robust = E.settings.DR <= 26 && E.settings.nsym >= 64;
      msgs.push(`<div class="msg tip">MP3 é com perdas: a imagem continua visível no espectro. ${robust
        ? (out.kbps >= 320 ? 'Perfil Robusto a 320 kbps: a extração completa sobreviveu nos testes — confirme em 04 · Laboratório.' : `Extração completa: no perfil Robusto ela sobreviveu a 320 kbps, mas tende a falhar a ${out.kbps} kbps. Para garanti-la use FLAC, ou MP3 320.`)
        : 'A extração bit-a-bit provavelmente falha; para garanti-la use FLAC/WAV (ou perfil Robusto + MP3 320).'}</div>`);
    } else msgs.push(`<div class="msg tip">${out.label}: sem perdas — extração completa bit-a-bit garantida.</div>`);
    $('#enc-mp3-msg').innerHTML = msgs.join('');
  }
  $('#opt-out').addEventListener('change', () => { syncLabels(); renderOutput(); });
  $('#btn-download').addEventListener('click', async () => {
    const E = S.encoded; if (!E) return;
    if (S.busy) { toast('Aguarde o processamento terminar.'); return; }
    const out = resolveOut(E.fs), btn = $('#btn-download'), pr = $('#enc-progress');
    S.busy = true; btn.disabled = true;
    try {
      const blob = await exportAudio(E, out, (p) => setProgress(pr, p));
      log($('#enc-log'), `✓ ${out.label} · ${U.fmtBytes(blob.size)}${sizeDelta(blob.size)}`);
      download(blob, `${E.base}.${out.ext}`);
      renderOutput(); renderEncodeOut();
    } catch (e) { toast('Falha na exportação: ' + e.message, true); log($('#enc-log'), '✗ ' + e.message); }
    finally { S.busy = false; btn.disabled = false; setTimeout(() => setProgress(pr, null), 400); }
  });
  $('#btn-to-analyze').addEventListener('click', () => { if (!S.encoded) return; S.pendingAnalyze = { channels: S.encoded.channels, fs: S.encoded.fs, label: S.encoded.name }; showView('analyze'); });
  $('#btn-to-extract').addEventListener('click', () => { useEncodedForExtract(); showView('extract'); });
  $('#btn-to-lab').addEventListener('click', () => showView('lab'));

  // =================================================================
  //  02 · ANÁLISE DE ESPECTRO
  // =================================================================
  const view = new SPX.SpectroView($('#an-view'), { worker: viewW, name: 'an', emptyText: 'CARREGUE UM ÁUDIO OU CODIFIQUE UMA IMAGEM' });
  const player = new M.Player();
  SPX.colormaps.swatch($('#an-swatch'), 'matrix');

  async function loadAnalyzer(channels, fs, label) {
    S.an = { channels, fs, label };
    $('#an-src').textContent = `${label} · ${fs} Hz · ${(channels[0].length / fs).toFixed(1)} s`;
    player.load(channels, fs);
    view.setFrozen(false); $('#an-freeze').classList.remove('on');
    view.set({ aligned: false }); $('#an-aligned').classList.remove('on');
    await view.setAudio(channels, fs, label);
    $('#an-f0').value = 0; $('#an-f1').value = fs / 2;
    $('#an-detect').innerHTML = '<span class="mut">procurando assinatura SPv2…</span>';
    view._autoPending = true;
    try {
      const g = await view.analyzeGrid();
      if (g) {
        const h = g.header, df = fs / h.N;
        $('#an-detect').innerHTML = `<span class="ok">● SPv2 detectado</span> <span class="mut">· ${h.imgW}×${h.imgH} · N=${h.N} · ${fmtHz(h.k0 * df)}–${fmtHz((h.k0 + h.rows - 1) * df)} · SNR ${g.snrDb.toFixed(1)} dB</span>`;
        view.fitImage();
      } else {
        $('#an-detect').innerHTML = '<span class="mut">○ sem assinatura SPv2 — análise genérica</span>';
        view.requestRender(0);
      }
    } catch (e) { $('#an-detect').textContent = e.message; }
  }
  view.onRendered = (r) => {
    if (view._autoPending) { view._autoPending = false; autoContrast(r); }
    if (view._alignedAuto && r.gridRef != null) { // preto da imagem = ref − DR
      view._alignedAuto = false;
      const floor = Math.round(r.gridRef - r.gridDR - 3), range = Math.round(r.gridDR + 6);
      $('#an-floor').value = floor; $('#an-range').value = range; view.set({ floor, range });
    }
  };
  function autoContrast(r) {
    r = r || view.stats; if (!r) return;
    const floor = Math.max(r.p50 - 6, r.p995 - 90), range = Math.max(24, r.p995 - floor + 2);
    $('#an-floor').value = Math.round(floor); $('#an-range').value = Math.round(range);
    view.set({ floor, range });
  }
  view.onViewChange = (v, vw) => {
    $('#an-f0').value = Math.round(Math.max(0, v.f0)); $('#an-f1').value = Math.round(Math.min(vw.fs / 2, v.f1));
    if (vw.dur) {
      $('#an-zx').value = Math.max(0, Math.min(1, -Math.log10((v.t1 - v.t0) / vw.dur) / 3));
      $('#an-zy').value = Math.max(0, Math.min(1, -Math.log10((v.f1 - v.f0) / (vw.fs / 2)) / 2.5));
    }
  };
  view.onClickTime = (t) => player.seek(t);

  $('#an-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const buf = await f.arrayBuffer(); const r = await M.readAudio(buf, 48000); await loadAnalyzer(r.channels, r.fs, f.name); }
    catch (err) { toast('Falha ao abrir áudio: ' + err.message, true); }
  });
  $('#an-cmap').addEventListener('change', () => { view.set({ cmap: $('#an-cmap').value }); SPX.colormaps.swatch($('#an-swatch'), $('#an-cmap').value); });
  $('#an-range').addEventListener('input', () => view.set({ range: +$('#an-range').value }));
  $('#an-floor').addEventListener('input', () => view.set({ floor: +$('#an-floor').value }));
  $('#an-gamma').addEventListener('input', () => view.set({ gamma: +$('#an-gamma').value }));
  $('#an-auto').addEventListener('click', () => autoContrast());
  $('#an-n').addEventListener('change', () => view.set({ N: $('#an-n').value }));
  $('#an-win').addEventListener('change', () => view.set({ window: $('#an-win').value }));
  function seg(el, fn) { el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', el).forEach(x => x.classList.toggle('on', x === b)); fn(b.dataset.v); }); }
  seg($('#an-fscale'), (v) => view.set({ fscale: v }));
  seg($('#an-mode'), (v) => { view.setMode(v, player); if (v === 'live' && !player.playing && view.key) player.play(); });
  $('#an-zx').addEventListener('input', () => {
    if (!view.dur) return; const span = view.dur * Math.pow(10, -3 * $('#an-zx').value), c = (view.view.t0 + view.view.t1) / 2;
    view.setView({ t0: c - span / 2, t1: c + span / 2 });
  });
  $('#an-zy').addEventListener('input', () => {
    if (!view.dur) return; const span = (view.fs / 2) * Math.pow(10, -2.5 * $('#an-zy').value), c = (view.view.f0 + view.view.f1) / 2;
    view.setView({ f0: c - span / 2, f1: c + span / 2 });
  });
  const applyRange = () => { const a = +$('#an-f0').value, b = +$('#an-f1').value; if (b > a) view.setView({ f0: a, f1: b }); };
  $('#an-f0').addEventListener('change', applyRange); $('#an-f1').addEventListener('change', applyRange);
  $('#an-fit').addEventListener('click', async () => {
    if (!view.key) return;
    if (!view.grid) { toast('Nenhuma assinatura SPv2 detectada neste áudio.', true); return; }
    view.fitImage();
  });
  $('#an-aligned').addEventListener('click', () => {
    if (!view.grid) { toast('Grade alinhada requer um áudio SPv2 (beacon detectado).', true); return; }
    const on = !view.params.aligned; $('#an-aligned').classList.toggle('on', on);
    view._alignedAuto = on; if (!on) view._autoPending = true;
    view.set({ aligned: on });
  });
  $('#an-reset').addEventListener('click', () => view.key && view.resetView());
  const toggleFreeze = () => { const f = !view.frozen; view.setFrozen(f); $('#an-freeze').classList.toggle('on', f); };
  $('#an-freeze').addEventListener('click', toggleFreeze);
  $('#an-png').addEventListener('click', () => view.key ? view.exportPNG('spectrum_' + stem(S.an && S.an.label) + '.png') : toast('Nada para exportar.', true));

  // player
  const plBtn = $('#pl-play'), plTime = $('#pl-time'), seekEl = $('#pl-seek');
  plBtn.addEventListener('click', () => player.toggle());
  player.on(() => { plBtn.textContent = player.playing ? '❚❚' : '▶'; });
  seekEl.addEventListener('click', (e) => { const r = seekEl.getBoundingClientRect(); player.seek((e.clientX - r.left) / r.width * player.duration); });
  $('#pl-vol').addEventListener('input', () => player.setVolume(+$('#pl-vol').value));
  (function loop() {
    const t = player.currentTime, d = player.duration;
    plTime.textContent = U.fmtTime(t) + ' / ' + U.fmtTime(d);
    seekEl.firstElementChild.style.width = d ? (t / d * 100) + '%' : '0';
    const ph = d ? t : null;
    if (player.playing || view.playhead !== ph) view.setPlayhead(ph);
    requestAnimationFrame(loop);
  })();
  document.addEventListener('keydown', (e) => {
    if (!$('#view-analyze').classList.contains('active') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    if (e.key === 'f' || e.key === 'F') toggleFreeze();
  });

  // =================================================================
  //  03 · EXTRAÇÃO
  // =================================================================
  function useEncodedForExtract() {
    if (!S.encoded) { toast('Nada codificado ainda.', true); return; }
    S.exSource = { channels: S.encoded.channels, fs: S.encoded.fs, name: S.encoded.name + ' (memória, sem perdas)', fromEncoded: true };
    $('#ex-name').textContent = S.encoded.name; $('#ex-info').textContent = 'último áudio codificado (em memória)';
  }
  $('#ex-use-enc').addEventListener('click', useEncodedForExtract);
  dropzone($('#ex-drop'), $('#ex-file'), async (f) => {
    try {
      const buf = await f.arrayBuffer();
      if (M.isWav(buf)) {
        const r = await M.readAudio(buf);
        S.exSource = { channels: r.channels, fs: r.fs, name: f.name, info: r.info };
      } else S.exSource = { buf, name: f.name, compressed: true };
      $('#ex-name').textContent = f.name;
      $('#ex-info').textContent = S.exSource.compressed ? `formato comprimido${M.sniffFs(buf) ? ' · ' + M.sniffFs(buf) + ' Hz' : ''} — decodificado pelo navegador` : `${S.exSource.info} · ${S.exSource.fs} Hz · ${(S.exSource.channels[0].length / S.exSource.fs).toFixed(1)} s`;
    } catch (e) { toast('Falha ao ler: ' + e.message, true); }
  });
  dropzone($('#ex-orig-drop'), $('#ex-orig-file'), async (f) => {
    try {
      S.exOrig = await M.imageFromFile(f);
      const th = $('#ex-orig-thumb'); th.textContent = ''; th.style.backgroundImage = `url("${S.exOrig.url}")`;
      $('#ex-orig-name').textContent = f.name;
      if (S.exResult) renderExtract(S.exResult);
    } catch (e) { toast(e.message, true); }
  });

  $('#btn-extract').addEventListener('click', async () => {
    if (!S.exSource) { if (S.encoded) useEncodedForExtract(); else { toast('Escolha um áudio.', true); return; } }
    const src = S.exSource, el = $('#ex-log'), pr = $('#ex-progress');
    $('#btn-extract').disabled = true; setProgress(pr, 0);
    try {
      const sniffed = src.compressed ? M.sniffFs(src.buf) : null;
      let attempts = src.compressed ? [...new Set([sniffed, 48000, 44100, 96000].filter(Boolean))] : [src.fs];
      let res = null, used = null;
      for (const fs of attempts) {
        let ch = src.channels;
        if (src.compressed) { log(el, `decodificando a ${fs} Hz…`, true); ch = (await M.decodeAudioTo(src.buf, fs)).channels; }
        const copy = ch.map(c => new Float32Array(c));
        res = await jobW.call('decode', { channels: copy, fs }, copy.map(c => c.buffer), (d) => {
          const base = { locate: 0, filter: 0.3, grid: 0.5, ecc: 0.8 }[d.stage] || 0, span = { locate: 0.3, filter: 0.2, grid: 0.3, ecc: 0.2 }[d.stage] || 0;
          setProgress(pr, base + (d.p || 0) * span); if (d.msg) log(el, d.msg, true);
        });
        used = fs;
        if (res.ok) break;
      }
      setProgress(pr, 1);
      res.usedFs = used;
      S.exResult = res;
      if (!res.ok) { log(el, '✗ ' + res.error); toast(res.error, true); }
      else log(el, `✓ extraído em ${(res.ms / 1000).toFixed(2)} s`);
      await renderExtract(res);
    } catch (e) { console.error(e); toast('Falha: ' + e.message, true); log(el, '✗ ' + e.message); }
    finally { $('#btn-extract').disabled = false; setTimeout(() => setProgress(pr, null), 500); }
  });

  async function sha256hex(bytes) {
    try { const d = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { return null; }
  }
  async function renderExtract(r) {
    const rep = $('#ex-report'), cmp = $('#ex-cmp'), met = $('#ex-metrics'), dl = $('#ex-dl');
    dl.innerHTML = '';
    if (!r.ok) {
      rep.innerHTML = `<div class="msg err">${r.error}</div><p class="hint">Dicas: use o WAV original (sem reamostragem); compressões com corte de agudos destroem a banda alta; a banda ultrassônica não sobrevive a codecs.</p>`;
      cmp.innerHTML = '<div class="empty-state">nada recuperado</div>'; met.innerHTML = metric('status', 'falhou', 'bad'); return;
    }
    const h = r.header, df = h.fs / h.N, P = r.payload, C = r.container;
    const ber = P && P.rawBits ? P.bitErrors / P.rawBits : null;
    const sha = C && C.file && C.crcOk ? await sha256hex(C.file) : null;
    const kv = [
      ['beacon', `${(r.loc.B / h.fs).toFixed(4)} s · cópia ${r.loc.copy + 1}/2`],
      ['coerência do beacon', (r.loc.coherence * 100).toFixed(2) + ' %'],
      ['taxa de amostragem', h.fs + ' Hz' + (r.usedFs !== h.fs ? ` (lido a ${r.usedFs})` : '')],
      ['FFT de pintura N', `${h.N} · Δf ${df.toFixed(2)} Hz`],
      ['banda', `${fmtHz(h.k0 * df)} – ${fmtHz((h.k0 + h.rows - 1) * df)}`],
      ['grade', `${h.rows} linhas × ${h.cols} colunas · ${h.rpp} bin/linha`],
      ['coluna', `${h.L} amostras (${(h.L / h.fs * 1000).toFixed(1)} ms) · transição ${h.T}`],
      ['resolução recuperada', `${h.imgW}×${h.imgH}`],
      ['faixa dinâmica', h.DR + ' dB'],
      ['SNR na banda', r.snrDb.toFixed(1) + ' dB'],
      ['EVM dos pilotos', r.pilotEvmDb.toFixed(1) + ' dB'],
      ['modulação', h.modBits ? ['', 'BPSK', 'QPSK', '8-PSK'][h.modBits] : 'nenhuma (só visual)'],
    ];
    if (P) kv.push(
      ['ECC', `RS(255,${255 - h.nsym}) × ${P.blocks} blocos`],
      ['bits brutos', P.rawBits.toLocaleString('pt-BR')],
      ['BER pré-ECC', ber == null ? '—' : ber.toExponential(2)],
      ['bytes corrigidos', P.corrected.toLocaleString('pt-BR')],
      ['rasuras usadas', P.erasuresUsed.toLocaleString('pt-BR')],
      ['blocos irrecuperáveis', `<span class="${P.failed ? 'bad' : 'ok'}">${P.failed}</span>`],
    );
    if (C) kv.push(
      ['contêiner', C.ok ? `<span class="ok">${C.name} · ${C.mime}</span>` : `<span class="bad">${C.error || 'corrompido'}</span>`],
      ['integridade CRC32', C.crcOk ? '<span class="ok">✓ íntegro</span>' : '<span class="bad">✗ falhou</span>'],
    );
    if (sha) kv.push(['SHA-256', `<span style="word-break:break-all;font-size:10.5px">${sha}</span>`]);
    kv.push(['tempo', (r.ms / 1000).toFixed(2) + ' s']);
    for (const w of r.warn || []) kv.push(['aviso', `<span class="warn">${w}</span>`]);
    rep.innerHTML = '<dl class="kv">' + kv.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') + '</dl>';

    // imagens
    const boxes = [];
    const lc = M.lumaToCanvas(r.luma, r.w, r.hgt);
    boxes.push({ cap: 'LUMINÂNCIA · ESPECTRO', el: lc, pix: true });
    let fileImg = null;
    if (C && C.crcOk && /^image\//.test(C.mime)) {
      const url = URL.createObjectURL(new Blob([C.file], { type: C.mime }));
      fileImg = new Image(); fileImg.src = url; await fileImg.decode().catch(() => {});
      boxes.push({ cap: (C.flags & 1 ? 'ARQUIVO RECODIFICADO' : 'ARQUIVO ORIGINAL BIT-A-BIT') + ` · ${C.origW}×${C.origH}`, el: fileImg });
    }
    // referência para comparação
    let refLuma = null, refLabel = '', refBytes = null, refImg = null;
    if (S.exOrig) {
      refImg = S.exOrig; refBytes = S.exOrig.bytes; refLabel = 'ORIGINAL (carregado)';
      const Y = M.imageToLuma(S.exOrig, r.w, r.hgt, {}); refLuma = new Uint8ClampedArray(Y.length); for (let i = 0; i < Y.length; i++) refLuma[i] = Math.round(Y[i] * 255);
    } else if (S.encoded && S.encoded.plan.w === r.w && S.encoded.plan.h === r.hgt && S.encoded.seed === h.seed) {
      refImg = S.encoded.img; refBytes = S.encoded.img.bytes; refLabel = 'LUMA EMBUTIDA (sessão)'; refLuma = S.encoded.luma8;
    }
    if (refImg) boxes.unshift({ cap: refLabel, el: Object.assign(new Image(), { src: refImg.url }) });
    if (refLuma) {
      const d = document.createElement('canvas'); d.width = r.w; d.height = r.hgt;
      const x = d.getContext('2d'), im = x.createImageData(r.w, r.hgt), map = SPX.colormaps.MAPS.thermal;
      for (let i = 0; i < refLuma.length; i++) { const k = Math.min(255, Math.abs(refLuma[i] - r.luma[i]) * 8) * 3; im.data[i * 4] = map[k]; im.data[i * 4 + 1] = map[k + 1]; im.data[i * 4 + 2] = map[k + 2]; im.data[i * 4 + 3] = 255; }
      x.putImageData(im, 0, 0);
      boxes.push({ cap: 'DIFERENÇA ×8', el: d, pix: true });
    }
    cmp.innerHTML = '';
    for (const b of boxes) { const box = document.createElement('div'); box.className = 'imgbox' + (b.pix ? ' pix' : ''); box.append(b.el); box.insertAdjacentHTML('beforeend', `<span class="cap">${b.cap}</span>`); cmp.append(box); }

    // downloads
    const bL = document.createElement('button'); bL.className = 'btn sm'; bL.textContent = '⤓ luma PNG';
    bL.onclick = async () => download(await M.canvasToBlob(lc, 'image/png'), 'spectrum_luma_' + r.w + 'x' + r.hgt + '.png');
    dl.append(bL);
    if (C && C.crcOk) { const b = document.createElement('button'); b.className = 'btn sm primary'; b.textContent = '⤓ ' + C.name; b.onclick = () => download(C.file, C.name, C.mime); dl.append(b); }

    // métricas
    const ms = [];
    ms.push(metric('status', C && C.crcOk ? 'arquivo íntegro' : h.modBits ? (C ? 'payload corrompido' : 'sem payload') : 'visual', C && C.crcOk ? '' : h.modBits ? 'bad' : 'warn'));
    if (refLuma) {
      const p = M.psnr(refLuma, r.luma), ss = M.ssim(refLuma, r.luma, r.w, r.hgt);
      ms.push(metric('PSNR luma', isFinite(p) ? p.toFixed(2) : '∞', p < 30 ? 'warn' : '', 'dB'));
      ms.push(metric('SSIM luma', ss.toFixed(4), ss < 0.9 ? 'warn' : ''));
    }
    if (refBytes && C && C.crcOk) {
      const same = refBytes.length === C.file.length && refBytes.every((v, i) => v === C.file[i]);
      ms.push(metric('arquivo vs original', same ? 'idêntico' : (C.flags & 1 ? 'recodificado' : 'difere'), same ? '' : 'warn'));
    }
    if (ber != null) ms.push(metric('BER pré-ECC', ber ? ber.toExponential(1) : '0', ber > 0.02 ? 'warn' : ''));
    ms.push(metric('SNR banda', r.snrDb.toFixed(1), r.snrDb < 15 ? 'warn' : '', 'dB'));
    ms.push(metric('resolução', `${r.w}×${r.hgt}`));
    met.innerHTML = ms.join('');
  }

  // =================================================================
  //  04 · LABORATÓRIO
  // =================================================================
  const DEFAULT_TESTS = ['ref', 'q16', 'gain', 'crop', 'noise40', 'noise25', 'echo', 'lp16', 'mp3_320', 'mp3_128', 'opus_64', 'resample'];
  $('#lab-tests').innerHTML = Object.entries(SPX.lab.TESTS).map(([k, t]) =>
    `<label class="check"><input type="checkbox" data-test="${k}" ${DEFAULT_TESTS.includes(k) ? 'checked' : ''}> ${t.label}</label>`).join('');
  let labStop = false;
  $('#btn-lab-stop').addEventListener('click', () => { labStop = true; labW.restart(); log($('#lab-log'), 'interrompido'); setProgress($('#lab-progress'), null); $('#btn-lab').disabled = false; });

  function labRow(r) {
    const thumb = r.luma ? M.lumaToCanvas(r.luma, r.w, r.h) : null;
    let ps = '—';
    if (r.luma && S.encoded && S.encoded.plan.w === r.w && S.encoded.plan.h === r.h) { const p = M.psnr(S.encoded.luma8, r.luma); ps = isFinite(p) ? p.toFixed(1) + ' dB' : '∞'; }
    const P = r.payload, ber = P && P.rawBits ? P.bitErrors / P.rawBits : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.label}</td><td>${r.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td>
      <td class="num">${r.ok ? r.snrDb.toFixed(1) + ' dB' : '—'}</td>
      <td class="num">${ber == null ? '—' : P.failed ? '&gt;' + ber.toExponential(1) : ber.toExponential(1)}</td>
      <td class="num">${P ? P.corrected : '—'}</td>
      <td class="num ${P && P.failed ? 'bad' : ''}">${P ? P.failed + '/' + P.blocks : '—'}</td>
      <td>${!P ? '<span class="mut">n/a</span>' : r.containerOk ? '<span class="ok">íntegro</span>' : '<span class="bad">perdido</span>'}</td>
      <td class="num">${ps}</td><td></td>`;
    if (thumb) { thumb.style.cssText = 'height:34px;image-rendering:pixelated;border:1px solid var(--line);border-radius:2px;display:block'; tr.lastElementChild.append(thumb); }
    return tr;
  }
  $('#btn-lab').addEventListener('click', async () => {
    if (!S.encoded) { toast('Codifique uma imagem primeiro (aba 01).', true); return; }
    const tests = $$('#lab-tests input:checked').map(i => i.dataset.test);
    const opus = $('#lab-opus').checked;
    const mp3s = [[320, '#lab-mp3-320'], [128, '#lab-mp3-128']].filter(([, id]) => $(id).checked).map(([k]) => k);
    if (!tests.length && !opus && !mp3s.length) { toast('Selecione ao menos um teste.', true); return; }
    labStop = false; $('#btn-lab').disabled = true;
    const tb = $('#lab-table tbody'); tb.innerHTML = '';
    const pr = $('#lab-progress'), el = $('#lab-log'), E = S.encoded;
    const total = tests.length + mp3s.length + (opus ? 1 : 0);
    try {
      for (let i = 0; i < tests.length && !labStop; i++) {
        log(el, `[${i + 1}/${total}] ${SPX.lab.TESTS[tests[i]].label}…`, true);
        setProgress(pr, i / total);
        const copy = E.channels.map(c => new Float32Array(c));
        const r = await labW.call('lab', { test: tests[i], channels: copy, fs: E.fs }, copy.map(c => c.buffer));
        tb.append(labRow(r));
      }
      for (let i = 0; i < mp3s.length && !labStop; i++) {
        const kbps = mp3s[i], label = `MP3 REAL ${kbps} kbps (LAME)`;
        log(el, `[${tests.length + i + 1}/${total}] ${label}…`, true);
        setProgress(pr, (tests.length + i) / total);
        if (!SPX.mp3.supported(E.fs)) { tb.append(labRow({ label: label + ` — indisponível a ${E.fs} Hz`, ok: false })); continue; }
        try {
          const mp3 = await labW.call('mp3', { channels: E.channels.map(c => new Float32Array(c)), fs: E.fs, kbps });
          const ch = (await M.decodeAudioTo(mp3.buffer, E.fs)).channels;
          const r = await labW.call('decode', { channels: ch, fs: E.fs }, ch.map(c => c.buffer));
          tb.append(labRow({ label, ok: r.ok, snrDb: r.snrDb, payload: r.payload, containerOk: !!(r.container && r.container.ok), luma: r.luma, w: r.w, h: r.hgt }));
        } catch (e) { if (labStop) break; tb.append(labRow({ label: label + ' — ' + e.message, ok: false })); }
      }
      if (opus && !labStop) {
        log(el, `[${total}/${total}] Opus real (MediaRecorder, ${(E.channels[0].length / E.fs).toFixed(0)} s em tempo real)…`, true);
        setProgress(pr, tests.length / total);
        try {
          const ch = await opusRoundTrip(E.channels, E.fs, 96);
          const r = await jobW.call('decode', { channels: ch, fs: E.fs });
          tb.append(labRow({ label: 'Opus REAL 96 kbps (navegador)', ok: r.ok, snrDb: r.snrDb, payload: r.payload, containerOk: !!(r.container && r.container.ok), luma: r.luma, w: r.w, h: r.hgt }));
        } catch (e) { tb.append(labRow({ label: 'Opus REAL — ' + e.message, ok: false })); }
      }
      setProgress(pr, 1); log(el, labStop ? 'interrompido' : '✓ testes concluídos');
    } catch (e) { if (!labStop) { toast(e.message, true); log(el, '✗ ' + e.message); } }
    finally { $('#btn-lab').disabled = false; setTimeout(() => setProgress(pr, null), 500); }
  });

  /** Ida e volta por um codificador Opus REAL (MediaRecorder), em tempo real. */
  async function opusRoundTrip(channels, fs, kbps) {
    if (!window.MediaRecorder) throw new Error('MediaRecorder indisponível');
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('Opus não suportado pelo MediaRecorder');
    const ctx = new AudioContext({ sampleRate: 48000 });
    const buf = ctx.createBuffer(channels.length, channels[0].length, fs);
    channels.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf;
    const dest = ctx.createMediaStreamDestination(); dest.channelCount = channels.length; src.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: kbps * 1000 });
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise(res => rec.onstop = res);
    await ctx.resume(); rec.start(250); src.start();
    await new Promise(res => src.onended = res);
    await new Promise(res => setTimeout(res, 400)); rec.stop(); await done; ctx.close();
    const ab = await new Blob(chunks, { type: mime }).arrayBuffer();
    return (await M.decodeAudioTo(ab, fs)).channels;
  }

  function renderLabMetrics() {
    const E = S.encoded, el = $('#lab-metrics');
    if (!E) { el.innerHTML = '<dt>nenhuma codificação nesta sessão</dt><dd></dd>'; return; }
    const P = E.plan, st = E.stats;
    const bitsPerSec = P.modBits ? (P.dataCells * P.modBits) / ((P.gridEnd - P.gridStart) / P.fs) : 0;
    const rows = [
      ['amostragem · canais', `${E.fs} Hz · ${st.channels}`],
      ['FFT de pintura N', `${P.N} (Δf = ${P.df.toFixed(2)} Hz)`],
      ['célula Δf × Δt', `${P.df.toFixed(2)} Hz × ${(P.colSeconds * 1000).toFixed(1)} ms = ${(P.df * P.colSeconds).toFixed(2)}`],
      ['transição / margem', `${P.T} / ${P.margin} amostras`],
      ['linhas · rpp · colunas', `${P.rows} · ${P.rpp} · ${P.cols} (+${P.P} preâmbulo)`],
      ['banda', `${fmtHz(P.fLow)} – ${fmtHz(P.fHigh)}`],
      ['início da grade', `${(P.gridStart / P.fs).toFixed(3)} s`],
      ['células de dados', P.dataCells.toLocaleString('pt-BR')],
      ['taxa bruta (fase)', P.modBits ? (bitsPerSec / 1000).toFixed(2) + ' kbit/s' : '—'],
      ['capacidade útil', P.modBits ? U.fmtBytes(P.payloadCapacity) : '—'],
      ['payload gravado', E.pay ? `${U.fmtBytes(E.pay.container.length)} · ${E.pay.desc}` : '—'],
      ['nível embutido', st.embedToHostDb != null ? st.embedToHostDb.toFixed(1) + ' dB rel. host' : st.layerRmsDb.toFixed(1) + ' dBFS RMS'],
      ['host na banda (carving)', st.hostCarved ? 'removido' : 'mantido'],
      ['pico / limitador', `${st.peakDb.toFixed(1)} dBFS / ${st.limiterDb.toFixed(1)} dB`],
      ['semente', '0x' + (E.seed >>> 0).toString(16).toUpperCase()],
      ['arquivos gerados', Object.entries(E.exports).map(([k, b]) => `${k} ${U.fmtBytes(b.size)}`).join(' · ') || '—'],
      ['original', E.srcBytes ? `${E.srcLabel} · ${U.fmtBytes(E.srcBytes)}` : '—'],
    ];
    el.innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
  }

  // ------------------------------------------------------------- init
  syncLabels(); computePlan(); renderPreviewPlan();
  M.sample('testcard').then(setImage).catch(() => {});
})();
