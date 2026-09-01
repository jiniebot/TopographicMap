#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

remote="root@159.65.42.125"
tiles_root="/var/www/jiniebot-tiles"
old_version="full-v1-zoom1-6"
new_version="full-v1-zoom1-8"
incoming="$tiles_root/releases/chernarus/$new_version.incoming"
local_root="out/mapdraw/final/chernarus/$old_version/satellite"

test "$(find "$local_root/7" -type f -name '[0-9]*.png' | wc -l)" -eq 16384
test "$(find "$local_root/8" -type f -name '[0-9]*.png' | wc -l)" -eq 65536

# Seed z1-7 on the server so only the new z8 payload crosses the WAN.
# The live symlink remains unchanged until validation and promotion.
ssh "$remote" "rm -rf '$incoming' && cp -al '$tiles_root/releases/chernarus/$old_version' '$incoming' && rm -rf '$incoming/satellite/8' '$incoming/.content-hash' && mkdir -p '$incoming/satellite/8'"

rsync -a --checksum --partial --info=progress2 \
  "$local_root/8/" \
  "$remote:$incoming/satellite/8/"

ssh "$remote" bash -s -- "$tiles_root" "$new_version" "$incoming" <<'REMOTE'
set -euo pipefail
tiles_root="$1"
new_version="$2"
incoming="$3"

test "$(find "$incoming/satellite/7" -type f -name '[0-9]*.png' | wc -l)" -eq 16384
test "$(find "$incoming/satellite/8" -type f -name '[0-9]*.png' | wc -l)" -eq 65536

content_hash="$(
  cd "$incoming"
  find satellite topographic -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -c1-16
)"
printf '%s\n' "$content_hash" > "$incoming/.content-hash.new"
mv "$incoming/.content-hash.new" "$incoming/.content-hash"

cd "$tiles_root"
rm -rf "releases/chernarus/$new_version"
mv "$incoming" "releases/chernarus/$new_version"
ln -sfn "../releases/chernarus/$new_version" "current/chernarus.tmp"
mv -Tf "current/chernarus.tmp" "current/chernarus"
bash regen-manifest.sh
du -sh "releases/chernarus/$new_version"
df -h /
REMOTE
