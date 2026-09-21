#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Package CANChat Agent for Chrome Web Store (unlisted).
# - Builds dist/ (via mise or npm) unless --no-build / --verify-only
# - Zips dist/ contents (not the folder itself) into canChat-agent-<version>.zip
#   where version is read from public/manifest.json and cross-checked against package.json
# - Verifies store requirements (structure, manifest, CSP, permissions, icons, size)
# - Prints a summary with next steps for scottsyms@gmail.com unlisted upload
#
# Usage:
#   bash scripts/package.sh [--verify-only] [--no-build] [--version X.Y.Z] [--out PATH]
#   npm run package            # wrapper
#   npm run package:verify     # verify existing zip only

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OVERRIDE_VERSION=""
OUT_ARG=""
VERIFY_ONLY=0
NO_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --version) OVERRIDE_VERSION="${2:-}"; shift 2 ;;
    --out) OUT_ARG="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/package.sh [options]
  --verify-only      Skip build and packaging, only verify the existing zip
  --no-build         Skip build step, package existing dist/
  --version X.Y.Z    Override manifest version for the zip name
  --out PATH         Override output zip path
  -h, --help         Show this help
EOF
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --- dependency checks (non-fatal hints) ---
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "WARN: '$1' not found on PATH – $2" >&2
    return 1
  fi
}
need zip "needed to create the store zip – brew install zip" || true
need unzip "needed for verification" || true

# --- version resolution (GitHub-aligned) ---
get_version_jq() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.version' "$1" 2>/dev/null
  else
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$1" 2>/dev/null
  fi
}

MANIFEST_VER="$(get_version_jq public/manifest.json || true)"
PKG_VER="$(get_version_jq package.json || true)"

if [[ -z "$MANIFEST_VER" || "$MANIFEST_VER" == "null" ]]; then
  echo "ERROR: could not read version from public/manifest.json" >&2; exit 2
fi
if [[ -z "$PKG_VER" || "$PKG_VER" == "null" ]]; then
  echo "ERROR: could not read version from package.json" >&2; exit 2
fi
if [[ "$MANIFEST_VER" != "$PKG_VER" ]]; then
  echo "ERROR: version mismatch: public/manifest.json ($MANIFEST_VER) != package.json ($PKG_VER)" >&2
  echo "Fix before tagging v$MANIFEST_VER – manifest and package.json must match for GitHub alignment." >&2
  exit 2
fi
if [[ -n "$OVERRIDE_VERSION" ]]; then
  echo "INFO: overriding version $MANIFEST_VER -> $OVERRIDE_VERSION" >&2
  VERSION="$OVERRIDE_VERSION"
else
  VERSION="$MANIFEST_VER"
fi

ZIP_NAME="canChat-agent-${VERSION}.zip"
OUT="${OUT_ARG:-$ROOT/$ZIP_NAME}"
DIST_ZIP="$ROOT/dist/$ZIP_NAME"

# --- build (unless verify-only / no-build) ---
if [[ $VERIFY_ONLY -eq 1 ]]; then
  echo "=== Verifying existing zip (no build) ==="
  if [[ ! -f "$OUT" && -f "$DIST_ZIP" ]]; then OUT="$DIST_ZIP"; fi
  if [[ ! -f "$OUT" ]]; then
    echo "ERROR: no zip found at $OUT or $DIST_ZIP for --verify-only" >&2; exit 3
  fi
