// Demo-video recorder (v3): drives every scene in scenes.ts against the built
// extension, records each as a segment, narrates it BEAT BY BEAT with
// Kokoro-82M, and assembles the final MP4 with ffmpeg.
//
// Sync model: scenes emit mark() checkpoints; narration.ts anchors one beat to
// each mark. Assembly cuts the footage at the marks and freeze-pads each chunk
// to its beat's audio length — a sentence starts exactly when its action
// starts, and the picture holds (never mid-action) when narration outruns it.
//
// Live pages: dist/manifest.json is patched for the recording session only
// (declarativeNetRequest added, restored afterwards) and each scene installs a
// session rule stripping X-Frame-Options / CSP so the stage can iframe real
// Wikipedia / canada.ca pages. The product manifest is never touched.
//
//   npm run demo:setup              — one-time: Kokoro TTS venv (uv + MLX-Audio)
//   npm run demo:record             — full tour → docs/demo/canagent-demo.mp4
//   DEMO_SCENES=title,plan npm run demo:record   — subset (iteration)
//
// Requirements: Apple Silicon macOS, ffmpeg on PATH, network (live pages),
// `npm run build` output in dist/. Kokoro venv optional (falls back to `say`).

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startDemoLlm } from './demoLlm.ts';
import { SCENES, type DemoLang, type SceneDef } from './narration.ts';
import { sceneSpecs } from './scenes.ts';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'demo');
const WORK = join(tmpdir(), `canagent-demo-${process.pid}`);
const VENV_PY = join(ROOT, 'scripts', 'demo', '.venv', 'bin', 'python');
const USE_KOKORO = process.env.DEMO_TTS !== 'say' && existsSync(VENV_PY);
// DEMO_LANG=fr → French UI (ba_language), French live pages, French narration
// (Kokoro ff_siwis), and -fr output filenames. Default: English.
const LANG: DemoLang = process.env.DEMO_LANG === 'fr' ? 'fr' : 'en';
const VOICE = process.env.DEMO_VOICE ?? (USE_KOKORO ? (LANG === 'fr' ? 'ff_siwis' : 'af_heart') : (LANG === 'fr' ? 'Amélie' : 'Samantha'));
const OUT_VIDEO = LANG === 'fr' ? 'canagent-demo-fr.mp4' : 'canagent-demo.mp4';
const OUT_SCRIPT = LANG === 'fr' ? 'SCRIPT-fr.md' : 'SCRIPT.md';
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

// ---------------------------------------------------------------------------
// Recording-session dist/ mutations (stage files + manifest permission).
// ---------------------------------------------------------------------------

const STAGE_FILES = ['stage.html', 'stage.js'];
const MANIFEST = join(DIST, 'manifest.json');
let manifestBackup: string | null = null;

