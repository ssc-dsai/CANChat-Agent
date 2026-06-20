# Vendored DuckDB-WASM extensions (offline)

These are official DuckDB extension binaries, vendored so the data engine can load
them with no network access (GC PBMM / air-gapped deployments).

Layout mirrors what the engine requests from a custom extension repository:

    duckdb-ext/<engineVersion>/<platform>/<name>.duckdb_extension.wasm

The engine version is the DuckDB version bundled by `@duckdb/duckdb-wasm` (NOT the
npm package version). For `@duckdb/duckdb-wasm@1.32.0` that is **v1.4.3**, platform
**wasm_eh**.

Loaded via `SET custom_extension_repository='chrome-extension://<id>/duckdb-ext'`
then `INSTALL <name>; LOAD <name>` (see src/offscreen/duckDb.ts).

## Re-vendoring after a duckdb-wasm bump

1. Find the new engine version: `SELECT version();` (e.g. `v1.4.5`).
2. Download the matching `wasm_eh` binaries into `duckdb-ext/<version>/wasm_eh/`:

       curl -sL https://extensions.duckdb.org/<version>/wasm_eh/spatial.duckdb_extension.wasm \
         -o duckdb-ext/<version>/wasm_eh/spatial.duckdb_extension.wasm

3. Delete the old version directory.

## Currently vendored

- `spatial` (core) — ST_Read for GeoJSON/KML/GPX/FGB, GeoParquet, geospatial SQL.

XML (the `webbed` community extension) is intentionally NOT vendored: its wasm_eh
build fails to load (`bad export type for 'xmlFree'`) even from the official CDN.
