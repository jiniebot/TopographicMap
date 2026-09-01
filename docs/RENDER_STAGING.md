# Render staging from a fresh clone

This repository contains renderer code only. DayZ game content, extracted world data, packages, models, textures, elevation grids, placement exports, caches, and rendered tiles must never be committed.

The supplied manifests expect unpacked assets under `P:\DZ` and renderer-specific external inputs under `P:\map-render-data`.

## 1. Install prerequisites

- Windows 10/11, Git, and Node.js 20+
- Steam installations of DayZ and DayZ Tools
- Mikero DePboTools (`ConvertWrp.exe` and `DeWrp.exe`) for Chernarus/Livonia processing
- Substantial free space: production output can exceed tens of gigabytes

```powershell
git clone <repository-url>
cd boundingboxes
npm ci
```

## 2. Prepare the P: work drive

Use DayZ Tools to mount `P:` and extract your legally obtained game data to `P:\DZ`. Never copy it into this repository.

Each map needs these inputs:

```text
P:\DZ\worlds\<world>\world\<world>.wrp
P:\DZ\worlds\<world>\data\layers\
P:\DZ\surfaces*\data\terrain\
P:\DZ\... referenced P3D, PAA, and RVMAT assets
```

Configured world names are `chernarusplus`, `enoch`, and `sakhal`. Consult `configs/maps/*.json` for exact paths.

For nonstandard installations, set the relevant discovery variables:

```powershell
$env:DAYZ_WORKDRIVE = 'P:\'
$env:DAYZ_ROOT = 'C:\Program Files (x86)\Steam\steamapps\common\DayZ'
$env:DEWRP_PATH = 'C:\Program Files (x86)\Mikero\DePboTools\bin\DeWrp.exe'
```

`DAYZ_ASSET_ROOT` controls server/worker asset access, but manifests currently contain explicit P-drive paths. Edit a local manifest if your layout differs.

## 3. Stage external renderer inputs

```powershell
foreach ($map in 'chernarus', 'livonia', 'sakhal') {
    New-Item -ItemType Directory -Force "P:\map-render-data\$map" | Out-Null
}
New-Item -ItemType Directory -Force 'P:\map-render-data\sakhal\runtime-export' | Out-Null
```

Provide raw little-endian Float32 elevation grids:

```text
P:\map-render-data\chernarus\chernarus_elevation.bin  (1537 x 1537; 9,449,476 bytes)
P:\map-render-data\livonia\livonia_elevation.bin      (1281 x 1281; 6,563,844 bytes)
P:\map-render-data\sakhal\sakhal_elevation.bin       (1537 x 1537; 9,449,476 bytes)
```

They have no header and use southwest-origin local coordinates. This repository consumes these grids but does not currently include an elevation exporter; export them from an authorized terrain source before continuing.

Sakhal uses runtime-exported placements instead of the WRP placement pipeline. Run `ebo/runtime-export/init.c` in a local DayZ server environment, then place all produced TSVs, including `sakhal-placement-summary.tsv`, in:

```text
P:\map-render-data\sakhal\runtime-export\
```

The exporter is repository source code; its server profile and exported data are not.

## 4. Discover and inspect inputs

For WRP-based maps:

```powershell
node preflight/wrp/discover-world.js chernarusplus
node preflight/wrp/discover-world.js enoch
```

Then inspect every selected map:

```powershell
node tools/mapdraw/map-render.js inspect configs/maps/chernarus.json
node tools/mapdraw/map-render.js inspect configs/maps/livonia.json
node tools/mapdraw/map-render.js inspect configs/maps/sakhal.json
```

Before cache staging, only the transform-index check should be missing. Correct all missing P-drive assets, elevation grids, or Sakhal runtime inputs first. Discovery may locate installed PBO/EBO packages, but staging needs an authorized unpacked WRP.

## 5. Build caches and placement indexes

```powershell
node preflight/stage-map.js --manifest configs/maps/chernarus.json
node preflight/stage-map.js --manifest configs/maps/livonia.json
node preflight/stage-map.js --manifest configs/maps/sakhal.json
```

For Chernarus/Livonia this discovers and converts the WRP, extracts/normalizes placements, renders the model cache, builds the transform index, and builds vector footprints. For Sakhal it imports the runtime export before building caches and indexes.

The pipeline is long-running and resumable. Generated files stay beneath ignored `out/`.

## 6. Inspect again and approve previews

Repeat each `inspect` command; every check must now be `[ok]`. Then render previews:

```powershell
node tools/mapdraw/map-render.js preview configs/maps/chernarus.json
node tools/mapdraw/map-render.js preview configs/maps/livonia.json
node tools/mapdraw/map-render.js preview configs/maps/sakhal.json
```

Review `out/mapdraw/builds/<map>/` for terrain orientation, satellite alignment, materials, water, placements, and footprints before a full build.

## 7. Launch the web app

```powershell
Copy-Item .env.example .env
node --env-file=.env server.js
```

Open `http://127.0.0.1:8080/map-render-app.html`. Keep the localhost default unless trusted LAN workers are required. For LAN workers, set `HOST=0.0.0.0`, retain `DAYZ_ASSET_ROOT=P:\`, and restrict port 8080 with a firewall or VPN. The API has no authentication.

## 8. Render production tiles

Use the web UI after preview approval, or run the existing all-map zoom 1–6 build:

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

Output stays under ignored `out/mapdraw/final/`. Add `--resume` after interruption.

## 9. Pre-push safety check

```powershell
git status --short
git ls-files | Select-String -Pattern '\.(pbo|ebo|wrp|pew|p3d|paa|pac|edds|rvmat|bikey|bisign|dta)$'
git ls-files data out
git rev-list --objects --all | Select-String -Pattern ' (data|out)/|\.(pbo|ebo|wrp|pew|p3d|paa|pac|edds|rvmat|bikey|bisign|dta|bin)$'
```

The last three commands must return nothing. The history check matters because `.gitignore` and `git rm --cached` do not remove blobs from older commits. If it finds anything, create a clean public root commit or rewrite the private history before adding a public remote. Never use `git add -f` for DayZ assets or generated output.
