// Demo-video recorder: drives every scene in scenes.ts against the built
// extension (mock LLM, no keys, fully deterministic), records each as a video
// segment, narrates it with macOS `say`, and assembles the final MP4 with
// ffmpeg. Also regenerates docs/demo/SCRIPT.md with the ACTUAL timecodes
// measured from the finished segments, so script and video can never drift.
//
//   npm run demo:setup              — one-time: Kokoro TTS venv (uv + MLX-Audio)
//   npm run demo:record             — full tour → docs/demo/canagent-demo.mp4
//   DEMO_SCENES=title,plan npm run demo:record   — subset (plumbing iteration)
//
// Requirements: Apple Silicon macOS, ffmpeg on PATH, `npm run build` output in
// dist/. Narration uses Kokoro-82M via MLX-Audio when scripts/demo/.venv
// exists (run demo:setup once); otherwise it falls back to macOS `say`.

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startMockLlm } from '../../tests/e2e/mockLlm.ts';
import { startStatic } from '../../tests/e2e/staticServer.ts';
import { SCENES } from './narration.ts';
import { sceneSpecs } from './scenes.ts';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'demo');
const WORK = join(tmpdir(), `canagent-demo-${process.pid}`);
// TTS: Kokoro-82M via MLX-Audio (scripts/demo/.venv — see README section in
// SCRIPT.md header) with macOS `say` as the fallback engine.
//   DEMO_TTS=say            force the fallback
//   DEMO_VOICE=af_heart     Kokoro voice (or a `say` voice with DEMO_TTS=say)
const VENV_PY = join(ROOT, 'scripts', 'demo', '.venv', 'bin', 'python');
const USE_KOKORO = process.env.DEMO_TTS !== 'say' && existsSync(VENV_PY);
const VOICE = process.env.DEMO_VOICE ?? (USE_KOKORO ? 'af_heart' : 'Samantha');
const KOKORO_MODEL = process.env.DEMO_TTS_MODEL ?? 'mlx-community/Kokoro-82M-bf16';

async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function recordScene(id: string, mockBase: string, staticBase: string): Promise<string> {
  const spec = sceneSpecs.find((s) => s.id === id);
  if (!spec) throw new Error(`No scene runner for "${id}"`);
  const videoDir = join(WORK, 'raw', id);
  mkdirSync(videoDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: spec.viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: spec.viewport },
    args: ['--no-sandbox', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extensionId = new URL(sw.url()).host;
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(spec.viewport);
    const video = page.video();
    if (!video) throw new Error('recordVideo did not attach to the page');

    await spec.run({ context, serviceWorker: sw, extensionId, mockBase, staticBase, page });

    await context.close(); // flushes the video file
    const raw = await video.path();
    const dest = join(WORK, 'seg', `${id}.webm`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(raw, dest);
    rmSync(videoDir, { recursive: true, force: true }); // discards auxiliary pages' videos
    return dest;
  } catch (err) {
    await context.close().catch(() => {});
    throw new Error(`Scene "${id}" failed: ${String(err)}`);
  }
}

async function synthNarration(id: string, text: string): Promise<string> {
  const dir = join(WORK, 'tts');
  mkdirSync(dir, { recursive: true });
  if (USE_KOKORO) {
    // Kokoro splits long text into sentences; --join_audio merges them into
    // one <prefix>.wav. Generation is ~1s of audio per second on M-series.
    await exec(VENV_PY, [
      '-m', 'mlx_audio.tts.generate',
      '--model', KOKORO_MODEL,
      '--voice', VOICE,
      '--speed', '1.05',
      '--join_audio',
      '--output_path', dir,
      '--file_prefix', id,
      '--text', text,
    ]);
    const wav = join(dir, `${id}.wav`);
    if (existsSync(wav)) return wav;
    // Single-segment runs may skip the join and emit <prefix>_000.wav.
    const seg = join(dir, `${id}_000.wav`);
    if (existsSync(seg)) return seg;
    throw new Error(`Kokoro produced no audio for scene "${id}"`);
  }
  const aiff = join(dir, `${id}.aiff`);
  await exec('say', ['-v', VOICE, '-o', aiff, text]);
  return aiff;
}

async function buildSegment(id: string, webm: string, aiff: string): Promise<{ mp4: string; duration: number }> {
  const [videoDur, audioDur] = await Promise.all([ffprobeDuration(webm), ffprobeDuration(aiff)]);
  // The scene must stay on screen at least as long as its narration (+ a beat).
  const target = Math.max(videoDur, audioDur + 0.8);
  // Keep the ACTION in pace with the voice: time-stretch the footage toward the
  // narration length (up to 1.45x — beyond that motion looks syrupy), and only
  // freeze-frame the remainder. Without this, a scene whose actions finish
  // early sits on a static end frame while the narration keeps going.
  const stretch = Math.min(Math.max(target / Math.max(videoDur, 0.1), 1), 1.45);
  const stretchedDur = videoDur * stretch;
  const padVideo = Math.max(0, target - stretchedDur) + 0.2;
  const mp4 = join(WORK, 'seg', `${id}.mp4`);
  await exec('ffmpeg', [
    '-y', '-i', webm, '-i', aiff,
    '-filter_complex',
    `[0:v]setpts=${stretch.toFixed(4)}*PTS,scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x1c1726,fps=30,tpad=stop_mode=clone:stop_duration=${padVideo.toFixed(2)}[v];` +
      `[1:a]aresample=44100,loudnorm=I=-18:TP=-2,apad[a]`,
    '-map', '[v]', '-map', '[a]',
    '-t', target.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    mp4,
  ]);
  return { mp4, duration: await ffprobeDuration(mp4) };
}

function writeScript(rows: Array<{ id: string; start: number; end: number }>): void {
  const lines: string[] = [
    '# CANChat Agent — demo video script',
    '',
    'Generated by `npm run demo:record` — the timecodes below are measured from the',
    'assembled video (`docs/demo/canagent-demo.mp4`), so this script always matches',
    'the finished cut. Narration lives in `scripts/demo/narration.ts`; edit there',
    'and re-record.',
    '',
    '| Time | Scene | Narration | On screen |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    const def = SCENES.find((s) => s.id === r.id)!;
    lines.push(`| ${fmt(r.start)}–${fmt(r.end)} | **${def.title}** | ${def.narration} | ${def.action} |`);
  }
  lines.push('', `Total running time: **${fmt(rows[rows.length - 1]?.end ?? 0)}**.`, '');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'SCRIPT.md'), lines.join('\n'));
}

