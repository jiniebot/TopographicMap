# Server JSON building overlay

The inventory overlay reuses the cached PNGs rather than rerendering P3Ds or
generating per-server map tiles. Export only authoritative class/model mappings:

```powershell
node preflight/cache/export-inventory-sprites.js --runtime ebo/runtime-export/profile
# Or provide a JSON object: { "Land_Example": "dz/structures/example.p3d" }
node preflight/cache/export-inventory-sprites.js --classes path/to/class-models.json
```

Both inputs can be supplied together. Conflicting class mappings are excluded,
not guessed. Only complete cached sprites with valid bounds and scale are
published. The default output is ignored `out/mapdraw/inventory-sprites/`.
Content-addressed PNGs are reused on repeat exports; the catalog is replaced
atomically after all referenced sprites have been copied. Obsolete hash files
are retained for safe rollback; publish into a fresh release directory to reclaim
old releases through the normal deployment workflow.

The saved Sakhal runtime export initially resolves 550 cached classes. This is
partial coverage of all DayZ classes; add a full runtime config export to cover
classes not present among Sakhal's terrain placements. Never infer a class from
a P3D basename. Current overlays handle upright models, yaw and uniform scale;
tilted models require their own projection and remain not drawable.

Deploy `catalog.json` to the bot and the output directory to the interface:

- Bot: `JSON_INVENTORY_FOOTPRINT_CATALOG=/path/to/catalog.json`
- Interface: `JSON_INVENTORY_SPRITES_DIR=/path/to/export-directory`

Development automatically discovers the output in the sibling boundingboxes
checkout. Production must configure both paths explicitly. Sprites are shared
by all servers, with no Nitrado requests during rendering. Do not commit generated
sprites, exported classes, previews, or game assets.

The export also includes cached model-local vector footprints when available
(549 of the initial 550 sprites). These are content-addressed JSON files. The
interface uses textured PNGs only in satellite mode; topographic mode uses these
polygons and the same object-color expression/palette as the base topographic map.
Missing vector footprints are skipped in topographic mode, never replaced with
satellite imagery. Polygon holes and model-local metre coordinates are preserved.

Scale is `image pixels * metersPerPixel * JSON scale` for raster sprites and
`local vertex metres * JSON scale` for vector footprints. Raster metadata includes
the source renderer's 4% padding on each side; do not stretch the whole PNG to the
unpadded model bounds. Bitmap centering is applied only to raster placement;
vector vertices already contain their offset from the model origin.

Overlays draw at every zoom level in both modes. Placements scaled below 0.10 are omitted from drawing as deliberately miniaturized objects, but remain in the inventory. Full-map queries retain bounded paging, decompression and rendering budgets.

CDN publishing:
- Run `node preflight/cache/inventory-sprite-manifest.js` to generate an upload manifest containing only assets referenced by the current catalog. It excludes previews, retired assets and the manifest itself.
- Upload the manifest's PNG/JSON files under a dedicated CDN prefix using their listed Content-Type and Cache-Control headers. Publish catalog.json last. Verify uploaded sizes/checksums before switching consumers.
- Allow cross-origin GET from the dashboard (Access-Control-Allow-Origin: * is suitable for these shared public assets). No game-server placements or credentials belong in this prefix.
- Set web `JSON_INVENTORY_SPRITES_URL=https://<cdn>/<prefix>` to fetch PNGs and footprint geometry directly from the CDN. The authenticated API continues serving server-specific placements.
- Keep a matching small catalog.json on the web host (`JSON_INVENTORY_SPRITES_DIR`) and bot host (`JSON_INVENTORY_FOOTPRINT_CATALOG`). CDN mode does not require PNG/geometry files on either host. Update these catalogs only after publishing their assets. Without the URL, development retains local asset serving.

Existing tile-host deployment (2026-10-10):
- Host: root@159.65.42.125; root: /var/www/jiniebot-tiles/releases.
- Sprite release: inventory-sprites/35b8f185da0d3ecfb0cfba17.
- Public asset base: https://jiniebot.com/tiles/inventory-sprites/35b8f185da0d3ecfb0cfba17
- This versioned path matches the existing nginx tile rule, including public immutable caching and cross-origin access. No nginx edits or map manifest changes are required.
- Stage only publish-manifest.json's listed files in a version.incoming directory, verify every SHA-256, then rename to the version directory. Never overwrite a published version with different contents.
- The catalog at this versioned URL is immutable too; a later catalog must use its new version URL.

Expanding coverage from all installed vanilla maps:
```
node preflight/cache/export-config-model-mappings.js P:/ out/mapdraw/inventory-class-models.json
node preflight/cache/export-inventory-sprites.js --runtime ebo/runtime-export/profile --classes out/mapdraw/inventory-class-models.json --out out/mapdraw/inventory-sprites-expanded
```
The config importer reads CfgVehicles from all DZ config.cpp files, including structures, structures_bliss and structures_sakhal. It resolves inherited model values and rejects conflicting/cyclic definitions. The generated report lists parse failures; review it before publishing. It does not guess StaticObj aliases from model names. The sprite exporter joins these verified classes against all three raster/vector caches. Classes with no complete cached raster still need rendering before they can be published. Mapping exports and assets remain ignored generated data.

Expanded release published 2026-10-10: 61b8cb0a1f6a1ac4d7292286.
- 2,414 class mappings, 2,255 raster sprites, 2,253 topographic footprints; none of the previous 550 classes were lost.
- 4,509 public files / 454,586,102 bytes (433.5 MiB), generated from the combined Chernarus/Livonia/Sakhal caches.
- CDN prefix: https://jiniebot.com/tiles/inventory-sprites/61b8cb0a1f6a1ac4d7292286
- Source mapping audit: 208 config.cpp files, 5,186 CfgVehicles definitions, 5,070 resolved models, no parse errors. Remaining unmatched mappings include loot/vehicles and models not present in the terrain-render caches; they are not all missing buildings.
- Existing CDN files were hard-linked into the new staging release; changed files were unlinked before extraction so the old immutable catalog remained intact. All published files were verified against SHA-256 hashes.
- nginx caches missing files for 120 seconds. Do not probe a release URL before promotion; if accidentally probed, wait for negative-cache expiry or validate nginx configuration and gracefully reload before verification.
- Dev Water World reclassification: 29 ready files; 2,189 PRA bytes fetched, object JSONs reused from cache; unchanged repeat downloaded zero bytes. Read-only drawing check: 36,742 eligible placements after tiny/tilted filters, including normal-scale water planes. The viewport rendering budget still applies.
