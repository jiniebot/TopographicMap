#!/usr/bin/env bash
# Runs ON THE VPS (deployed once to /var/www/jiniebot-tiles/regen-manifest.sh
# by sync-tiles.sh's first run). Walks current/<mapId> symlinks and writes
# manifest.json - the one thing clients fetch to learn which version is
# live per map (see JinieBotInterface/public/js/map/tileManifest.js).
#
# Called by sync-tiles.sh after a symlink swap, and by rollback-tile.sh.
# Never edits releases/ or current/ itself - read-only with respect to
# those, only writes manifest.json.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TILES_ROOT="$(pwd)"
MANIFEST="$TILES_ROOT/manifest.json"
TMP="$MANIFEST.tmp.$$"

{
  echo "{"
  first=1
  for link in current/*; do
    [ -L "$link" ] || continue
    mapId="$(basename "$link")"
    version="$(basename "$(readlink -f "$link")")"
    contentHash=""
    hashFile="releases/$mapId/$version/.content-hash"
    [ -f "$hashFile" ] && contentHash="$(cat "$hashFile")"
    publishedAt="$(date -u -d "@$(stat -c %Y "$link")" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ "$first" -eq 1 ] && first=0 || echo ","
    printf '  "%s": { "version": "%s", "contentHash": "%s", "publishedAt": "%s" }' \
      "$mapId" "$version" "$contentHash" "$publishedAt"
  done
  echo ""
  echo "}"
} > "$TMP"

mv "$TMP" "$MANIFEST"
echo "wrote $MANIFEST"
cat "$MANIFEST"
