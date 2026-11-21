import { address, isAddress, createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';

// PublicNode allows browser (CORS) access; api.mainnet-beta.solana.com returns 403 to browsers.
const rpc = createSolanaRpc('https://solana-rpc.publicnode.com');
const subs = createSolanaRpcSubscriptions('wss://solana-rpc.publicnode.com');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// PublicNode only keeps recent history. Wallet history goes through the Vite proxy
// (/rpc → api.mainnet-beta, see vite.config.ts), with PublicNode as the fallback.
const archive = createSolanaRpc(`${location.origin}/rpc`);

const $ = (id: string) => document.getElementById(id)!;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

// ---------- music theory ----------
const SCALES: Record<string, number[]> = {
  minorPent: [0, 3, 5, 7, 10], majorPent: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], hirajoshi: [0, 2, 3, 7, 8],
};
let scale = SCALES.minorPent;
const ROOT = 110; // A2
const RANGE = () => scale.length * 3;
const freqOf = (idx: number) => ROOT * 2 ** ((Math.floor(idx / scale.length) * 12 + scale[idx % scale.length]) / 12);
const WAVES: OscillatorType[] = ['triangle', 'sine', 'sawtooth'];

type Voice = { base: number; steps: number[]; wave: OscillatorType; color: string };
const voiceCache = new Map<string, Voice>();
function voiceOf(leader: string): Voice {
  let v = voiceCache.get(leader);
  if (v) return v;
  const h = hash(leader);
  const steps = [0]; let c = 0;
  for (let i = 1; i < 4; i++) { c += ((h >>> (i * 5)) % 5) - 2; steps.push(c); }
  v = { base: h % 7 + 3, steps, wave: WAVES[(h >>> 23) % 3], color: `hsl(${h % 360} 65% 66%)` };
  voiceCache.set(leader, v);
  return v;
}
const pitchIdx = (v: Voice, slot: bigint) => clamp(v.base + v.steps[Number(slot % 4n)] + scale.length - 2, 0, RANGE() - 1);

// ---------- audio engine (pure Web Audio, no samples) ----------
let ac: AudioContext | null = null;
let bus: GainNode, master: GainNode, padFilter: BiquadFilterNode, noiseBuf: AudioBuffer;
let playing = false;

function initAudio() {
  ac = new AudioContext();
  master = ac.createGain(); master.gain.value = Number(($('vol') as HTMLInputElement).value);
  const comp = ac.createDynamicsCompressor();
  master.connect(comp).connect(ac.destination);

  const verb = ac.createConvolver();
  const len = ac.sampleRate * 3, ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  verb.buffer = ir;
  const wet = ac.createGain(); wet.gain.value = 0.35; verb.connect(wet).connect(master);

  const dly = ac.createDelay(1); dly.delayTime.value = 0.3;
  const fb = ac.createGain(); fb.gain.value = 0.32; dly.connect(fb).connect(dly);
  const dWet = ac.createGain(); dWet.gain.value = 0.22; dly.connect(dWet).connect(master);

  bus = ac.createGain(); bus.connect(master); bus.connect(verb); bus.connect(dly);

  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // bass pad: root + fifth + octave, filter opened by network TPS
  padFilter = ac.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 300; padFilter.Q.value = 2;
  const padGain = ac.createGain(); padGain.gain.value = 0.05;
  padFilter.connect(padGain); padGain.connect(master); padGain.connect(verb);
  [ROOT / 2, ROOT / 2 * 1.498, ROOT].forEach((f, i) => {
    for (const det of [-6, 6]) { const o = ac!.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det + i; o.connect(padFilter); o.start(); }
  });
  const lfo = ac.createOscillator(); lfo.frequency.value = 0.07; const lg = ac.createGain(); lg.gain.value = 120; lfo.connect(lg).connect(padFilter.frequency); lfo.start();
}

