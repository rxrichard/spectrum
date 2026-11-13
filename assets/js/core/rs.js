/* =====================================================================
 * SPECTRUM v2 — core/rs.js
 * Reed–Solomon sobre GF(2^8) (polinômio primitivo 0x11D, fcr = 0).
 * Código sistemático RS(n ≤ 255, k = n − nsym): corrige até
 *   2·erros + rasuras ≤ nsym
 * Decodificador: síndromes → síndromes de Forney (remove rasuras) →
 * Berlekamp–Massey → busca de Chien → algoritmo de Forney.
 * Polinômios representados com o coeficiente de MAIOR grau primeiro.
 * ===================================================================== */
(self.SPX_MODULES = self.SPX_MODULES || []).push(function SPX_rs(SPX) {
  'use strict';
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function init() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  const div = (a, b) => { if (b === 0) throw new Error('GF div 0'); return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]; };
  const pow = (a, p) => EXP[(((LOG[a] * p) % 255) + 255) % 255];
  const inv = (a) => EXP[255 - LOG[a]];

  function polyScale(p, x) { const r = new Array(p.length); for (let i = 0; i < p.length; i++) r[i] = mul(p[i], x); return r; }
  function polyAdd(p, q) {
    const n = Math.max(p.length, q.length), r = new Array(n).fill(0);
    for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
    return r;
  }
  function polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  }
  function polyEval(p, x) { let y = p[0]; for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i]; return y; }
  function polyDivRem(dividend, divisor) {
    const out = dividend.slice();
    for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
      const c = out[i];
      if (c !== 0) for (let j = 1; j < divisor.length; j++) if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], c);
    }
    return out.slice(out.length - (divisor.length - 1));
  }

  const genCache = new Map();
  function generator(nsym) {
    let g = genCache.get(nsym);
    if (g) return g;
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    genCache.set(nsym, g);
    return g;
  }

  /** Codifica msg (≤ 255−nsym bytes) → Uint8Array(msg + paridade). */
  function encode(msg, nsym) {
    if (msg.length + nsym > 255) throw new Error('RS: bloco grande demais');
    const g = generator(nsym);
    const out = new Uint8Array(msg.length + nsym);
    out.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c !== 0) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], c);
    }
    out.set(msg); // restaura parte sistemática
    return out;
  }

  function syndromes(msg, nsym) {
    const s = new Array(nsym + 1).fill(0); // s[0] = 0 (padding, convenção)
    for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, pow(2, i));
    return s;
  }
  function forneySyndromes(synd, pos, n) {
    const fs = synd.slice(1);
    for (let i = 0; i < pos.length; i++) {
      const x = pow(2, n - 1 - pos[i]);
      for (let j = 0; j < fs.length - 1; j++) fs[j] = mul(fs[j], x) ^ fs[j + 1];
    }
    return fs;
  }
  function errorLocator(synd, nsym, eraseCount) {
    let errLoc = [1], oldLoc = [1];
    const shift = synd.length > nsym ? synd.length - nsym : 0;
    for (let i = 0; i < nsym - eraseCount; i++) {
      const K = i + shift; // síndromes de Forney já descontam as rasuras
      let delta = synd[K];
      for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, inv(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    const errs = errLoc.length - 1;
    if (errs * 2 + eraseCount > nsym) throw new Error('RS: erros demais');
    return errLoc;
  }
  function findErrors(errLocRev, n) {
    const errs = errLocRev.length - 1, pos = [];
    for (let i = 0; i < n; i++) if (polyEval(errLocRev, pow(2, i)) === 0) pos.push(n - 1 - i);
    if (pos.length !== errs) throw new Error('RS: localização falhou');
    return pos;
  }
  function correctErrata(msg, synd, errPos) {
    const coefPos = errPos.map(p => msg.length - 1 - p);
    let eLoc = [1];
    for (const c of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [pow(2, c), 0]));
    const sRev = synd.slice().reverse();
    const prod = polyMul(sRev, eLoc);
    const divisor = [1].concat(new Array(eLoc.length).fill(0)); // x^(nsym+1) truncado ao grau do localizador
    const evalRev = polyDivRem(prod, divisor); // avaliador de erros Ω(x)
    const X = coefPos.map(c => pow(2, -(255 - c)));
    const E = new Array(msg.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const Xi = X[i], XiInv = inv(Xi);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(XiInv, X[j]));
      if (prime === 0) throw new Error('RS: Forney falhou');
      let y = polyEval(evalRev, XiInv);
      y = mul(Xi, y);
      E[errPos[i]] = div(y, prime);
    }
    const out = msg.slice();
    for (let i = 0; i < out.length; i++) out[i] ^= E[i];
    return out;
  }

  /**
   * Decodifica um bloco. erasures = posições suspeitas (opcional).
   * Retorna { data, corrected } ou lança erro se irrecuperável.
   */
  function decode(block, nsym, erasures) {
    let msg = Array.from(block);
    const er = erasures && erasures.length ? erasures.slice(0, nsym) : [];
    for (const e of er) msg[e] = 0;
    let synd = syndromes(msg, nsym);
    let any = false; for (let i = 1; i < synd.length; i++) if (synd[i]) { any = true; break; }
    if (!any) {
      let c = 0; for (let i = 0; i < block.length; i++) if (block[i] !== msg[i]) c++;
      return { data: Uint8Array.from(msg.slice(0, msg.length - nsym)), corrected: c };
    }
    const fsynd = forneySyndromes(synd, er, msg.length);
    const errLoc = errorLocator(fsynd, nsym, er.length);
    const errPos = findErrors(errLoc.slice().reverse(), msg.length);
    const all = er.concat(errPos.filter(p => er.indexOf(p) < 0));
    msg = correctErrata(msg, synd, all);
    synd = syndromes(msg, nsym);
    for (let i = 1; i < synd.length; i++) if (synd[i]) throw new Error('RS: verificação final falhou');
    let c = 0; for (let i = 0; i < block.length; i++) if (block[i] !== msg[i]) c++;
    return { data: Uint8Array.from(msg.slice(0, msg.length - nsym)), corrected: c };
  }

  SPX.rs = { encode, decode, gf: { mul, div, pow, inv } };
});