else
  if [[ $NO_BUILD -eq 0 ]]; then
    echo "=== Building dist/ (version $VERSION) ==="
    BUILD_OK=0
    if command -v mise >/dev/null 2>&1; then
      echo "Running: mise run build"
      if mise run build 2>&1; then BUILD_OK=1;
      else echo "WARN: mise run build failed" >&2; fi
    fi
    if [[ $BUILD_OK -eq 0 ]]; then
      echo "Running: npm run build (with wasm-pack fallback)"
      if npm run build 2>&1; then BUILD_OK=1;
      else echo "WARN: npm run build failed – trying vite builds without wasm-pack" >&2; fi
    fi
    if [[ $BUILD_OK -eq 0 ]]; then
      echo "Attempting vite builds directly (skipping wasm-pack)..."
      if npx vite build 2>&1 && npx vite build --config vite.content.config.ts 2>&1 && npx vite build --config vite.webmcp.config.ts 2>&1 && npx vite build --config vite.pointer.config.ts 2>&1 && npx vite build --config vite.learn.config.ts 2>&1; then
        echo "Vite builds succeeded without wasm-pack (using existing src/offscreen/vectorSimdPkg)" >&2
        BUILD_OK=1
      fi
    fi
    if [[ $BUILD_OK -eq 0 ]]; then
      echo "ERROR: build failed – see logs above" >&2; exit 3
    fi
    echo "Build finished."
  else
    echo "=== Skipping build (--no-build) ==="
  fi

  if [[ ! -f dist/manifest.json ]]; then
    echo "ERROR: dist/manifest.json not found – build did not produce dist/" >&2
    echo "Hint: 'npm run build' must emit dist/ via vite (see vite.config.ts, vite.content.config.ts)." >&2
    exit 3
  fi
  if [[ ! -f dist/serviceWorker.js ]]; then echo "ERROR: dist/serviceWorker.js missing" >&2; exit 3; fi
  if [[ ! -f dist/sidebar.html ]]; then echo "ERROR: dist/sidebar.html missing" >&2; exit 3; fi

  # --- packaging (store-compliant: contents of dist/, not the folder itself) ---
  echo "=== Packaging $ZIP_NAME ==="
  rm -f "$OUT" "$DIST_ZIP"
  mkdir -p "$(dirname "$OUT")" dist
  # Zip from inside dist so entries are top-level (manifest.json at root of zip)
  (cd dist && zip -r -9 "$OUT" . -x '*.map' '*.DS_Store' '__MACOSX/*' >/dev/null)
  cp "$OUT" "$DIST_ZIP"
  # SHA256 sidecar for GitHub Release verification
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$OUT" | awk '{print $1}' > "$OUT.sha256"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
  else
    echo "WARN: neither shasum nor sha256sum found – skipping .sha256 sidecar" >&2
  fi
  echo "ZIP created: $OUT"
  if [[ -f "$OUT.sha256" ]]; then echo "SHA256: $(cat "$OUT.sha256") (→ $OUT.sha256)"; fi
fi

# --- verification suite ---
echo ""
echo "=== Verification ==="
FAIL=0
ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; FAIL=1; }
warn() { echo "  ⚠ $1" >&2; }

# Resolve which zip to verify (verify-only may have overridden OUT)
if [[ ! -f "$OUT" ]]; then
  if [[ -f "$DIST_ZIP" ]]; then OUT="$DIST_ZIP"; else echo "ERROR: zip not found at $OUT" >&2; exit 4; fi
fi

# helper: list zip contents one per line (no header) – robust across unzip/zipinfo
zip_list() {
  if command -v zipinfo >/dev/null 2>&1; then
    zipinfo -1 "$OUT" 2>/dev/null || true
  else
    unzip -l "$OUT" 2>/dev/null | awk 'NR>3 {print $NF}' | grep -v '^$' | grep -v '^----' | grep -v '^Archive' | grep -v '^Length' || true
  fi
}

# 1) Top-level layout
if zip_list | grep -Fqx "manifest.json"; then
  ok "manifest.json at zip top-level (not nested in dist/)"
else
  fail "manifest.json not at zip top-level – ZIP must contain the contents of dist/, not the dist/ folder itself"
fi

# 2) Prohibited entries
if zip_list | grep -Fq "node_modules/"; then fail "zip contains node_modules/ (must not be shipped)"; else ok "no node_modules/ in zip"; fi
if zip_list | grep -Eq '(\.git/|\.crx$)'; then fail "zip contains .git/ or .crx"; else ok "no .git/.crx in zip"; fi
if zip_list | grep -Fq ".map"; then
  # more precise: any .map file
  if zip_list | grep -q "\.map$"; then warn "zip contains *.map sourcemaps (allowed but review leans lean – built with -x '*.map' so this is unexpected)"; else ok "no *.map in zip"; fi
else
  ok "no *.map in zip"
fi

# 3) Required entries
for req in "manifest.json" "serviceWorker.js" "sidebar.html" "offscreen.html" "contentScript.js" "webmcpBridge.js" "pointerTracker.js" "interactionRecorder.js" "icons/icon128.png"; do
  if zip_list | grep -Fqx "$req"; then ok "present: $req"; else fail "missing required entry: $req"; fi
done
# Litert/models assets (wildcards)
if zip_list | grep -Fq "litert/"; then ok "present: litert/"; else warn "missing litert/ (expected for on-device embeddings)"; fi
if zip_list | grep -Fq "models/"; then ok "present: models/"; else warn "missing models/"; fi

# 4) Manifest validity (against dist/manifest.json and zipped one)
MANI_JSON="dist/manifest.json"
if [[ $VERIFY_ONLY -eq 1 ]]; then
  # Extract zipped manifest to temp for checks
  TMPM=$(mktemp -t cwsm.XXXXXX.json)
  trap 'rm -f "$TMPM"' EXIT
  unzip -p "$OUT" manifest.json > "$TMPM" 2>/dev/null || true
  MANI_JSON="$TMPM"