function pluck(freq: number, wave: OscillatorType, vel = 0.22) {
  if (!ac || !playing) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = wave; o.frequency.value = freq;
  const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
  const g2 = ac.createGain(); g2.gain.value = 0.18;
  const f = ac.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.setValueAtTime(Math.min(freq * 8, 12000), t); f.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.5);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(wave === 'sawtooth' ? vel * 0.6 : vel, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
  o.connect(f); o2.connect(g2).connect(f); f.connect(g).connect(bus);
  o.start(t); o2.start(t); o.stop(t + 1.5); o2.stop(t + 1.5);
}

function kick() {
  if (!ac || !playing) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  const g = ac.createGain(); g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.4);
}

function hat(fail: boolean) {
  if (!ac || !playing || !percussion) return;
  const t = ac.currentTime;
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const f = ac.createBiquadFilter(); f.type = fail ? 'bandpass' : 'highpass'; f.frequency.value = fail ? 1900 : 8500;
  const g = ac.createGain(); const v = fail ? 0.22 : 0.05, d = fail ? 0.16 : 0.04;
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(f).connect(g).connect(master); src.start(t, Math.random() * 0.5); src.stop(t + d + 0.02);
}

function thud() {
  if (!ac || !playing) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.6);
  const g = ac.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(g).connect(master); o.start(t); o.stop(t + 1);
  // dissonant minor-second cluster
  for (const f of [ROOT * 2, ROOT * 2 * 2 ** (1 / 12), ROOT * 2 * 2 ** (6 / 12)]) {
    const s = ac.createOscillator(); s.type = 'square'; s.frequency.value = f;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const sg = ac.createGain(); sg.gain.setValueAtTime(0.05, t); sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    s.connect(lp).connect(sg).connect(bus); s.start(t); s.stop(t + 1.2);
  }
}

// ---------- chain data ----------
const leaders = new Map<bigint, string>();
let fetchingLeaders = false;
async function ensureLeaders(from: bigint) {
  if (fetchingLeaders || leaders.has(from + 24n)) return;
  fetchingLeaders = true;
  try { (await rpc.getSlotLeaders(from, 120).send()).forEach((l, i) => leaders.set(from + BigInt(i), l)); } catch {}
  fetchingLeaders = false;
}
const leaderOf = (slot: bigint) => leaders.get(slot) ?? `window-${slot / 4n}`;

let lastSlot = 0n, lastArrive = 0, avgSlotMs = 400;
const queue: bigint[] = [];
function onSlot(slot: bigint) {
  if (slot <= lastSlot) return;
  const now = performance.now();
  if (lastSlot) {
    const gap = slot - lastSlot;
    avgSlotMs = clamp(avgSlotMs * 0.9 + ((now - lastArrive) / Number(gap)) * 0.1, 250, 900);
    if (gap < 12n) for (let s = lastSlot + 1n; s < slot; s++) queue.push(s);
  }
  queue.push(slot);
  lastSlot = slot; lastArrive = now;
  if (!skipCursor) skipCursor = slot - 60n;
  void ensureLeaders(slot);
}

async function streamSlots() {
  try {
    const it = await subs.slotNotifications().subscribe({ abortSignal: new AbortController().signal });
    setStatus(true, 'live · mainnet');
    for await (const n of it) onSlot(n.slot);
  } catch {}
  setStatus(true, 'live · mainnet (polling)');
  setInterval(async () => { try { onSlot(await rpc.getSlot({ commitment: 'processed' }).send()); } catch {} }, 400);
}
function setStatus(live: boolean, text: string) { $('status').classList.toggle('live', live); $('statusText').textContent = text; }

// ---------- conductor: plays queued slots on a steady clock ----------
type Note = { slot: bigint; t: number; idx: number; color: string; skipped: boolean; bar: boolean };
type Tick = { t: number; fail: boolean; y: number };
const notes: Note[] = [];
const noteBySlot = new Map<bigint, Note>();
const ticks: Tick[] = [];
const heard = new Set<string>();
let curLeader = '';
let skips = 0, txPlayed = 0;

function conduct() {
  if (queue.length > 10) queue.splice(0, queue.length - 4);
  const slot = queue.shift();
  if (slot !== undefined) playSlot(slot);
  setTimeout(conduct, queue.length > 3 ? avgSlotMs * 0.8 : avgSlotMs);
}

