#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

remote="root@159.65.42.125"
tiles_root="/var/www/jiniebot-tiles"
old_version="full-v1-zoom1-6"
new_version="full-v1-zoom1-7"
incoming="$tiles_root/releases/sakhal/$new_version.incoming"
local_z7="out/mapdraw/final/sakhal/$old_version/satellite/7"

test "$(find "$local_z7" -type f -name '[0-9]*.png' | wc -l)" -eq 16384

# Seed the staged release server-side from the live z1-6 release. Only the
# new z7 directory crosses the WAN, and the live symlink remains untouched.
ssh "$remote" "rm -rf '$incoming' && cp -a '$tiles_root/releases/sakhal/$old_version' '$incoming' && rm -rf '$incoming/satellite/7' && mkdir -p '$incoming/satellite/7'"

rsync -a --checksum --partial --info=progress2 \
  "$local_z7/" \
  "$remote:$incoming/satellite/7/"

ssh "$remote" bash -s -- "$tiles_root" "$new_version" "$incoming" <<'REMOTE'
set -euo pipefail
tiles_root="$1"
new_version="$2"
incoming="$3"

test "$(find "$incoming/satellite/7" -type f -name '[0-9]*.png' | wc -l)" -eq 16384

content_hash="$(
  cd "$incoming"
  find satellite topographic -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -c1-16
)"
printf '%s\n' "$content_hash" > "$incoming/.content-hash"

cd "$tiles_root"
rm -rf "releases/sakhal/$new_version"
mv "$incoming" "releases/sakhal/$new_version"
ln -sfn "../releases/sakhal/$new_version" "current/sakhal.tmp"
mv -Tf "current/sakhal.tmp" "current/sakhal"
bash regen-manifest.sh
du -sh "releases/sakhal/$new_version"
df -h /
REMOTE
