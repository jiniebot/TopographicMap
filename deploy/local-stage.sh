#!/usr/bin/env bash
# Builds a local mirror of the production releases+current layout (see
# deploy/nginx/jiniebot-tiles.conf) pointed at this dev machine's real
# out/mapdraw/final output, so the exact nginx config that will run in
# prod can be exercised locally before anything is pushed there.
#
# Run from WSL, from the boundingboxes repo root:
#   bash deploy/local-stage.sh
#
# Safe to re-run - re-links whatever active-versions.json currently says
# is active per map.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

STAGE_DIR="deploy/local-stage"
FINAL_ROOT="out/mapdraw/final"

mkdir -p "$STAGE_DIR/releases" "$STAGE_DIR/current"

node -e '
  const fs = require("fs");
  const state = JSON.parse(fs.readFileSync("out/mapdraw/final/active-versions.json", "utf8"));
  for (const [mapId, entry] of Object.entries(state.maps || {})) console.log(`${mapId} ${entry.version}`);
' | while read -r mapId version; do
  mkdir -p "$STAGE_DIR/releases/$mapId"
  target="$STAGE_DIR/releases/$mapId/$version"
  ln -sfn "$(realpath "$FINAL_ROOT/$mapId/$version")" "$target"
  ln -sfn "../releases/$mapId/$version" "$STAGE_DIR/current/$mapId"
  echo "staged $mapId -> $version"
done

# Same manifest shape deploy/remote/regen-manifest.sh will produce on the
# real VPS - lets the client-side tileManifest.js code path be exercised
# identically in local testing.
node -e '
  const fs = require("fs");
  const state = JSON.parse(fs.readFileSync("out/mapdraw/final/active-versions.json", "utf8"));
  const manifest = {};
  for (const [mapId, entry] of Object.entries(state.maps || {}))
    manifest[mapId] = { version: entry.version, publishedAt: new Date().toISOString() };
  fs.writeFileSync("deploy/local-stage/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
'
echo "wrote deploy/local-stage/manifest.json"