function playSlot(slot: bigint) {
  $('slot').textContent = fmt(Number(slot));
  if (walletMode) return; // live chain goes quiet while a wallet is playing
  const leader = leaderOf(slot);
  const v = voiceOf(leader);
  const idx = pitchIdx(v, slot);
  const bar = leader !== curLeader;
  if (bar) { kick(); setLeader(leader, v); }
  pluck(freqOf(idx), v.wave);
  const n: Note = { slot, t: performance.now(), idx, color: v.color, skipped: false, bar };
  notes.push(n); noteBySlot.set(slot, n);
  if (notes.length > 300) noteBySlot.delete(notes.shift()!.slot);
  if (!leader.startsWith('window-')) heard.add(leader);
  $('slot').textContent = fmt(Number(slot));
  $('bpm').textContent = fmt(60000 / avgSlotMs);
  $('vals').textContent = fmt(heard.size);
  const step = Number(slot % 4n);
  $('motif').querySelectorAll('div').forEach((d, i) => d.classList.toggle('on', i === step));
}

function setLeader(leader: string, v: Voice) {
  curLeader = leader;
  const real = !leader.startsWith('window-');
  $('leader').textContent = real ? short(leader) : 'resolving leader…';
  ($('leaderSw') as HTMLElement).style.background = v.color;
  const min = Math.min(...v.steps), max = Math.max(...v.steps);
  $('motif').innerHTML = v.steps.map((s) => `<div style="height:${20 + ((s - min) / Math.max(1, max - min)) * 80}%;background:${v.color}"></div>`).join('');
  $('voice').textContent = `${v.wave} voice · motif ${v.steps.map((s) => (s >= 0 ? '+' : '') + s).join(' ')}`;
}

// skipped-slot detector: finalized blocks vs. slots that elapsed
let skipCursor = 0n;
async function detectSkips() {
  try {
    const end = lastSlot - 48n;
    if (skipCursor && end > skipCursor) {
      const start = skipCursor + 1n;
      const to = end - start > 400n ? start + 400n : end;
      const blocks = new Set((await rpc.getBlocks(start, to).send()).map((b) => b));
      let found = 0;
      for (let s = start; s <= to; s++) if (!blocks.has(s)) { found++; const n = noteBySlot.get(s); if (n) n.skipped = true; }
      if (found) { skips += found; $('skips').textContent = fmt(skips); thud(); }
      skipCursor = to;
    }
  } catch {}
  setTimeout(detectSkips, 3000);
}

// token transactions → percussion
const seen = new Set<string>();
let primed = false, percussion = true;
async function pollTxs() {
  try {
    const sigs = await rpc.getSignaturesForAddress(TOKEN_PROGRAM, { limit: 40 }).send();
    const fresh = sigs.filter((s) => !seen.has(s.signature)).slice(0, 24);
    fresh.forEach((s) => seen.add(s.signature));
    if (seen.size > 4000) seen.clear();
    if (primed && !walletMode) fresh.forEach((s, i) => setTimeout(() => {
      if (walletMode) return;
      hat(!!s.err);
      ticks.push({ t: performance.now(), fail: !!s.err, y: Math.random() });
      txPlayed++; $('txs').textContent = fmt(txPlayed);
    }, (i * 2000) / fresh.length));
    primed = true;
  } catch {}
  setTimeout(pollTxs, 2000);
}

async function pollTps() {
  try {
    const [s] = await rpc.getRecentPerformanceSamples(1).send();
    if (s && s.samplePeriodSecs) {
      const tps = Number(s.numTransactions) / s.samplePeriodSecs;
      $('tps').textContent = fmt(tps);
      if (ac) padFilter.frequency.setTargetAtTime(200 + clamp(tps / 6000, 0, 1) * 1400, ac.currentTime, 2);
    }
  } catch {}
  setTimeout(pollTps, 20000);
}