fi
if [[ -f "$MANI_JSON" ]]; then
  # Helper: jq or python3
  mani_get() {
    local key="$1"
    if command -v jq >/dev/null 2>&1; then jq -r "$key" "$MANI_JSON" 2>/dev/null
    else python3 -c "import json; d=json.load(open('$MANI_JSON')); print($2)" 2>/dev/null
    fi
  }
  MV=$(mani_get '.manifest_version' "d['manifest_version']")
  MCV=$(mani_get '.minimum_chrome_version' "d.get('minimum_chrome_version','')")
  MVN=$(mani_get '.version' "d['version']")
  CSP=$(mani_get '.content_security_policy.extension_pages' "d.get('content_security_policy',{}).get('extension_pages','')")

  if [[ "$MV" == "3" ]]; then ok "manifest_version == 3"; else fail "manifest_version != 3 (got: $MV)"; fi
  if [[ "$MCV" == "116" ]]; then ok "minimum_chrome_version == 116"; else warn "minimum_chrome_version is $MCV (expected 116)"; fi
  if [[ "$MVN" == "$VERSION" ]]; then ok "manifest version == $VERSION (GitHub-aligned)"; else fail "manifest version $MVN != expected $VERSION"; fi
  if echo "$CSP" | grep -q "wasm-unsafe-eval" && echo "$CSP" | grep -q "'self'"; then ok "CSP contains wasm-unsafe-eval + 'self'"; else fail "CSP missing wasm-unsafe-eval or 'self' (got: $CSP)"; fi
  if echo "$CSP" | grep -q "https:"; then fail "CSP must not contain remote https: (must be 'self' only)"; else ok "CSP has no remote https:"; fi
else
  fail "could not read $MANI_JSON for manifest checks"
fi
# Reset trap if we set it
trap - EXIT 2>/dev/null || true
rm -f "${TMPM:-}" 2>/dev/null || true

# 5) Size (CWS limit 128 MB)
get_bytes() {
  # macOS stat -f%z vs Linux stat -c%s
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1" 2>/dev/null || wc -c < "$1" | tr -d ' '; fi
}
BYTES=$(get_bytes "$OUT" 2>/dev/null || echo 0)
MAX=$((128 * 1024 * 1024))
HUMAN=$(python3 -c "import sys; b=int(sys.argv[1]); print(f'{b/1024/1024:.1f} MB' if b>=1048576 else f'{b/1024:.0f} KB')" "$BYTES" 2>/dev/null || echo "${BYTES} bytes")
if [[ "$BYTES" -gt "$MAX" ]]; then fail "zip size $HUMAN exceeds CWS 128 MB limit"; else ok "zip size $HUMAN within CWS limit"; fi

# 6) Optional web-ext lint
if command -v npx >/dev/null 2>&1 && npx --yes web-ext --version >/dev/null 2>&1; then
  echo "  … running web-ext lint (warnings as errors)"
  if npx --yes web-ext lint --source-dir dist >/tmp/cws-webext.log 2>&1; then
    ok "web-ext lint passed"
  else
    warn "web-ext lint reported issues (see /tmp/cws-webext.log)"
    sed -n '1,80p' /tmp/cws-webext.log >&2 || true
  fi
else
  warn "web-ext not available – skipping 'web-ext lint' (install as dev dep to enable)"
fi

echo ""
if [[ $FAIL -ne 0 ]]; then
  echo "Verification: FAILED – fix the ✗ items above before uploading to CWS." >&2
  exit 4
fi
echo "Verification: PASSED"
echo ""
echo "=== CWS package ready ==="
echo "Version: $VERSION (public/manifest.json + package.json aligned)"
echo "ZIP: $OUT ($HUMAN)"
if [[ -f "$OUT.sha256" ]]; then echo "SHA256: $(cat "$OUT.sha256")  ($OUT.sha256)"; fi
echo "Also copied to: $DIST_ZIP"
echo ""
echo "Next:"
echo "  1. Test locally: unzip -d /tmp/cws-test \"$OUT\" && \\"
echo "     open chrome://extensions → Enable Developer mode → Load unpacked → /tmp/cws-test"
echo "     (also test once on Edge – same ZIP is valid for Edge Add-ons: edge://extensions)"
echo "  2. Tag GitHub release: git tag -a v$VERSION -m \"CWS unlisted $VERSION\" && git push origin v$VERSION"
echo "     (GitHub Release will attach $ZIP_NAME – the same file you upload to the Store)"
echo "  3. Chrome Web Store (scottsyms@gmail.com, already paid):"
echo "     https://chrome.google.com/webstore/devconsole → New Item or existing Unlisted item → Upload $ZIP_NAME"
echo "     Visibility: Unlisted (not searchable, direct link only) | Price: Free"
echo "     Privacy policy URL: https://raw.githubusercontent.com/ssc-dsai/CANChat-Agent/refs/heads/main/privacy.html"
echo ""
