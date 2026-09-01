# DayZ World → Satellite-Style Map Generator

## Map-Agnostic Build Workflow (current direction)

### Output modes and zoom policy

The production ceiling is zoom 8 for both output modes.

- **Satellite** is a raster pyramid. It combines reconstructed terrain imagery
  with elevation-aware top-down P3D raster renders.
- **Topographic** is a vector-tile pyramid. Terrain elevation bands/contours,
  classified surface regions, water, roads, and projected P3D upper-surface
  footprints remain separate feature layers and are styled in the web client.

Topographic source data remains vector, but it is spatially clipped and
simplified into 256px-equivalent MVT tiles per zoom rather than sending a
whole-map GeoJSON/SVG document to the browser. This preserves sharp geometry,
supports live colors/line widths/layer toggles, and bounds browser memory and
draw cost to the visible tiles.

Object geometry must come from the selected visual/geometry LOD projected onto
the X/Z plane, never from cached bounding rectangles. During model-cache
generation, upward-facing and top-visible triangles are unioned into a reusable
local-space footprint with height attributes. Placement transforms then rotate,
scale, tilt, and translate that footprint into world space. Tile generation
clips features to tile bounds, performs zoom-dependent simplification, and
resolves top-down occlusion using absolute surface elevation before encoding.

Surface classification uses the same compiled terrain-layer/material inputs as
the enhanced satellite generator, but emits categorical polygons (forest,
grass, soil, rock, paved, water, and map-specific classes) instead of texture.
The heightmap remains the authority for contour lines and terrain elevation;
placed water geometry is masked against its own local surface elevation.

The product boundary is now a manifest-driven renderer rather than a set of
Enoch-specific scripts. A map manifest supplies the WRP, unpacked asset root,
transform index, elevation grid, satellite/layer source, terrain surface
textures, map dimensions, preview defaults, and output directory.

Current commands:

```powershell
node tools/mapdraw/map-render.js inspect configs/maps/livonia.json
node tools/mapdraw/map-render.js preview configs/maps/livonia.json --x 7670 --z 4965 --meters 400 --zoom 7
node tools/mapdraw/map-render.js build configs/maps/livonia.json --approve-full-build
```

`inspect` validates source assets. `preview` renders reconstructed terrain and
the original cached P3D sprites directly at the requested resolution, then
writes an approval record beside the preview. `build` is deliberately gated;
full-map XYZ orchestration is the next implementation stage and must remain
resumable because zoom-8 maps contain tens of thousands of tiles.

The Livonia reference manifest is `configs/maps/livonia.json`. The first
end-to-end manifest preview was generated at
`out/mapdraw/builds/livonia/previews/7670-4965-400m-z7/`.

## Implementation Status

Phase 1 discovery is executable with:

```powershell
node tools/mapdraw/discover-world.js enoch
```

This locates and validates the local Livonia/Enoch WRP, finds its source PBO,
and writes `out/mapdraw/enoch-discovery.json` for subsequent extraction/parsing
steps. Set `DAYZ_WORKDRIVE` or `DAYZ_ROOT` if DayZ uses non-standard paths.

The initial placement inventory is also implemented:

```powershell
node tools/mapdraw/extract-wrp-objects.js
node tools/mapdraw/normalize-dewrp-objects.js
```

For the current Livonia WRP this produces 2,932,069 placement records across
2,484 unique P3D paths. Every referenced P3D resolves beneath the unpacked
`P:\DZ` asset tree. The DeWrp inventory contains object ID and X/Z position;
orientation, scale, and elevation still require a richer WRP conversion/parser.

Model inspection is executable with:

```powershell
node tools/mapdraw/inspect-model.js
```

The Livonia house proof-of-concept resolves all 113 external asset references
and successfully decodes a diffuse PAA to RGBA. The selected vanilla model is
ODOL v54, however, and the current `@bis-toolkit/p3d` package supports MLOD
only. The pinned Agentic-Z `dayz-p3d-debin` tool now bridges ODOL v54 to MLOD:

```powershell
node tools/mapdraw/debin-model.js
```

The converted house reads successfully in BIS Toolkit with all 11 LODs,
61,211 vertices, 35,775 faces, texture paths, and material paths. Constructing
the selected visual LOD as a renderable mesh is implemented with:

