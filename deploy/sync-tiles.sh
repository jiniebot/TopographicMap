#!/usr/bin/env bash
# Publishes one map's currently-active local tile version to production.
# Run from WSL, from the boundingboxes repo root:
#   TILES_SSH_HOST=root@1.2.3.4 bash deploy/sync-tiles.sh <mapId>
#
# One-time setup (see deploy/nginx/jiniebot-tiles.conf's header for the
# matching nginx side):
#   ssh $TILES_SSH_HOST 'mkdir -p /var/www/jiniebot-tiles/releases /var/www/jiniebot-tiles/current'
#   scp deploy/remote/regen-manifest.sh $TILES_SSH_HOST:/var/www/jiniebot-tiles/regen-manifest.sh
#
# Safe to re-run - step 2 below skips the whole transfer if the remote
# manifest already has this exact map+version+hash.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MAP_ID="${1:?Usage: bash deploy/sync-tiles.sh <mapId>}"
TILES_SSH_HOST="${TILES_SSH_HOST:?Set TILES_SSH_HOST=user@host first}"
TILES_ROOT_REMOTE="${TILES_ROOT_REMOTE:-/var/www/jiniebot-tiles}"
RETAIN="${RETAIN:-3}"

echo "== $MAP_ID: resolving local version =="
VERSION="$(node -e "
  const fs = require('fs');
  const state = JSON.parse(fs.readFileSync('out/mapdraw/final/active-versions.json', 'utf8'));
  const v = state.maps?.['$MAP_ID']?.version;
  if (!v) throw new Error('No active version for $MAP_ID');
  console.log(v);
")"
LOCAL_DIR="out/mapdraw/final/$MAP_ID/$VERSION"
echo "   version: $VERSION"

echo "== $MAP_ID: computing content hash =="
HASH_JSON="$(node deploy/compute-content-hash.js "$MAP_ID" "$VERSION")"
CONTENT_HASH="$(node -e "console.log(JSON.parse(process.argv[1]).contentHash)" "$HASH_JSON")"
FILE_COUNT="$(node -e "console.log(JSON.parse(process.argv[1]).fileCount)" "$HASH_JSON")"
echo "   contentHash: $CONTENT_HASH ($FILE_COUNT files)"

echo "== $MAP_ID: checking remote manifest for a no-op skip =="
REMOTE_MANIFEST="$(ssh "$TILES_SSH_HOST" "cat $TILES_ROOT_REMOTE/manifest.json 2>/dev/null || echo '{}'")"
REMOTE_HASH="$(node -e "
  const m = JSON.parse(process.argv[1] || '{}');
  console.log(m['$MAP_ID']?.contentHash || '');
" "$REMOTE_MANIFEST" 2>/dev/null || echo "")"
if [ "$REMOTE_HASH" = "$CONTENT_HASH" ]; then
  echo "   remote already has this exact content (hash match) - nothing to sync"
  exit 0
fi

echo "== $MAP_ID: writing content-hash marker into the local build dir =="
echo "$CONTENT_HASH" > "$LOCAL_DIR/.content-hash"

echo "== $MAP_ID: staging on remote =="
STAGING="$TILES_ROOT_REMOTE/releases/$MAP_ID/$VERSION.incoming"
ssh "$TILES_SSH_HOST" "mkdir -p '$STAGING'"

echo "== $MAP_ID: rsync ($LOCAL_DIR -> $TILES_SSH_HOST:$STAGING) =="
# --checksum: byte-accurate over the WAN, not relying on cross-OS mtimes.
# --partial: resumable if interrupted. Never syncs into the final release
# name directly - only ever into a .incoming suffix, renamed atomically
# below once the transfer is fully done.
rsync -a --checksum --partial --info=progress2 \
  "$LOCAL_DIR/" "$TILES_SSH_HOST:$STAGING/"

echo "== $MAP_ID: promoting =="
ssh "$TILES_SSH_HOST" bash -s <<EOF
set -euo pipefail
cd "$TILES_ROOT_REMOTE"
rm -rf "releases/$MAP_ID/$VERSION"
mv "releases/$MAP_ID/$VERSION.incoming" "releases/$MAP_ID/$VERSION"
ln -sfn "../releases/$MAP_ID/$VERSION" "current/$MAP_ID.tmp"
mv -T "current/$MAP_ID.tmp" "current/$MAP_ID"
bash regen-manifest.sh

echo "== $MAP_ID: pruning old releases (keeping newest $RETAIN) =="
cd "releases/$MAP_ID"
ls -1t | grep -v '\.incoming$' | tail -n +\$(($RETAIN + 1)) | while read -r old; do
  active="\$(basename "\$(readlink -f "$TILES_ROOT_REMOTE/current/$MAP_ID")")"
  if [ "\$old" != "\$active" ]; then
    echo "   pruning \$old"
    rm -rf "\$old"
  fi
done
EOF

echo "== $MAP_ID: done. Live at $TILES_ROOT_REMOTE/current/$MAP_ID -> $VERSION =="