// ---------- piano roll ----------
const canvas = $('roll') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
function draw() {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const now = performance.now(), speed = 0.11, head = w - 48;
  const top = 20, laneH = h - 90, tickTop = h - 52;
  const rows = RANGE(), rowH = laneH / rows;
  const yOf = (idx: number) => top + laneH - (idx + 1) * rowH;

  ctx.strokeStyle = '#18181b'; ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i++) { const y = Math.round(top + i * rowH) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = '#27272a'; ctx.beginPath(); ctx.moveTo(0, tickTop - 8.5); ctx.lineTo(w, tickTop - 8.5); ctx.stroke();

  const noteW = Math.max(6, avgSlotMs * speed - 4);
  for (const n of notes) {
    const x = head - (now - n.t) * speed;
    if (x < -noteW) continue;
    if (n.bar) { ctx.fillStyle = '#27272a'; ctx.fillRect(Math.round(x) - 3, top, 1, h - top - 10); }
    const y = yOf(n.idx) + 1, age = now - n.t;
    ctx.beginPath(); ctx.roundRect(x, y, noteW, Math.max(4, rowH - 2), 3);
    if (n.skipped) { ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 1.5; ctx.stroke(); }
    else {
      ctx.fillStyle = n.color;
      if (age < 500) { ctx.shadowColor = n.color; ctx.shadowBlur = 16 * (1 - age / 500); }
      ctx.fill(); ctx.shadowBlur = 0;
    }
  }
  for (const t of ticks) {
    const x = head - (now - t.t) * speed;
    if (x < -6) continue;
    ctx.fillStyle = t.fail ? '#f43f5e' : '#d4d4d8';
    ctx.beginPath(); ctx.arc(x, tickTop + t.y * 30, t.fail ? 3.5 : 2, 0, Math.PI * 2); ctx.fill();
  }
  while (ticks.length && head - (now - ticks[0].t) * speed < -10) ticks.shift();

  ctx.fillStyle = '#3f3f46'; ctx.fillRect(head + noteW + 4, top, 1, h - top - 10);
  ctx.fillStyle = '#71717a'; ctx.font = '11px "Geist Mono", monospace';
  ctx.fillText('NOW', head + noteW + 10, top + 10);
  if (!lastSlot) { ctx.fillStyle = '#a1a1aa'; ctx.font = '14px Geist, sans-serif'; ctx.fillText('Tuning in to Solana mainnet…', 24, h / 2); }
  requestAnimationFrame(draw);
}

// ---------- controls ----------
const playBtn = $('play') as HTMLButtonElement;
async function setPlaying(on: boolean) {
  if (!ac) initAudio();
  playing = on;
  if (on) await ac!.resume(); else await ac!.suspend();
  playBtn.textContent = on ? '❚❚ Pause' : '▶ Start listening';
  playBtn.classList.toggle('on', on);
}
playBtn.onclick = () => void setPlaying(!playing);

// ---------- wallet player ----------
let walletMode = false;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const prices = new Map<string, number>();
const usdFmt = (n: number, sign = true) => `${sign ? (n < 0 ? '-' : n > 0 ? '+' : '') : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0, minimumFractionDigits: Math.abs(n) < 10 ? 2 : 0 })}`;
const ago = (s: number) => (s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`) + ' ago';

// Jupiter price API (CORS-enabled) prices SOL and every SPL token
async function fetchPrices(mints: string[]) {
  const need = [...new Set([SOL_MINT, ...mints])].filter((m) => !prices.has(m));
  for (let i = 0; i < need.length; i += 50) {
    try {
      const r = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${need.slice(i, i + 50).join(',')}`)).json();
      for (const [m, v] of Object.entries<any>(r)) if (v?.usdPrice) prices.set(m, Number(v.usdPrice));
    } catch {}
  }
}
const solUsd = () => prices.get(SOL_MINT) ?? 0;

type Kind = 'in' | 'out' | 'swap' | 'fee';
type Delta = { mint: string; amt: number };
type WTx = { sig: string; time: number; sol: number; deltas: Delta[]; inUsd: number; outUsd: number; kind: Kind };

