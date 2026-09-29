// node render.mjs                 -> full render: reel.mp4 (60fps, H.264 yuv420p CRF16, -14 LUFS)
// node render.mjs --contact [off] -> contact.png: one frame per beat (at beat + off seconds)
// node render.mjs --at 1.2,3.4    -> at_<t>.png stills
import { chromium } from 'playwright';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FPS = 60, DUR = 15, NF = FPS * DUR;
const TMP = process.env.FRAMES_DIR || path.join(DIR, '.frames');
const args = process.argv.slice(2);
const beats = JSON.parse(readFileSync(path.join(DIR, 'beats.json'), 'utf8'));

async function openPages(n) {
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
  const pages = [];
  for (let i = 0; i < n; i++) {
    const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
    await p.goto('file://' + path.join(DIR, 'index.html') + '?render=1');
    await p.evaluate(() => window.ready);
    pages.push(p);
  }
  return { browser, pages };
}
const shot = async (p, t, file) => { await p.evaluate(t => window.seek(t), t); await p.locator('#stage').screenshot({ path: file, type: 'png', animations: 'disabled' }); };

if (args[0] === '--contact' || args[0] === '--at') {
  mkdirSync(TMP, { recursive: true });
  const { browser, pages: [p] } = await openPages(1);
  if (args[0] === '--contact') {
    const off = parseFloat(args[1] ?? '0.15');
    for (let b = 0; b < 32; b++) await shot(p, beats.beats[b] + off, path.join(TMP, `c_${String(b).padStart(2, '0')}.png`));
    await browser.close();
    const out = path.join(DIR, args[2] || 'contact.png');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(TMP, 'c_%02d.png'), '-vf', 'scale=480:270,drawtext=text=%{n}:x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x8:padding=6:color=gray', '-frames:v', '1', out], { stdio: 'inherit' });
    console.log('contact sheet ->', out);
  } else {
    for (const t of args[1].split(',').map(Number)) await shot(p, t, path.join(DIR, `at_${t.toFixed(3)}.png`));
    await browser.close();
  }
} else {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  const W = parseInt(process.env.WORKERS || '6');
  const t0 = Date.now();
  const { browser, pages } = await openPages(W);
  let next = 0, done = 0;
  await Promise.all(pages.map(async p => {
    while (next < NF) {
      const f = next++;
      await shot(p, f / FPS, path.join(TMP, `f_${String(f).padStart(4, '0')}.png`));
      if (++done % 60 === 0) process.stdout.write(`\r${done}/${NF} frames  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }));
  await browser.close();
  console.log(`\nframes done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  // loudness: two-pass loudnorm to -14 LUFS / -1 dBTP
  const m = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(DIR, 'score_raw.wav'), '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const j = JSON.parse(m.stderr.slice(m.stderr.lastIndexOf('{'), m.stderr.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(DIR, 'score_raw.wav'), '-af', `${ln},aresample=48000`, '-c:a', 'pcm_s24le', path.join(DIR, 'score.wav')], { stdio: 'inherit' });
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(TMP, 'f_%04d.png'), '-i', path.join(DIR, 'score.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '320k', '-shortest', path.join(DIR, 'reel.mp4')], { stdio: 'inherit' });
  if (r.status === 0) console.log('-> reel.mp4');
}
