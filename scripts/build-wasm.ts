// Runs wasm-pack to build wasm/vector-simd, preferring a system-installed
// wasm-pack over the one the `wasm-pack` npm package downloads at install time.
//
// That npm package fetches a prebuilt binary via `binary-install`, which can
// resolve to the wrong architecture — observed on Apple Silicon Macs without
// Rosetta installed, where the downloaded binary is x86_64 and spawning it
// fails with `Unknown system error -86` ("bad CPU type in executable"). A
// system wasm-pack (`brew install wasm-pack` or `cargo install wasm-pack`) is
// always native to the machine it was installed on, so it's used first when
// present. Falls back to the npm-managed binary otherwise — that's what CI
// uses today, and this preserves that behavior unchanged.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_PACK_ARGS = ['build', 'wasm/vector-simd', '--target', 'web', '--release', '--out-dir', '../../src/offscreen/vectorSimdPkg', '--out-name', 'vector_simd'];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** All PATH matches for `bin`, in PATH order. npm prepends node_modules/.bin to PATH for
 * this process, so a plain single-result `which` would only ever find the npm-managed
 * shim — `-a`/`where`'s default multi-match behavior is needed to see past it. */
function whichAll(bin: string): string[] {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? [bin] : ['-a', bin], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveWasmPack(): string {
  if (process.env.WASM_PACK_BIN) return process.env.WASM_PACK_BIN;
  const system = whichAll('wasm-pack').find((p) => !p.includes('node_modules'));
  if (system) return system;
  const npmManaged = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack');
  if (existsSync(npmManaged)) return npmManaged;
  return 'wasm-pack';
}

const bin = resolveWasmPack();
const usingNpmManagedFallback = bin.includes('node_modules');
const result = spawnSync(bin, WASM_PACK_ARGS, { stdio: 'inherit', cwd: repoRoot });

const archMismatchLikely =
  (result.error && (result.error as NodeJS.ErrnoException).errno === -86) ||
  // The npm-managed binary's own launcher crashes with an uncaught exception (not a clean
  // exit code) rather than surfacing a catchable spawn error when its architecture doesn't
  // match this machine — this is the same failure mode as the -86 case above, just raised a
  // process away, so it's inferred from the fallback + platform combination instead.
  (usingNpmManagedFallback && result.status !== 0 && process.platform === 'darwin' && process.arch === 'arm64');

if (result.error) console.error(`\nFailed to run wasm-pack at ${bin}: ${result.error.message}`);
if (archMismatchLikely) {
  console.error(
    "\nThis usually means the wasm-pack binary does not match this machine's architecture " +
      '(e.g. an x86_64 binary on Apple Silicon without Rosetta). Install a native wasm-pack ' +
      'instead: `brew install wasm-pack` or `cargo install wasm-pack`.',
  );
}

process.exit(result.error ? 1 : (result.status ?? 1));