async function loadWallet(who: string): Promise<{ txs: WTx[]; failed: number }> {
  let src = archive;
  let all;
  try { all = await archive.getSignaturesForAddress(address(who), { limit: 100 }).send(); }
  catch { src = rpc; all = await rpc.getSignaturesForAddress(address(who), { limit: 100 }).send(); }
  const ok = all.filter((s) => !s.err).slice(0, 30);
  const failed = all.slice(0, all.indexOf(ok[ok.length - 1]) + 1).filter((s) => s.err).length;
  const raw: { sig: string; time: number; sol: number; deltas: Delta[] }[] = [];
  for (let i = 0; i < ok.length; i += 6) {
    const batch = ok.slice(i, i + 6);
    $('wsummary').innerHTML = `<span class="muted">Reading transaction ${i + 1}–${i + batch.length} of ${ok.length}…</span>`;
    const get = (s: (typeof batch)[number]) => src.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 as 0, encoding: 'json' }).send();
    const txs = await Promise.all(batch.map((s) => get(s).catch(() => sleep(600).then(() => get(s))).catch(() => null)));
    txs.forEach((tx, j) => {
      let sol = 0; const deltas: Delta[] = [];
      const meta = tx?.meta;
      if (tx && meta) {
        const keys: string[] = [...tx.transaction.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
        const k = keys.indexOf(who);
        if (k >= 0) sol = (Number(meta.postBalances[k]) - Number(meta.preBalances[k])) / 1e9;
        const pre = meta.preTokenBalances ?? [], post = meta.postTokenBalances ?? [];
        const byMint = new Map<string, number>();
        new Set([...pre, ...post].filter((b) => b.owner === who).map((b) => b.accountIndex)).forEach((ai) => {
          const a = pre.find((b) => b.accountIndex === ai), b = post.find((x) => x.accountIndex === ai);
          const d = Number(b?.uiTokenAmount.uiAmountString ?? 0) - Number(a?.uiTokenAmount.uiAmountString ?? 0);
          const mint = (b ?? a)!.mint;
          if (d) byMint.set(mint, (byMint.get(mint) ?? 0) + d);
        });
        byMint.forEach((amt, mint) => deltas.push({ mint, amt }));
      }
      raw.push({ sig: batch[j].signature, time: Number(batch[j].blockTime ?? 0), sol, deltas });
    });
  }
  await fetchPrices(raw.flatMap((r) => r.deltas.map((d) => d.mint)));
  const txs = raw.map((r) => {
    let inUsd = 0, outUsd = 0;
    // ignore SOL dust (tx fees, rent) so fees don't count as "money out"
    const solV = Math.abs(r.sol) > 0.002 ? r.sol * solUsd() : 0;
    for (const v of [solV, ...r.deltas.map((d) => d.amt * (prices.get(d.mint) ?? 0))]) { if (v > 0) inUsd += v; else outUsd -= v; }
    const kind: Kind = inUsd > 0.5 && outUsd > 0.5 ? 'swap' : inUsd > 0.01 ? 'in' : outUsd > 0.01 ? 'out' : 'fee';
    return { ...r, inUsd, outUsd, kind };
  });
  return { txs: txs.reverse(), failed }; // oldest → newest
}

const KCOLOR: Record<Kind, string> = { in: '#14f195', out: '#f43f5e', swap: '#a78bfa', fee: '#52525b' };
const headline = (t: WTx) =>
  t.kind === 'swap' ? `⇄ ${usdFmt(Math.max(t.inUsd, t.outUsd), false)}` : t.kind === 'in' ? usdFmt(t.inUsd) : t.kind === 'out' ? usdFmt(-t.outUsd) : '$0.00';
const kindLabel = (t: WTx) => ({ in: 'received', out: 'sent', swap: 'swap', fee: 'fee only / no value moved' })[t.kind];
const deltaText = (t: WTx) => {
  const parts: string[] = [];
  if (Math.abs(t.sol) > 0.002) parts.push(`${t.sol > 0 ? '+' : ''}${t.sol.toFixed(3)} SOL`);
  t.deltas.slice(0, 2).forEach((d) => parts.push(`${d.amt > 0 ? '+' : ''}${fmtAmt(d.amt)} ${short(d.mint).slice(0, 4)}`));
  if (t.deltas.length > 2) parts.push(`+${t.deltas.length - 2} more`);
  return parts.join(' · ');
};
const fmtAmt = (n: number) => Math.abs(n) >= 1000 ? fmt(n) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(3);