function deployStage(): void {
  for (const f of STAGE_FILES) copyFileSync(join(ROOT, 'scripts', 'demo', f), join(DIST, f));
  // Grant declarativeNetRequest for the session so a rule can strip framing
  // headers (X-Frame-Options / CSP) and live sites render inside the stage.
  manifestBackup = readFileSync(MANIFEST, 'utf8');
  const m = JSON.parse(manifestBackup) as { permissions?: string[] };
  m.permissions = [...new Set([...(m.permissions ?? []), 'declarativeNetRequest'])];
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function removeStage(): void {
  for (const f of STAGE_FILES) rmSync(join(DIST, f), { force: true });
  if (manifestBackup) writeFileSync(MANIFEST, manifestBackup);
}

// ---------------------------------------------------------------------------
// Scene capture
// ---------------------------------------------------------------------------

interface Captured {
  webm: string;
  videoDur: number;
  marks: Array<{ name: string; at: number }>;
}

async function recordScene(id: string, mockBase: string): Promise<Captured> {
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
    // Strip framing headers for sub-frames so live pages render in the stage.
    await sw.evaluate(() =>
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
        addRules: [
          {
            id: 1,
            action: {
              type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
              responseHeaders: [
                { header: 'x-frame-options', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
                { header: 'content-security-policy', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
                { header: 'content-security-policy-report-only', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
              ],
            },
            condition: { resourceTypes: ['sub_frame' as chrome.declarativeNetRequest.ResourceType] },
          },
        ],
      }),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(spec.viewport);
    // Watchdog: a stuck locator must fail the scene fast, not freeze the take
    // (one zoomed-iframe stall burned 15 minutes of footage before this).
    page.setDefaultTimeout(20_000);
    const video = page.video();
    if (!video) throw new Error('recordVideo did not attach to the page');

    const marks: Array<{ name: string; at: number }> = [];
    await spec.run({ context, serviceWorker: sw, extensionId, mockBase, page, marks, sceneStart: Date.now(), lang: LANG });

    await context.close(); // flushes the video file
    const raw = await video.path();
    const dest = join(WORK, 'seg', `${id}.webm`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(raw, dest);
    rmSync(videoDir, { recursive: true, force: true }); // discards auxiliary pages' videos
    return { webm: dest, videoDur: await ffprobeDuration(dest), marks };
  } catch (err) {
    await context.close().catch(() => {});
    throw new Error(`Scene "${id}" failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Per-beat narration + chunked assembly
// ---------------------------------------------------------------------------

async function synthBeat(id: string, beatIdx: number, text: string): Promise<string> {
  const dir = join(WORK, 'tts');
  mkdirSync(dir, { recursive: true });
  const prefix = `${id}-${beatIdx}`;
  if (USE_KOKORO) {
    await exec(VENV_PY, [
      '-m', 'mlx_audio.tts.generate',
      '--model', KOKORO_MODEL,
      '--voice', VOICE,
      '--speed', '1.05',
      '--join_audio',
      '--output_path', dir,
      '--file_prefix', prefix,
      '--text', text,
    ]);
    for (const cand of [join(dir, `${prefix}.wav`), join(dir, `${prefix}_000.wav`)]) {
      if (existsSync(cand)) return cand;
    }
    throw new Error(`Kokoro produced no audio for ${prefix}`);
  }
  const aiff = join(dir, `${prefix}.aiff`);
  await exec('say', ['-v', VOICE, '-o', aiff, text]);
  return aiff;
}

/**
 * Cut the scene at its beat marks; freeze-pad each chunk to its beat's
 * narration; lay the beat audios end to end. Returns the final segment mp4.
 */
async function buildSegment(scene: SceneDef, cap: Captured): Promise<{ mp4: string; duration: number }> {
  const beats = scene.beats[LANG];
  // Resolve beat boundary times. Beat 0 is 'start' (t=0); later beats must
  // reference marks the scene actually emitted, in increasing order.
  const times: number[] = [0];
  for (let i = 1; i < beats.length; i++) {
    const m = cap.marks.find((x) => x.name === beats[i].mark);
    if (!m) {
      throw new Error(
        `Scene "${scene.id}": no mark "${beats[i].mark}" emitted (got: ${cap.marks.map((x) => x.name).join(', ') || 'none'})`,
      );
    }
    times.push(Math.min(Math.max(m.at, times[i - 1] + 0.05), cap.videoDur - 0.05));
  }
  times.push(cap.videoDur);

  const audios: string[] = [];
  const outLens: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    const wav = await synthBeat(scene.id, i, beats[i].text);
    const aDur = await ffprobeDuration(wav);
    const chunkLen = times[i + 1] - times[i];
    audios.push(wav);
    outLens.push(Math.max(chunkLen, aDur + 0.5));
  }

  const n = beats.length;
  const vParts: string[] = [];
  const aParts: string[] = [];
  for (let i = 0; i < n; i++) {
    const pad = (outLens[i] - (times[i + 1] - times[i])).toFixed(3);
    vParts.push(
      `[0:v]trim=start=${times[i].toFixed(3)}:end=${times[i + 1].toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${pad}[v${i}]`,
    );
    aParts.push(`[${i + 1}:a]aresample=44100,apad=whole_dur=${outLens[i].toFixed(3)}[a${i}]`);
  }
  const vConcat = vParts.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[vc]`;
  const aConcat = aParts.map((_, i) => `[a${i}]`).join('') + `concat=n=${n}:v=0:a=1[ac]`;
  const graph =
    [...vParts, ...aParts, vConcat, aConcat].join(';') +
    `;[vc]scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x1c1726,fps=30[v]` +
    `;[ac]loudnorm=I=-18:TP=-2[a]`;

  const mp4 = join(WORK, 'seg', `${scene.id}.mp4`);
  await exec('ffmpeg', [
    '-y', '-i', cap.webm,
    ...audios.flatMap((a) => ['-i', a]),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    mp4,
  ]);
  return { mp4, duration: await ffprobeDuration(mp4) };
}

// ---------------------------------------------------------------------------

function writeScript(rows: Array<{ id: string; start: number; end: number }>): void {
  const lines: string[] = [
    LANG === 'fr' ? '# CANChat Agent — script de la vidéo de démonstration' : '# CANChat Agent — demo video script',
    '',
    `Generated by \`npm run demo:record\`${LANG === 'fr' ? ' (DEMO_LANG=fr)' : ''} — the timecodes below are measured`,
    `from the assembled video (\`docs/demo/${OUT_VIDEO}\`), so this script always`,
    'matches the finished cut. Narration lives in `scripts/demo/narration.ts` as',
    'per-scene beats anchored to on-screen checkpoints; edit there and re-record.',
    '',
    '| Time | Scene | Narration | On screen |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    const def = SCENES.find((s) => s.id === r.id)!;
    const text = def.beats[LANG].map((b) => b.text).join(' ');
    lines.push(`| ${fmt(r.start)}–${fmt(r.end)} | **${def.title}** | ${text} | ${def.action} |`);
  }
  lines.push('', `Total running time: **${fmt(rows[rows.length - 1]?.end ?? 0)}**.`, '');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, OUT_SCRIPT), lines.join('\n'));
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    throw new Error(`Extension build not found at ${DIST} — run "npm run build" first.`);
  }
  const only = process.env.DEMO_SCENES?.split(',').map((s) => s.trim()).filter(Boolean);
  const ids = SCENES.map((s) => s.id).filter((id) => !only || only.includes(id));
  if (ids.length === 0) throw new Error('DEMO_SCENES matched no scenes.');

  mkdirSync(WORK, { recursive: true });
  deployStage();
  const mock = await startDemoLlm();
  const segments: Array<{ id: string; mp4: string; duration: number }> = [];
  try {
    for (const id of ids) {
      const def = SCENES.find((s) => s.id === id)!;
      process.stdout.write(`● ${id} … `);
      const cap = await recordScene(id, mock.url);
      const seg = await buildSegment(def, cap);
      segments.push({ id, ...seg });
      process.stdout.write(
        `${seg.duration.toFixed(1)}s (${cap.marks.map((m) => `${m.name}@${m.at.toFixed(1)}`).join(' ') || 'no marks'})\n`,
      );
    }
  } finally {
    await mock.close();
    removeStage();
  }

  const list = join(WORK, 'concat.txt');
  writeFileSync(list, segments.map((s) => `file '${s.mp4}'`).join('\n'));
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, OUT_VIDEO);
  await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);

  let cursor = 0;
  const rows = segments.map((s) => {
    const row = { id: s.id, start: cursor, end: cursor + s.duration };
    cursor += s.duration;
    return row;
  });
  if (!only) writeScript(rows);

  console.log(`\n✔ ${out} (${fmt(cursor)} total)`);
  for (const r of rows) console.log(`  ${fmt(r.start)}  ${r.id}`);
  rmSync(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
