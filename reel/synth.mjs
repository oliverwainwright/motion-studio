// Score + SFX synthesized in code. 128 BPM -> 32 beats == exactly 15.000s.
// Writes score_raw.wav (48k stereo float) and beats.json. Deterministic (mulberry32).
import { writeFileSync } from 'node:fs';

const SR = 48000, BPM = 128, B = 60 / BPM, DUR = 15.0;
const N = Math.round(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N);
const verbL = new Float32Array(N), verbR = new Float32Array(N); // reverb send

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(1337);
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const beat = b => b * B;

function add(t0, buf, gain = 1, pan = 0, send = 0) {
  const s = Math.round(t0 * SR), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < buf.length; i++) {
    const j = s + i; if (j < 0 || j >= N) continue;
    L[j] += buf[i] * gl; R[j] += buf[i] * gr;
    if (send) { verbL[j] += buf[i] * gl * send; verbR[j] += buf[i] * gr * send; }
  }
}
// biquad (RBJ)
function biquad(type, f, q) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; } // bp
  a0 = 1 + a; a1 = -2 * c; a2 = 1 - a;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filt(x, type, fAt, q = 0.707) { // fAt: number or fn(i)->freq
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0, co = null;
  for (let i = 0; i < x.length; i++) {
    if (!co || typeof fAt === 'function' && (i & 31) === 0) co = biquad(type, Math.min(SR * 0.45, typeof fAt === 'function' ? fAt(i) : fAt), q);
    const v = co[0] * x[i] + co[1] * x1 + co[2] * x2 - co[3] * y1 - co[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const noise = n => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = rnd() * 2 - 1; return b; };

// ---------- instruments ----------
function kick(len = 0.5, f0 = 160, f1 = 42, punch = 1) {
  const n = Math.round(len * SR), b = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f1 + (f0 - f1) * Math.exp(-t * 28);
    ph += 2 * Math.PI * f / SR;
    b[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 7)) * 0.95 + (i < 240 ? (rnd() * 2 - 1) * 0.35 * punch * (1 - i / 240) : 0);
  }
  return b;
}
function clap() {
  const n = Math.round(0.35 * SR), raw = noise(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; let e = Math.exp(-t * 22); for (const o of [0, 0.011, 0.022]) if (t >= o && t < o + 0.008) e = Math.max(e, 1 - (t - o) / 0.008); b[i] = raw[i] * e; }
  return filt(b, 'bp', 1400, 0.9);
}
function hat(len = 0.06, open = false) {
  const n = Math.round((open ? 0.22 : len) * SR), raw = filt(noise(n), 'hp', 7500), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = raw[i] * Math.exp(-(i / SR) * (open ? 14 : 70));
  return b;
}
function saw(ph) { return 2 * (ph - Math.floor(ph + 0.5)); }
function bassNote(midi, len) {
  const n = Math.round(len * SR), f = mtof(midi), b = new Float32Array(n); let p1 = 0, p2 = 0, ps = 0;
  for (let i = 0; i < n; i++) {
    p1 += f * 1.003 / SR; p2 += f * 0.997 / SR; ps += f / SR;
    b[i] = (saw(p1) + saw(p2)) * 0.35 + Math.sin(2 * Math.PI * ps) * 0.6;
  }
  const y = filt(b, 'lp', i => 180 + 1600 * Math.exp(-(i / SR) * 16), 1.2);
  for (let i = 0; i < n; i++) { const t = i / SR; y[i] *= Math.min(1, t / 0.004) * Math.min(1, (len - t) / 0.02); }
  return y;
}
function stab(midis, len = 0.4, bright = 1) {
  const n = Math.round(len * SR), b = new Float32Array(n), det = [-0.012, -0.005, 0, 0.006, 0.013];
  const phs = midis.map(() => det.map(() => rnd()));
  for (let i = 0; i < n; i++) {
    let v = 0;
    midis.forEach((m, k) => det.forEach((d, j) => { phs[k][j] += mtof(m) * (1 + d) / SR; v += saw(phs[k][j]); }));
    b[i] = v / (midis.length * det.length) * 1.6;
  }
  const y = filt(b, 'lp', i => 300 + 5200 * bright * Math.exp(-(i / SR) * 9), 0.9);
  for (let i = 0; i < n; i++) { const t = i / SR; y[i] *= Math.min(1, t / 0.003) * Math.exp(-t * 3.2) * Math.min(1, (len - t) / 0.03); }
  return y;
}
function blip(midi, len = 0.12, wave = 'sine') {
  const n = Math.round(len * SR), f = mtof(midi), b = new Float32Array(n); let p = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; p += f / SR; const w = wave === 'sine' ? Math.sin(2 * Math.PI * p) : Math.sign(Math.sin(2 * Math.PI * p)) * 0.4; b[i] = w * Math.exp(-t * 30) * Math.min(1, t / 0.002); }
  return b;
}
function whoosh(len, fA, fB, peakAt = 0.8, q = 1.5) { // filtered noise swell
  const n = Math.round(len * SR), raw = noise(n);
  const y = filt(raw, 'bp', i => fA * Math.pow(fB / fA, i / n), q);
  for (let i = 0; i < n; i++) { const x = i / n; y[i] *= x < peakAt ? Math.pow(x / peakAt, 2.2) : Math.pow(1 - (x - peakAt) / (1 - peakAt), 1.5); }
  return y;
}
function impact(len = 2.4) {
  const n = Math.round(len * SR), b = new Float32Array(n); let ph = 0;
  const nz = filt(noise(n), 'lp', i => 9000 * Math.exp(-(i / SR) * 3) + 200, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 30 + 110 * Math.exp(-t * 9); ph += 2 * Math.PI * f / SR;
    b[i] = Math.tanh(2.2 * Math.sin(ph) * Math.exp(-t * 1.6)) * 0.9 + nz[i] * 0.55 * Math.exp(-t * 2.6);
  }
  return b;
}
function riser(len) {
  const n = Math.round(len * SR), nz = noise(n);
  const y = filt(nz, 'bp', i => 300 * Math.pow(30, i / n), 2.5); let p = 0;
  for (let i = 0; i < n; i++) { const x = i / n; p += (110 * Math.pow(8, x)) / SR; y[i] = (y[i] * 0.9 + Math.sin(2 * Math.PI * p) * 0.12 * x) * Math.pow(x, 1.8); }
  return y;
}

