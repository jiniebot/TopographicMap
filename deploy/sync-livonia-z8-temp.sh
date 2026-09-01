#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

remote="root@159.65.42.125"
tiles_root="/var/www/jiniebot-tiles"
old_version="full-v1-zoom1-6"
new_version="full-v1-zoom1-8"
incoming="$tiles_root/releases/livonia/$new_version.incoming"
local_z8="out/mapdraw/final/livonia/$old_version/satellite/8"

test "$(find "$local_z8" -type f -name '[0-9]*.png' | wc -l)" -eq 65536

# Hard-link the existing live z1-7 release, then transfer only z8. The live
# symlink remains unchanged until the staged release validates completely.
ssh "$remote" "rm -rf '$incoming' && cp -al '$tiles_root/releases/livonia/$old_version' '$incoming' && rm -rf '$incoming/satellite/8' '$incoming/.content-hash' && mkdir -p '$incoming/satellite/8'"

rsync -a --checksum --partial --info=progress2 \
  "$local_z8/" \
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
rm -rf "releases/livonia/$new_version"
mv "$incoming" "releases/livonia/$new_version"
ln -sfn "../releases/livonia/$new_version" "current/livonia.tmp"
mv -Tf "current/livonia.tmp" "current/livonia"
bash regen-manifest.sh
du -sh "releases/livonia/$new_version"
df -h /
REMOTE