```powershell
node tools/mapdraw/render-model-top.js
```

The proof-of-concept selects visual LOD 1, triangulates it, resolves direct and
RVMat texture references, decodes PAA textures, rasterizes from above with a
height buffer, and writes a transparent PNG plus meter/pixel metadata. Multi
materials are currently approximated using their first UV set because the
ODOL-to-MLOD converter intentionally drops additional UV sets.

The follow-up alpha tests also pass through the same pipeline:

- `t_piceaabies_3f_summer.p3d`: visual LOD 1, 8,282 triangles, three texture
  inputs, transparent 8.17 m by 7.79 m spruce canopy.
- `decal_damage_long6.p3d`: one quad/two triangles, transparent cracked-road
  marking over a 6.11 m by 12.89 m footprint.

These validate alpha-cutout vegetation and flat decal rendering before moving
to unique-model cache automation.

The resumable Livonia unique-model cache is implemented with:

```powershell
node tools/mapdraw/build-model-cache.js --size 512
```

Current result: 2,479 of 2,484 unique models rendered to 512px RGBA cache
entries (223.1 MB total). State and errors are checkpointed after every model
in `out/mapdraw/cache/enoch/cache-state.json`; temporary MLODs are deleted.
Five ODOL reader failures remain: four stump variants and `p_heracleum.p3d`.
The successful cache covers 97.117% of all Livonia placement instances.

The first map integration is now executable with:

```powershell
node tools/mapdraw/build-livonia-scene.js
node tools/mapdraw/build-livonia-raster-tiles.js --zoom 7
```

`mapgrouppos.xml` supplies exact XYZ and rotation for the first 5,753
important placed objects; 5,745 join to DeWrp model paths and cached renders.
The sparse raster pyramid currently contains 2,292 native zoom-7 tiles.
Objects are painter-sorted by absolute top elevation (`placement elevation +
model maxY`) so an upper object occludes a lower one. Per-pixel model height
buffers are the next occlusion refinement. The map UI now calls the two styles
Raster and Vector and exposes the Livonia raster-object preview.

Full transform extraction is now implemented with:

```powershell
node tools/mapdraw/extract-8wvr-transforms.js
```

For Livonia this produces exactly 2,932,069 transform-complete records across
2,484 models in `out/mapdraw/enoch-transforms.ndjson`. Each record preserves
XYZ, yaw, independent axis scales, and the complete normalized 3x3 placement
basis for later slope/tilt-aware rendering. RoadNet placement semantics were
also established: compiled road transforms are segment centers (the average
of their RoadPositions), so road PNGs must be centered directly on those
transforms rather than receiving an ordinary P3D-origin offset.

The multi-million-object stream now has a compact spatial index:

```powershell
node --max-old-space-size=1024 tools/mapdraw/build-transform-index.js
```

`out/mapdraw/index/enoch/` contains a 164.2 MB fixed-record transform store,
an 11.8 MB native-tile membership index, and a model table. All 2,932,069
records are accounted for across 15,491 non-empty zoom-7 buckets; the densest
bucket contains 885 objects. `tools/mapdraw/transform-index.js` provides bounded
tile queries and record decoding for the full raster/vector renderers.

## Goal

Build a tool that takes a vanilla or custom DayZ terrain such as **Livonia/Enoch** and reconstructs it as a high-resolution, top-down, satellite-style map using the actual terrain data, object placements, 3D models, and textures contained in DayZ.

The final result could resemble a Google Earth / satellite view rather than DayZ's normal illustrated 2D map.

It should also retain the underlying object data so individual buildings, roads, props, etc. can remain identifiable and clickable.

---

## Overall Pipeline

```text
DayZ World
│
├── Terrain
│   ├── Heightmap
│   ├── Satellite texture
│   └── Surface data
│
└── WRP
    │
    └── Every placed world object
        ├── P3D/model path
        ├── XYZ position
        ├── rotation/orientation
        └── scale
             │
             ▼
          P3D model
             │
        BIS Toolkit
        ┌────┴────┐
        │         │
     Geometry   Materials/UVs
        │         │
        │      PAA / EDDS
        │         │
        └────┬────┘
             ▼
      Top-down renderer
             │
       cached model image
             │
             ▼
       WRP transformation
             │
     position / rotate / scale
             │
             ▼
      Composite over terrain
             │
             ▼
       Satellite map tiles
```