// ---------- arrangement ----------
const roots = [41, 37, 44, 39]; // F, Db, Ab, Eb (F minor)
const chords = [[65, 68, 72], [61, 65, 68], [60, 63, 68], [63, 67, 70]];
const sidechain = new Float32Array(N).fill(1);
function duck(t0, depth = 0.75, rel = 0.18) {
  const s = Math.round(t0 * SR), n = Math.round(rel * 1.6 * SR);
  for (let i = 0; i < n; i++) { const j = s + i; if (j >= N) break; const g = 1 - depth * Math.exp(-(i / SR) / (rel / 3)); sidechain[j] = Math.min(sidechain[j], g); }
}
const music = { L: new Float32Array(N), R: new Float32Array(N) };
function addM(t0, buf, gain, pan = 0, send = 0) { // into sidechained music bus
  const s = Math.round(t0 * SR), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < buf.length; i++) { const j = s + i; if (j < 0 || j >= N) continue; music.L[j] += buf[i] * gl; music.R[j] += buf[i] * gr; if (send) { verbL[j] += buf[i] * gl * send; verbR[j] += buf[i] * gr * send; } }
}

const K = kick(), CL = clap();
for (let b = 0; b < 32; b++) {
  const bar = Math.floor(b / 4), inBar = b % 4, t = beat(b);
  const root = roots[bar % 4];
  if (b >= 28) continue; // lockup section handled below
  // kick: four on the floor; bar 6 drops kick on last beat for the roll
  if (!(b === 27)) { add(t, K, 0.95); duck(t); }
  if (inBar === 1 || inBar === 3) add(t, CL, 0.42, 0, 0.35);
  add(t + B / 2, hat(), 0.16, 0.25);
  if (bar >= 2) { add(t + B / 4, hat(), 0.06, -0.3); add(t + 3 * B / 4, hat(), 0.07, -0.3); }
  if (inBar === 3 && bar % 2 === 1) add(t + B / 2, hat(0, true), 0.12, 0.2);
  // bass 8ths (octave bounce), 16ths in build bar
  const div = bar === 6 ? 4 : 2;
  for (let k = 0; k < div; k++) {
    const pat = div === 2 ? [0, 12] : [0, 0, 12, 0];
    addM(t + k * B / div, bassNote(root + pat[k], B / div * 0.92), 0.5);
  }
  // stabs: downbeat + syncopated &-of-2
  if (bar >= 1 && bar !== 6) {
    if (inBar === 0) addM(t, stab(chords[bar % 4], 0.42, bar >= 4 ? 1.2 : 0.8), 0.34, 0, 0.5);
    if (inBar === 1) addM(t + B / 2, stab(chords[bar % 4], 0.3, 0.9), 0.24, 0, 0.5);
  }
}
// scene-specific SFX -------------------------------------------------
add(0, impact(1.6), 0.8, 0, 0.3);                        // cold-open slam
add(beat(0), stab([53, 56, 60, 65], 0.9, 1.4), 0.3, 0, 0.6);
for (let i = 0; i < 6; i++) add(beat(0) + 0.05 + i * B / 8, blip(84 + [0, 3, 7, 10, 12, 15][i], 0.08), 0.1, (i % 2 ? 0.5 : -0.5), 0.3); // letters landing
add(beat(4) - 0.55, whoosh(0.6, 400, 5000, 0.92), 0.5, 0, 0.2); // dot zoom
for (let b = 4; b < 8; b++) add(beat(b), blip(96, 0.03, 'sq'), 0.10, 0.3);     // word ticks
add(beat(8) - 0.25, whoosh(0.35, 3000, 600, 0.6), 0.35, -0.4);                  // split
for (let b = 8; b < 12; b++) add(beat(b), blip(72 + [0, 7, 12, 19][b - 8], 0.25), 0.22, 0, 0.5); // ripple pings
for (let i = 0; i < 12; i++) add(beat(12) + 0.03 + i * 0.045, blip(60 + [0, 3, 7, 10, 12, 15, 19, 22, 24, 27, 31, 34][i], 0.1, 'sq'), 0.07, -0.6 + i * 0.1, 0.3); // bars
add(beat(15) - 0.3, whoosh(0.5, 500, 4000, 0.7), 0.35);                          // push-in
// easing runs: whoosh shaped like the curve
add(beat(17) + 0.02, whoosh(0.42, 800, 1800, 0.5, 2), 0.28, -0.4);
add(beat(18) + 0.02, whoosh(0.42, 500, 3500, 0.35, 2), 0.36, 0.4);
add(beat(19) + 0.0, whoosh(0.5, 900, 6000, 0.55, 2), 0.4, 0);
for (let b = 20; b < 24; b++) add(beat(b) - 0.12, whoosh(0.3, 1500, 400, 0.4, 1.2), 0.3, (b % 2 ? 0.5 : -0.5));   // card flips
for (let b = 24; b < 28; b++) { const div = b < 26 ? 1 : b < 27 ? 2 : 4; for (let k = 0; k < div; k++) add(beat(b) + k * B / div, blip(79 + (b - 24) * 2 + k, 0.05, 'sq'), 0.08); }
add(beat(24), riser(beat(28) - beat(24)), 0.55, 0, 0.2);
for (let i = 0; i < 16; i++) add(beat(27) + i * B / 16, CL, 0.12 + 0.25 * i / 16, (i % 2 ? 0.2 : -0.2)); // snare roll
// LOCKUP: silence gap 1/16 before, then everything hits
add(beat(28), impact(2.4), 1.0, 0, 0.45);
add(beat(28), K, 1.0);
addM(beat(28), stab([53, 56, 60, 65, 72], 1.8, 1.5), 0.42, 0, 0.8);
addM(beat(28), bassNote(29, 1.8), 0.6);
add(beat(29), blip(89, 0.4), 0.14, 0.3, 0.8);  // letters unfold
add(beat(30), blip(96, 0.4), 0.10, -0.3, 0.8);
add(beat(31), blip(101, 0.9), 0.08, 0, 1.0);    // final sparkle
// carve a 1/16 gap of silence right before the drop (tension)
{
  const s = Math.round((beat(28) - B / 4) * SR), e = Math.round(beat(28) * SR);
  for (let j = s; j < e; j++) { const x = (j - s) / (e - s); const g = x < 0.1 ? 1 - x * 10 : 0; L[j] *= g; R[j] *= g; music.L[j] *= g; music.R[j] *= g; verbL[j] *= g; verbR[j] *= g; }
}

