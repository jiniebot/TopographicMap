# DayZ Map Renderer

An experimental Node.js toolchain and local web UI for inspecting DayZ world data, generating map layers, and coordinating tile-render workers.

## Requirements

This is a Windows-first development project, not a hosted service. It requires:

- Windows 10 or 11, Git, and Node.js 20+
- Legally obtained Steam installations of DayZ and DayZ Tools
- DayZ Tools' `P:` work drive with unpacked game data
- Mikero DePboTools (`ConvertWrp.exe` and `DeWrp.exe`) for Chernarus/Livonia processing
- Substantial free space; production output can exceed tens of gigabytes

Game assets, extracted data, caches, and tiles are intentionally absent from Git.

Only need one model's overhead outline? Use the standalone [P3D top-down shape tool](p3d-topdown/README.md); it does not require the map-staging or web-app pipeline.

## Install the code

```powershell
git clone <repository-url>
cd boundingboxes
npm ci
```

Do not launch the web app yet. Complete the staging preflight first.

## Preflight: stage map data for tile development

### 1. Prepare the P: work drive

Use DayZ Tools to mount `P:` and extract your legally obtained game data under `P:\DZ`. Never copy game data into this repository.

The supplied manifests require:

```text
P:\DZ\worlds\chernarusplus\world\chernarusplus.wrp
P:\DZ\worlds\chernarusplus\data\layers\
P:\DZ\surfaces\data\terrain\

P:\DZ\worlds\enoch\world\enoch.wrp
P:\DZ\worlds\enoch\data\layers\
P:\DZ\surfaces_bliss\data\terrain\

P:\DZ\worlds\sakhal\world\sakhal.wrp
P:\DZ\worlds\sakhal\data\layers\
P:\DZ\surfaces_sakhal\data\terrain\

P:\DZ\... all referenced P3D, PAA, and RVMAT assets
```

For nonstandard installations, set discovery paths in PowerShell:

```powershell
$env:DAYZ_WORKDRIVE = 'P:\'
$env:DAYZ_ROOT = 'C:\Program Files (x86)\Steam\steamapps\common\DayZ'
$env:DEWRP_PATH = 'C:\Program Files (x86)\Mikero\DePboTools\bin\DeWrp.exe'
```

The JSON files under `configs/maps/` contain the authoritative asset paths. Adjust a local manifest if your extracted-data layout differs.

### 2. Provide external elevation data

```powershell
foreach ($map in 'chernarus', 'livonia', 'sakhal') {
    New-Item -ItemType Directory -Force "P:\map-render-data\$map" | Out-Null
}
```

Supply raw, headerless, little-endian Float32 elevation grids:

| Map | Required file | Dimensions | Exact size |
|---|---|---:|---:|
| Chernarus | `P:\map-render-data\chernarus\chernarus_elevation.bin` | 1537 x 1537 | 9,449,476 bytes |
| Livonia | `P:\map-render-data\livonia\livonia_elevation.bin` | 1281 x 1281 | 6,563,844 bytes |
| Sakhal | `P:\map-render-data\sakhal\sakhal_elevation.bin` | 1537 x 1537 | 9,449,476 bytes |

The grids use southwest-origin local coordinates. The renderer consumes them but does not currently include an elevation exporter; export them from an authorized terrain source.

### 3. Provide Sakhal runtime placements

Sakhal uses runtime-exported placements rather than the Chernarus/Livonia WRP placement pipeline. Run `ebo/runtime-export/init.c` in a local DayZ server environment and place all generated TSV files, including `sakhal-placement-summary.tsv`, under:

```text
P:\map-render-data\sakhal\runtime-export\
```

Do not put the server profile or exported TSV data in this repository.

### 4. Discover and inspect inputs

Check WRP discovery for Chernarus and Livonia:

```powershell
node preflight/wrp/discover-world.js chernarusplus
node preflight/wrp/discover-world.js enoch
```

Inspect every selected map:

```powershell
node tools/mapdraw/map-render.js inspect configs/maps/chernarus.json
node tools/mapdraw/map-render.js inspect configs/maps/livonia.json
node tools/mapdraw/map-render.js inspect configs/maps/sakhal.json
```

The P-drive assets, elevation grid, and Sakhal runtime inputs should report `[ok]`. The transform index will be missing until the next step.

### 5. Build caches and placement indexes

```powershell
node preflight/stage-map.js --manifest configs/maps/chernarus.json
node preflight/stage-map.js --manifest configs/maps/livonia.json
node preflight/stage-map.js --manifest configs/maps/sakhal.json
```

For Chernarus/Livonia, this discovers and converts the WRP, extracts and normalizes placements, renders model caches, and builds transform/vector indexes. For Sakhal, it imports the runtime placement export before building caches and indexes. The pipeline is resumable and writes generated data only beneath ignored `out/` paths.

Re-run the three `inspect` commands afterward. Every required check must report `[ok]`.

### 6. Render and review previews

```powershell
node tools/mapdraw/map-render.js preview configs/maps/chernarus.json
node tools/mapdraw/map-render.js preview configs/maps/livonia.json
node tools/mapdraw/map-render.js preview configs/maps/sakhal.json
```

Review `out/mapdraw/builds/<map>/`. Confirm terrain orientation, satellite alignment, surface materials, water, object placement, and model footprints before producing full tiles.

### 7. Launch the web app

```powershell
Copy-Item .env.example .env
node --env-file=.env server.js
```

Open `http://127.0.0.1:8080/map-render-app.html`. The server defaults to localhost and its API has no authentication, so never expose it publicly.

For trusted LAN workers, set `HOST=0.0.0.0`, leave `DAYZ_ASSET_ROOT=P:\`, and restrict port 8080 with a firewall or VPN.

### 8. Render production tiles

Create a final-build job through the web UI, or build all configured maps at zooms 1-6:

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-full-build.ps1
```

One-map direct example:

```powershell
node tools/mapdraw/build-final-zoom.js `
  --manifest configs/maps/chernarus.json `
  --version local-v1 `
  --zooms 1,2,3,4,5,6 `
  --modes satellite,topographic `
  --workers 6
```

Production output stays under ignored `out/mapdraw/final/`. Add `--resume` to continue an interrupted direct build. See [the detailed staging guide](docs/RENDER_STAGING.md) for troubleshooting and pre-push safety checks.

## Repository layout

- `configs/` - map manifests and rendering styles
- `public/` and top-level HTML files - browser UI
- `preflight/` - discovery, extraction, and cache preparation
- `tools/mapdraw/` - current renderer
- `tools/data-prep/` - input preprocessing
- `deploy/` - deployment helpers and nginx examples
- `ebo/runtime-export/` - Sakhal placement exporter source, not its output
- `old/` - unsupported historical experiments

## Security and data policy

Never commit `.env`, DayZ assets, PBO/EBO/WRP files, models, textures, runtime profiles, placement exports, caches, tiles, logs, crash dumps, or deployment state. All DayZ content must remain on the local `P:` drive.

Before pushing, run the asset and history checks in [the detailed staging guide](docs/RENDER_STAGING.md).

## Legal

This unofficial project is not affiliated with or endorsed by Bohemia Interactive. DayZ names and assets belong to their respective owners. No project license has been selected yet; add one before permitting reuse or accepting contributions.