## 1. Extract World Object Placements

The DayZ `.wrp` world file contains the static objects placed throughout the terrain.

For Livonia the world is internally called **Enoch**.

The WRP needs to be parsed to recover, for every placed object:

```json
{
  "model": "DZ/structures/residential/house.p3d",
  "position": [5832.14, 214.2, 7245.82],
  "rotation": 1.883,
  "scale": 1.0
}
```

One established tool for extracting information from WRP files is **Mikero's DeWRP**, part of Mikero's Tools:

[Mikero's Tools / DeWRP](https://mikero.bytex.digital/?utm_source=chatgpt.com)

Bohemia's Terrain Builder is also useful for inspecting DayZ/Arma terrain projects and their object layers:

[Bohemia Interactive — Terrain Builder documentation](https://community.bohemia.net/wiki/Terrain_Builder?utm_source=chatgpt.com)

Ideally, the final pipeline should parse WRP directly so Terrain Builder does not need to be running.

---

## 2. Extract DayZ PBOs

DayZ's vanilla assets are packaged into `.pbo` archives.

The relevant PBOs need to be extracted so that paths referenced by the WRP can be resolved to their corresponding `.p3d`, texture and material files.

Bohemia provides the official **DayZ Tools** package through Steam:

[DayZ Tools on Steam](https://store.steampowered.com/app/830640/DayZ_Tools/?utm_source=chatgpt.com)

Mikero's Tools also provide extensive PBO manipulation utilities:

[Mikero's Tools](https://mikero.bytex.digital/?utm_source=chatgpt.com)

The resulting extracted asset tree would resemble:

```text
DZ/
├── structures/
│   ├── residential/
│   ├── industrial/
│   └── military/
├── roads/
├── plants/
└── ...
```

---

## 3. Parse the Binarized P3D Models

Vanilla DayZ P3Ds are generally binarized **ODOL** models.

They do not need to be converted into Blender/OBJ files merely to generate the map.

Instead, use **BIS Toolkit** to read the P3Ds programmatically.

BIS Toolkit:

[BIS Toolkit GitHub repository](https://github.com/Koncord/BIS-Toolkit?utm_source=chatgpt.com)

P3D package:

[@bis-toolkit/p3d on npm](https://www.npmjs.com/package/@bis-toolkit/p3d?utm_source=chatgpt.com)

The parser provides access to model LOD information including geometry such as vertices and faces.

For satellite rendering, use an appropriate **visual Resolution LOD**, rather than relying solely on the Geometry LOD.

This is important because objects such as:

* road markings
* ground decals
* vegetation
* signs
* decorative objects

may have little or no collision geometry while still containing visible geometry.

Bohemia's documentation on P3D/LOD concepts:

[Bohemia Interactive — P3D File Format](https://community.bohemia.net/wiki/P3D_File_Format?utm_source=chatgpt.com)

[Bohemia Interactive — LOD documentation](https://community.bohemia.net/wiki/LOD?utm_source=chatgpt.com)

---

## 4. Resolve and Decode Textures

The visual P3D geometry references materials/textures.

DayZ primarily uses formats including `.paa` and `.edds`.

BIS Toolkit contains parsers/decoders for these formats.

PAA:

[@bis-toolkit/paa](https://www.npmjs.com/package/@bis-toolkit/paa?utm_source=chatgpt.com)

EDDS:

[@bis-toolkit/edds](https://www.npmjs.com/package/@bis-toolkit/edds?utm_source=chatgpt.com)

BC texture compression decoding:

[@bis-toolkit/bcn](https://www.npmjs.com/package/@bis-toolkit/bcn?utm_source=chatgpt.com)

The desired result is an RGBA pixel buffer that can be uploaded to the renderer as a normal texture.

For the first implementation, only the primary diffuse/albedo texture needs to be reproduced.

It is unnecessary initially to reproduce DayZ's complete shader system including normal maps, specular maps, reflections, damage materials, etc.

---

## 5. Render Each Unique P3D From Directly Above

Reconstruct the selected P3D visual LOD in a lightweight renderer.

**Three.js** would be a practical choice:

[Three.js](https://threejs.org/?utm_source=chatgpt.com)

[Three.js GitHub repository](https://github.com/mrdoob/three.js?utm_source=chatgpt.com)

Create the mesh using:

* P3D vertices
* P3D faces
* P3D UV coordinates
* decoded DayZ textures

Then render it using a straight-down **OrthographicCamera**.

Initially, an unlit material such as `MeshBasicMaterial` would be desirable.

That makes:

```text
source texture color ≈ rendered map color
```

without having to reproduce DayZ lighting.

The output for each model becomes a transparent image such as:

```text
cache/
├── land_house_1w01/
│   ├── top.webp
│   └── metadata.json
│
├── land_barn_01/
│   ├── top.webp
│   └── metadata.json
│
└── road_asphalt_10/
    ├── top.webp
    └── metadata.json
```

Metadata records the relationship between pixels and model-space meters:

```json
{
  "widthMeters": 12.42,
  "heightMeters": 18.71,
  "origin": [-1.23, 0.42]
}
```

---

## 6. Render Every Unique Model Only Once

This is an important optimization.

If the WRP contains hundreds of thousands of placed objects but only a few thousand unique P3D models, the expensive P3D → image operation only happens once per unique model.

For example:

```text
600,000 WRP placements

        ↓

4,000 unique P3Ds

        ↓

4,000 top-down renders
```

Every subsequent object is simply a transformed copy of its cached image.

---

## 7. Reconstruct the World

For each WRP object:

1. Find its cached top-down P3D image.
2. Scale it according to the WRP transformation.
3. Rotate it according to its WRP orientation.
4. Translate it to its world X/Z position.
5. Composite it onto the terrain.

For example:

```text
WRP:

warehouse.p3d
position = 5832.14 / 7245.82
rotation = 137.5°
scale = 1

                ↓

warehouse_top.webp

                ↓

rotate 137.5°

                ↓

place at 5832.14 / 7245.82
```

This process is repeated for all world objects.

---

## 8. Terrain Background

The base layer should come from the terrain itself.

The existing DayZ terrain data provides the starting satellite/surface imagery and height information.

The object renderer is then composited over that base.

Conceptually:

```text
DayZ terrain satellite image
            +
        buildings
            +
          trees
            +
         roads
            +
      road markings
            +
         fences
            +
       vehicles/props
            =
   reconstructed aerial map
```

The heightmap can later be used to introduce terrain-aware shading and correctly handle objects placed on slopes.

---

## 9. Decals and Transparent Objects

Using the visual LOD rather than collision geometry allows objects without collision to render normally.

A road marking might simply consist of:

```text
textured quad
+
UV coordinates
+
transparent PAA/EDDS
```

Rendering the texture with its alpha channel automatically produces the actual visible marking rather than the rectangular boundary of the P3D.

The same technique applies to many ground decals and other flat visual objects.

---

## 10. Vegetation

Trees can potentially be handled using exactly the same system.

Their visual geometry and alpha-tested foliage textures can be rendered orthographically.

Instead of representing a tree as:

```text
●
```

the map could contain an approximation of its actual DayZ canopy.

Rendering the many real vegetation placements should dramatically improve the satellite-image appearance of the finished map.

---

## 11. Optional Satellite-Style Lighting

Once the basic texture renderer works, introduce simplified aerial lighting.

There is no need to duplicate DayZ's renderer.

A simple directional light can provide:

* brighter sun-facing roofs
* darker opposite roof surfaces
* subtle object shadows
* terrain relief

This should make buildings and vegetation read much more naturally from above.

A second render pass could generate object shadows independently from the color imagery.

---

## 12. Generate Map Tiles

Rather than generating one enormous PNG, generate standard map tiles:

```text
tiles/
└── {z}/
    └── {x}/
        └── {y}.webp
```

This makes the result suitable for an interactive web map.

Possible frontend libraries include:

[Leaflet](https://leafletjs.com/?utm_source=chatgpt.com)

or:

[MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/?utm_source=chatgpt.com)

Different detail levels can be rendered at different zoom levels.

At distant zoom:

```text
terrain
forests
major roads
large buildings
```

At close zoom:

```text
individual buildings
cars
fences
road markings
small structures
props
```

---

## 13. Keep a Parallel Vector/Object Database

The raster satellite imagery should not replace the extracted WRP data.

Maintain an object database alongside it:

```json
{
  "id": 184392,
  "class": "Land_House_1W01_F",
  "model": "DZ/structures/residential/house_1w01_f.p3d",
  "position": [5832.14, 214.2, 7245.82],
  "rotation": 137.5,
  "scale": 1
}
```

Optionally also calculate each object's projected 2D footprint from its P3D geometry.

This provides both:

```text
RASTER
Actual satellite-style appearance

+

VECTOR
Exact object identity/geometry/data
```

An interactive map could therefore allow the user to click a visible building and retrieve its DayZ classname, P3D, coordinates and other metadata.

---

# Proposed Implementation Stack

The project could remain largely JavaScript/TypeScript based.

```text
WRP extraction/parser
        ↓
PBO extraction
        ↓
@bis-toolkit/p3d
        ↓
@bis-toolkit/paa
@bis-toolkit/edds
@bis-toolkit/bcn
        ↓
Three.js
        ↓
cached orthographic renders
        ↓
world compositor
        ↓
XYZ WebP map tiles
        ↓
Leaflet / MapLibre
```

The first proof of concept should **not attempt to process Livonia immediately**.

Instead:

1. Extract one vanilla DayZ house P3D.
2. Parse its visual LOD with BIS Toolkit.
3. Resolve its primary texture.
4. Decode the texture.
5. Reconstruct the textured mesh.
6. Render it from directly overhead.
7. Save a transparent PNG/WebP.

If that produces a recognizable textured aerial view of a vanilla DayZ house, the most uncertain part of the entire pipeline has been proven.

The next test should be a **tree** and a **road/decal object**, because those verify alpha textures and non-building geometry.

After those three cases work, move on to WRP extraction and automated whole-map composition.

## Key Resources

* [BIS Toolkit GitHub](https://github.com/Koncord/BIS-Toolkit?utm_source=chatgpt.com) — core DayZ/Bohemia binary-format parsing project.
* [BIS Toolkit P3D parser](https://www.npmjs.com/package/@bis-toolkit/p3d?utm_source=chatgpt.com) — ODOL/MLOD model parsing.
* [BIS Toolkit PAA decoder](https://www.npmjs.com/package/@bis-toolkit/paa?utm_source=chatgpt.com) — PAA texture decoding.
* [BIS Toolkit EDDS decoder](https://www.npmjs.com/package/@bis-toolkit/edds?utm_source=chatgpt.com) — DayZ EDDS texture decoding.
* [BIS Toolkit BCN decoder](https://www.npmjs.com/package/@bis-toolkit/bcn?utm_source=chatgpt.com) — BC-compressed texture decoding.
* [Mikero's Tools](https://mikero.bytex.digital/?utm_source=chatgpt.com) — DeWRP and PBO/Bohemia file utilities.
* [DayZ Tools on Steam](https://store.steampowered.com/app/830640/DayZ_Tools/?utm_source=chatgpt.com) — official Bohemia DayZ development tools.
* [Terrain Builder documentation](https://community.bohemia.net/wiki/Terrain_Builder?utm_source=chatgpt.com) — official terrain editing workflow.
* [Bohemia P3D documentation](https://community.bohemia.net/wiki/P3D_File_Format?utm_source=chatgpt.com) — model format reference.
* [Bohemia LOD documentation](https://community.bohemia.net/wiki/LOD?utm_source=chatgpt.com) — explanation of visual, Geometry, Roadway and other LODs.
* [Three.js](https://threejs.org/?utm_source=chatgpt.com) — proposed lightweight 3D renderer.
* [Leaflet](https://leafletjs.com/?utm_source=chatgpt.com) — possible raster tile frontend.
* [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/?utm_source=chatgpt.com) — alternative high-performance interactive map frontend.

The **critical proof-of-concept is P3D → textured top-down PNG**. If BIS Toolkit exposes the required visual LOD, UV and material references cleanly enough to render one vanilla DayZ house correctly, the rest becomes primarily an extraction, transformation, caching and large-scale rendering problem.