// mix music bus with sidechain
for (let i = 0; i < N; i++) { L[i] += music.L[i] * sidechain[i]; R[i] += music.R[i] * sidechain[i]; }
// Schroeder reverb on send
function reverb(x, seed) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map(d => Math.round(d * SR / 44100) + seed), ap = [225, 556, 441].map(d => Math.round(d * SR / 44100));
  const y = new Float32Array(x.length);
  for (const d of combs) { const buf = new Float32Array(d); let idx = 0, lp = 0; for (let i = 0; i < x.length; i++) { const o = buf[idx]; lp = o * 0.7 + lp * 0.3; buf[idx] = x[i] + lp * 0.84; idx = (idx + 1) % d; y[i] += o / combs.length; } }
  for (const d of ap) { const buf = new Float32Array(d); let idx = 0; for (let i = 0; i < x.length; i++) { const bo = buf[idx], v = -y[i] * 0.5 + bo; buf[idx] = y[i] + bo * 0.5; idx = (idx + 1) % d; y[i] = v; } }
  return y;
}
const rvL = reverb(verbL, 0), rvR = reverb(verbR, 23);
for (let i = 0; i < N; i++) { L[i] += rvL[i] * 0.5; R[i] += rvR[i] * 0.5; }
// gentle master: soft clip + fade tail
for (let i = 0; i < N; i++) { const t = i / SR, f = t > DUR - 0.25 ? (DUR - t) / 0.25 : 1; L[i] = Math.tanh(L[i] * 0.9) * f; R[i] = Math.tanh(R[i] * 0.9) * f; }

// write WAV (32-bit float)
const data = Buffer.alloc(N * 8);
for (let i = 0; i < N; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4); }
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
writeFileSync(new URL('./score_raw.wav', import.meta.url), Buffer.concat([h, data]));
writeFileSync(new URL('./beats.json', import.meta.url), JSON.stringify({ bpm: BPM, beat: B, duration: DUR, beats: Array.from({ length: 32 }, (_, i) => +(i * B).toFixed(5)), bars: Array.from({ length: 8 }, (_, i) => +(i * 4 * B).toFixed(5)), drop: +(28 * B).toFixed(5) }, null, 1));
console.log('wrote score_raw.wav + beats.json');
