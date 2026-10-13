#!/usr/bin/env bash
# Point the Umbrel app at the image the "Publish image" workflow built, and fill
# in your GitHub username in the app listing.
#
#   ./scripts/set-image.sh ghcr.io/<user>/umbrel-ipod-sync:1.0.0@sha256:<64 hex digits>
set -euo pipefail

image="${1:-}"
pattern='^ghcr\.io/([a-z0-9._-]+)/umbrel-ipod-sync:([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$'
if [[ ! "$image" =~ $pattern ]]; then
  echo "That does not look like an image line from the workflow." >&2
  echo "Expected: ghcr.io/<user>/umbrel-ipod-sync:<version>@sha256:<64 hex digits>" >&2
  exit 1
fi
user="${BASH_REMATCH[1]}"
tag="${BASH_REMATCH[2]}"

root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$root/patriot-ipod-sync/docker-compose.yml"
manifest="$root/patriot-ipod-sync/umbrel-app.yml"

# -i.bak works the same on GNU and BSD/macOS sed.
sed -i.bak -E "s|^([[:space:]]*image:[[:space:]]*).*$|\1${image}|" "$compose"
sed -i.bak -E "s|YOUR_GITHUB_USERNAME|${user}|g" "$manifest"
sed -i.bak -E "s|^version: \".*\"$|version: \"${tag}\"|" "$manifest"
rm -f "$compose.bak" "$manifest.bak"

echo "docker-compose.yml now uses: $(grep -E '^[[:space:]]*image:' "$compose" | sed -E 's/^[[:space:]]*image:[[:space:]]*//')"
echo "umbrel-app.yml now points at github.com/${user}/umbrel-ipod-sync (version ${tag})."
echo "Next: commit and push, then add the repository as a community app store in Umbrel."