function renderWallet(txs: WTx[], failed: number) {
  const nowS = Date.now() / 1000;
  const vol = txs.reduce((a, t) => a + Math.max(t.inUsd, t.outUsd), 0);
  const net = txs.reduce((a, t) => a + t.inUsd - t.outUsd, 0);
  const biggest = txs.reduce((m, t) => (Math.max(t.inUsd, t.outUsd) > Math.max(m.inUsd, m.outUsd) ? t : m), txs[0]);
  const swaps = txs.filter((t) => t.kind === 'swap').length;
  $('wsummary').innerHTML = txs.length ? `
    <div><div class="label">Volume played</div><div class="num">${usdFmt(vol, false)}</div></div>
    <div><div class="label">Net flow</div><div class="num" style="color:${net >= 0 ? 'var(--accent)' : 'var(--red)'}">${usdFmt(net)}</div></div>
    <div><div class="label">Biggest move</div><div class="num">${headline(biggest)}</div></div>
    <div><div class="label">Swaps</div><div class="num">${swaps}</div></div>
    <div><div class="label">Failed (skipped)</div><div class="num">${failed}</div></div>
    <div><div class="label">SOL price</div><div class="num">$${fmt(solUsd())}</div></div>`
    : `<div class="err">No successful transactions found for this address.</div>`;
  $('wlist').innerHTML = txs.map((t) => `<div class="tx"><span style="color:${KCOLOR[t.kind]}">${{ in: '↓', out: '↑', swap: '⇄', fee: '·' }[t.kind]}</span>
      <span class="muted">${deltaText(t) || kindLabel(t)}</span><span class="r" style="color:${KCOLOR[t.kind]}">${headline(t)}</span>
      <span class="r muted hide-sm">${t.time ? ago(nowS - t.time) : ''}</span>
      <span class="r hide-sm"><a href="https://explorer.solana.com/tx/${t.sig}" target="_blank">${t.sig.slice(0, 6)}… ↗</a></span></div>`).join('');
}

// ---- wallet stage: lollipop timeline with a sweeping playhead ----
const STEP = 360;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let wanim: { txs: WTx[]; start: number; cur: number; pulses: number[] } | null = null;
let lastWalletTxs: WTx[] = [];

function walletNote(t: WTx) {
  const len = scale.length;
  const deg = (m: number) => clamp(Math.round(Math.log10(m + 0.01) * 1.6) + 3, 0, len * 2 - 1);
  const vel = (m: number) => clamp(0.12 + Math.log10(m + 1) * 0.07, 0.1, 0.5);
  if (t.kind === 'fee') return pluck(freqOf(len * 2 + 1), 'sine', 0.06);
  if (t.kind === 'in') pluck(freqOf(clamp(deg(t.inUsd) + len, 0, RANGE() - 1)), 'triangle', vel(t.inUsd));
  if (t.kind === 'out') pluck(freqOf(clamp(len * 2 - 1 - deg(t.outUsd), 0, RANGE() - 1)), 'sawtooth', vel(t.outUsd));
  if (t.kind === 'swap') {
    pluck(freqOf(clamp(len * 2 - 1 - deg(t.outUsd), 0, RANGE() - 1)), 'sawtooth', vel(t.outUsd));
    setTimeout(() => pluck(freqOf(clamp(deg(t.inUsd) + len, 0, RANGE() - 1)), 'triangle', vel(t.inUsd)), 110);
  }
  if (Math.max(t.inUsd, t.outUsd) >= 1000) kick();
}