const STAGE_FILES = ['stage.html', 'stage.js'];

/** The stage must be an extension page (it iframes sidebar.html and reads
 *  chrome.tabs), so it is copied into dist/ for the recording session only —
 *  it is not part of the product build. */
function deployStage(): void {
  for (const f of STAGE_FILES) copyFileSync(join(ROOT, 'scripts', 'demo', f), join(DIST, f));
}
function removeStage(): void {
  for (const f of STAGE_FILES) rmSync(join(DIST, f), { force: true });
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error(`Extension build not found at ${DIST} — run "npm run build" first.`);
  }
  const only = process.env.DEMO_SCENES?.split(',').map((s) => s.trim()).filter(Boolean);
  const ids = SCENES.map((s) => s.id).filter((id) => !only || only.includes(id));
  if (ids.length === 0) throw new Error('DEMO_SCENES matched no scenes.');

  mkdirSync(WORK, { recursive: true });
  deployStage();
  const mock = await startMockLlm();
  const staticServer = await startStatic(join(ROOT, 'tests', 'fixtures'));
  const segments: Array<{ id: string; mp4: string; duration: number }> = [];
  try {
    for (const id of ids) {
      const def = SCENES.find((s) => s.id === id)!;
      process.stdout.write(`● ${id} … `);
      const webm = await recordScene(id, mock.url, staticServer.url);
      const aiff = await synthNarration(id, def.narration);
      const seg = await buildSegment(id, webm, aiff);
      segments.push({ id, ...seg });
      process.stdout.write(`${seg.duration.toFixed(1)}s\n`);
    }
  } finally {
    await mock.close();
    await staticServer.close();
    removeStage();
  }

  // Concatenate (all segments share codec/size/fps, so stream-copy works).
  const list = join(WORK, 'concat.txt');
  writeFileSync(list, segments.map((s) => `file '${s.mp4}'`).join('\n'));
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'canagent-demo.mp4');
  await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);

  // Timecodes from the measured segment durations.
  let cursor = 0;
  const rows = segments.map((s) => {
    const row = { id: s.id, start: cursor, end: cursor + s.duration };
    cursor += s.duration;
    return row;
  });
  if (!only) writeScript(rows); // partial runs shouldn't overwrite the real script

  console.log(`\n✔ ${out} (${fmt(cursor)} total)`);
  for (const r of rows) console.log(`  ${fmt(r.start)}  ${r.id}`);
  rmSync(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
