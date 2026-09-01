# P3D Top-Down Shape

A small standalone Windows CLI that accepts one DayZ `.p3d` model and produces a top-down GeoJSON silhouette. It can optionally write the projected model as a transparent PNG.

It does not unpack PBOs and does not need the map renderer, web app, map manifests, or model caches.

## Requirements

- Windows
- Node.js 20+
- DayZ Tools
- The model and all referenced assets available beneath the DayZ `P:` work drive
- `p3d2bmp.exe`, normally installed at:

```text
C:\Program Files (x86)\Steam\steamapps\common\DayZ Tools\Bin\TerrainBuilder\p3d2bmp.exe
```

No P3D or generated output should be committed. This package's `.gitignore` excludes them.

## Install

```powershell
cd p3d-topdown
npm ci
```

## Produce a normalized GeoJSON shape

```powershell
node p3d-topdown.js P:\DZ\structures\residential\houses\house_1w03.p3d
```

Default output:

```text
output\house_1w03-topdown.geojson
```

Without physical dimensions, coordinates are normalized independently to the visible model bounds: X and Z each span approximately `-0.5` to `+0.5`. Use this for shape comparison or supply model dimensions for placement-ready meters.

## Produce meter coordinates and a PNG

```powershell
node p3d-topdown.js P:\DZ\structures\residential\houses\house_1w03.p3d `
  --width-meters 12.4 `
  --depth-meters 8.7 `
  --png
```

With both dimensions supplied, GeoJSON coordinates use model-local meters centered on `[0, 0]`: X is east/west and the second coordinate is model-local Z.

## Options

```text
--out <file>            GeoJSON output path
--png                   Also write a transparent PNG beside the GeoJSON
--png-out <file>        Write the PNG to a specific path (implies --png)
--size <64..4096>       Projection resolution; default 1024
--lod <number>          p3d2bmp LOD; default 0
--width-meters <n>      Known model X span in meters
--depth-meters <n>      Known model Z span in meters
--simplify-pixels <n>   Silhouette simplification tolerance; default 1.5
--asset-root <path>     DayZ asset root; default P:\
--p3d2bmp <file>        Override the p3d2bmp.exe path
--help                  Show command help
```

Both `--width-meters` and `--depth-meters` must be supplied together.

## Outputs

The GeoJSON is one `Feature` with `MultiPolygon` geometry and metadata describing the source model, projection settings, units, visible pixel bounds, polygon count, and vertex count.

The optional PNG has a transparent background. Its pixel dimensions equal `--size` and the source projection remains centered exactly as rendered by `p3d2bmp`.

## Limitations

- The silhouette represents the selected visual LOD projected from above; it is not a Geometry/FireGeometry collision outline.
- Physical dimensions cannot be inferred reliably from the raster alone. Supply both meter dimensions when the output will be placed in map coordinates.
- Models with unusual render backgrounds or no visible selected LOD may need a different `--lod` or projection size.
