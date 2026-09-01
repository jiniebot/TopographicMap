#!/usr/bin/env bash
# Reverts one map to a previously-published version, without re-syncing
# anything - just flips the current/<mapId> symlink to an older release
# that's still on disk (sync-tiles.sh retains the newest 3 per map).
#
# Usage:
#   TILES_SSH_HOST=root@1.2.3.4 bash deploy/rollback-tile.sh <mapId> <version>
#
# To see what's available to roll back to:
#   ssh $TILES_SSH_HOST 'ls /var/www/jiniebot-tiles/releases/<mapId>'

set -euo pipefail

MAP_ID="${1:?Usage: bash deploy/rollback-tile.sh <mapId> <version>}"
VERSION="${2:?Usage: bash deploy/rollback-tile.sh <mapId> <version>}"
TILES_SSH_HOST="${TILES_SSH_HOST:?Set TILES_SSH_HOST=user@host first}"
TILES_ROOT_REMOTE="${TILES_ROOT_REMOTE:-/var/www/jiniebot-tiles}"

echo "== rolling back $MAP_ID to $VERSION =="
ssh "$TILES_SSH_HOST" bash -s <<EOF
set -euo pipefail
cd "$TILES_ROOT_REMOTE"
if [ ! -d "releases/$MAP_ID/$VERSION" ]; then
  echo "No such release on disk: releases/$MAP_ID/$VERSION" >&2
  echo "Available versions:" >&2
  ls -1 "releases/$MAP_ID" >&2
  exit 1
fi
before="\$(basename "\$(readlink -f "current/$MAP_ID")" 2>/dev/null || echo none)"
ln -sfn "../releases/$MAP_ID/$VERSION" "current/$MAP_ID.tmp"
mv -T "current/$MAP_ID.tmp" "current/$MAP_ID"
bash regen-manifest.sh > /dev/null
echo "current/$MAP_ID: \$before -> $VERSION"
EOF

echo "== done. No rsync ran - this was a symlink flip only. =="
