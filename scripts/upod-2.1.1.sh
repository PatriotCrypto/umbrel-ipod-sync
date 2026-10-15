#!/usr/bin/env bash
# One-time listing update for uPod 2.1.1 (the folder-name fix).
# Rewrites the release notes and makes sure the compose file has the storage settings.
# It keeps your version, image line and icon line exactly as they are.
# Run: bash ./scripts/upod-2.1.1.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$root" <<'PY'
import re, sys
root = sys.argv[1]
mp = f"{root}/patriot-ipod-sync/umbrel-app.yml"
cp = f"{root}/patriot-ipod-sync/docker-compose.yml"

m = open(mp).read()
notes = """releaseNotes: >-
  Fixes 2.1.0 on Umbrels whose music folder is spelled differently (for example "Downloads"
  rather than "downloads"): your library is found again without a re-scan, and playlists keep
  their songs. Choosing folders in Settings now works on any Umbrel, says why a folder cannot
  be used, and lets you narrow a wide library down. Playback stops after a few songs it cannot
  play instead of racing through the queue, and two names for one file are no longer offered
  as duplicates.
"""
m = re.sub(r"(?ms)^releaseNotes: >-\n.*?(?=^icon:)", lambda _: notes, m)
open(mp, "w").write(m)

c = open(cp).read()
c = c.replace("MUSIC_DIR: /music", "MUSIC_DIR: /storage")
c = re.sub(r"(?m)^(\s*)- \$\{UMBREL_ROOT\}/data/storage[^\n]*:/music[^\n]*$",
           r"\1- ${UMBREL_ROOT}/data/storage:/storage", c)
if "DEFAULT_MUSIC_FOLDERS" not in c:
    c = c.replace("      MUSIC_DIR: /storage\n",
                  "      MUSIC_DIR: /storage\n      DEFAULT_MUSIC_FOLDERS: downloads\n"
                  "      LEGACY_MUSIC_PREFIX: downloads\n")
open(cp, "w").write(c)
PY
echo "--- manifest"; grep -n '^name\|^version\|^icon' "$root/patriot-ipod-sync/umbrel-app.yml"
echo "--- compose"; grep -n 'image:\|/storage\|MUSIC\|LEGACY' "$root/patriot-ipod-sync/docker-compose.yml"