function setNow(t: WTx, i: number, n: number) {
  const amt = $('wnowAmt');
  amt.textContent = headline(t);
  amt.style.color = KCOLOR[t.kind] === '#52525b' ? 'var(--muted)' : KCOLOR[t.kind];
  const parts = [kindLabel(t)];
  const d = deltaText(t); if (d) parts.push(d);
  if (t.time) parts.push(ago(Date.now() / 1000 - t.time));
  $('wnowSub').innerHTML = `${i + 1} / ${n} · ${parts.join(' · ')} · <a href="https://explorer.solana.com/tx/${t.sig}" target="_blank">view ↗</a>`;
}

async function playWallet(txs: WTx[]) {
  if (!txs.length || walletMode) return;
  walletMode = true;
  ($('wreplay') as HTMLButtonElement).disabled = true;
  wanim = { txs, start: performance.now(), cur: -1, pulses: txs.map(() => -1e9) };
  for (let i = 0; i < txs.length; i++) {
    wanim.cur = i; wanim.pulses[i] = performance.now();
    walletNote(txs[i]); setNow(txs[i], i, txs.length);
    await sleep(STEP);
  }
  await sleep(900);
  walletMode = false;
  ($('wreplay') as HTMLButtonElement).disabled = false;
}

const wc = $('wcanvas') as HTMLCanvasElement;
const wctx = wc.getContext('2d')!;
function drawWallet() {
  requestAnimationFrame(drawWallet);
  if (!wanim || $('wstage').hidden || !wanim.txs.length) return;
  const dpr = devicePixelRatio || 1, w = wc.clientWidth, h = wc.clientHeight;
  if (wc.width !== Math.round(w * dpr)) { wc.width = Math.round(w * dpr); wc.height = Math.round(h * dpr); }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  const { txs, start, cur, pulses } = wanim, n = txs.length, now = performance.now();
  const padX = 56, mid = h / 2, maxH = h / 2 - 34, span = w - padX * 2;
  const xOf = (i: number) => padX + (n === 1 ? span / 2 : (i / (n - 1)) * span);
  const maxM = Math.max(1, ...txs.map((t) => Math.max(t.inUsd, t.outUsd)));
  const hOf = (m: number) => 8 + (Math.log10(m + 1) / Math.log10(maxM + 1)) * maxH;
  const rOf = (m: number) => clamp(4 + Math.log10(m + 1) * 2.4, 4, 15);

  wctx.fillStyle = '#27272a'; wctx.fillRect(padX - 20, Math.round(mid), span + 40, 1);
  wctx.font = '11px "Geist Mono", monospace'; wctx.fillStyle = '#52525b';
  wctx.fillText('IN ↑', 12, mid - 10); wctx.fillText('OUT ↓', 12, mid + 20);

  const lolli = (x: number, y: number, r: number, color: string) => {
    wctx.strokeStyle = color; wctx.lineWidth = 2;
    wctx.beginPath(); wctx.moveTo(x, mid); wctx.lineTo(x, y); wctx.stroke();
    wctx.fillStyle = color; wctx.beginPath(); wctx.arc(x, y, r, 0, Math.PI * 2); wctx.fill();
  };
  txs.forEach((t, i) => {
    const x = xOf(i), color = KCOLOR[t.kind];
    wctx.globalAlpha = i <= cur ? 1 : 0.22;
    const ends: [number, number][] = [];
    if (t.kind === 'fee') { wctx.fillStyle = color; wctx.beginPath(); wctx.arc(x, mid, 3, 0, Math.PI * 2); wctx.fill(); ends.push([mid, 3]); }
    if (t.kind === 'in' || t.kind === 'swap') { const y = mid - hOf(t.inUsd), r = rOf(t.inUsd); lolli(x, y, r, color); ends.push([y, r]); }
    if (t.kind === 'out' || t.kind === 'swap') { const y = mid + hOf(t.outUsd), r = rOf(t.outUsd); lolli(x, y, r, color); ends.push([y, r]); }
    const age = now - pulses[i];
    if (age >= 0 && age < 800) {
      const k = age / 800;
      wctx.globalAlpha = 1 - k; wctx.strokeStyle = color; wctx.lineWidth = 2;
      for (const [y, r] of ends) { wctx.beginPath(); wctx.arc(x, y, r + k * 26, 0, Math.PI * 2); wctx.stroke(); }
    }
    wctx.globalAlpha = 1;
  });

  const px = padX + clamp((now - start) / STEP / Math.max(1, n - 1), 0, 1) * span;
  wctx.fillStyle = 'rgba(250,250,250,.55)'; wctx.fillRect(Math.round(px), 14, 1, h - 28);

  const d = (s: number) => (s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  wctx.fillStyle = '#71717a';
  wctx.fillText(d(txs[0].time), padX - 20, h - 10);
  const last = d(txs[n - 1].time); wctx.fillText(last, w - padX + 20 - wctx.measureText(last).width, h - 10);
}
requestAnimationFrame(drawWallet);

const wInput = $('waddr') as HTMLInputElement;
async function runWallet(who: string) {
  who = who.trim();
  if (!isAddress(who)) { $('wsummary').innerHTML = `<div class="err">That isn't a valid Solana address.</div>`; return; }
  if (walletMode) return;
  $('wlist').innerHTML = '';
  await setPlaying(true);
  try {
    const { txs, failed } = await loadWallet(who);
    renderWallet(txs, failed);
    lastWalletTxs = txs;
    if (!txs.length) return;
    $('wstage').hidden = false; $('wdetails').hidden = false;
    $('wstage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    await playWallet(txs);
  } catch (e: any) {
    walletMode = false;
    $('wsummary').innerHTML = `<div class="err">Couldn't read that wallet (RPC busy?) — try again. ${String(e?.message ?? e).slice(0, 120)}</div>`;
  }
}
$('wform').addEventListener('submit', (e) => { e.preventDefault(); void runWallet(wInput.value); });

// Random wallet: fee payers of recent USDC transfers, skipping spam bots with high failure rates
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
$('wrand').onclick = async () => {
  $('wsummary').innerHTML = `<span class="muted">Looking for a wallet with an interesting recent history…</span>`;
  try {
    // token-account owners in recent USDC transfers actually move value (fee payers are often relayers)
    const recent = (await rpc.getSignaturesForAddress(USDC, { limit: 40 }).send()).filter((x) => !x.err).sort(() => Math.random() - 0.5);
    let best = '', bestSpan = -1;
    for (const pick of recent.slice(0, 3)) {
      const tx = await rpc.getTransaction(pick.signature, { maxSupportedTransactionVersion: 1 as 0, encoding: 'json' }).send();
      const owners = [...new Set((tx?.meta?.postTokenBalances ?? []).map((b) => b.owner).filter(Boolean))].slice(0, 3) as string[];
      for (const o of owners) {
        const hist = await rpc.getSignaturesForAddress(address(o), { limit: 30 }).send();
        if (hist.length < 5) continue;
        const failRate = hist.filter((h) => h.err).length / hist.length;
        const spanH = (Number(hist[0].blockTime ?? 0) - Number(hist[hist.length - 1].blockTime ?? 0)) / 3600;
        if (failRate < 0.25 && spanH > bestSpan) { best = o; bestSpan = spanH; }
        if (bestSpan > 6) break;
      }
      if (bestSpan > 6) break;
    }
    if (best) { wInput.value = best; return void runWallet(best); }
    $('wsummary').innerHTML = `<div class="err">Couldn't find one — try again.</div>`;
  } catch { $('wsummary').innerHTML = `<div class="err">RPC busy — try again.</div>`; }
};
$('wreplay').onclick = async () => { await setPlaying(true); void playWallet(lastWalletTxs); };
void fetchPrices([]);

($('vol') as HTMLInputElement).oninput = (e) => { if (ac) master.gain.setTargetAtTime(Number((e.target as HTMLInputElement).value), ac.currentTime, 0.05); };
($('scale') as HTMLSelectElement).onchange = (e) => { scale = SCALES[(e.target as HTMLSelectElement).value]; };
($('perc') as HTMLInputElement).onchange = (e) => { percussion = (e.target as HTMLInputElement).checked; };

// ---------- boot ----------
void streamSlots();
conduct();
void detectSkips();
void pollTxs();
void pollTps();
requestAnimationFrame(draw);
