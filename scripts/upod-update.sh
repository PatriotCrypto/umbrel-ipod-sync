#!/usr/bin/env bash
# One-time listing update for the uPod makeover. Renames the app, rewrites the description and
# release notes, and lets the music folder be writable (needed to move duplicates to the trash).
# It keeps your version, image line and icon line as they are.   Run: bash ./scripts/upod-update.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$root" <<'PY'
import re, sys
root = sys.argv[1]
mp = f"{root}/patriot-ipod-sync/umbrel-app.yml"
cp = f"{root}/patriot-ipod-sync/docker-compose.yml"
m = open(mp).read()
m = re.sub(r"(?m)^name: .*$", "name: uPod", m)
m = re.sub(r"(?m)^tagline: .*$", "tagline: Your music player, visualizer and iPod sync, all on your Umbrel", m)
desc = """description: >-
  uPod is a music player and nostalgic visualizer for the music on your Umbrel, with the
  original trick kept: plug in an old iPod and copy music onto it.


  Play your library in the browser with full-screen visualizations in the style of the
  early-2000s media players, a playlist, and skins. Your music is sorted by genre
  automatically, even when the tags are messy.


  One button finds songs that appear more than once (same title and artist, for example
  songs repeated across albums) and lets you move the extra copies to a trash folder.
  One copy of every song always stays, and the trash can be restored or emptied.


  Copying to an iPod works as before: pick albums or single songs, see the space they will
  use, and sync. Songs the iPod cannot play (FLAC, Ogg, Opus) are converted to AAC, covers are
  copied, and the iPod's database is backed up before every sync. Built and tested for the
  iPod nano 5th generation; other libgpod-supported iPods should work too.


  Your music is found in the Downloads folder: add songs anywhere inside it and choose Rescan
  library. The app only changes that folder when you remove duplicates (files go to a hidden
  .ipod-trash folder inside it).


  Before the first sync, the nano 5th generation must have been synced once with iTunes (or
  Apple Devices or Finder) so the iPod's database signature is learned.
"""
m = re.sub(r"(?ms)^description: >-\n.*?(?=^developer:)", lambda _: desc, m)
notes = """releaseNotes: >-
  iPod Sync is now uPod: a full music player with a retro visualizer (many visualizations,
  full screen, auto-change), a playlist, skins, automatic genres, a Songs list, and a one-button
  duplicate finder with a restorable trash. Copying music to an iPod still works as before.
"""
m = re.sub(r"(?ms)^releaseNotes: >-\n.*?(?=^icon:)", lambda _: notes, m)
open(mp, "w").write(m)
c = open(cp).read()
c = c.replace("/music:ro", "/music")
c = c.replace("# Your Umbrel's Downloads folder, read only. Music is found anywhere inside.",
              "# Your Umbrel's Downloads folder. Music is found anywhere inside. uPod only writes here\n      # when you remove duplicates (files are moved to a .ipod-trash folder, never erased).")
open(cp, "w").write(c)
PY
echo "--- manifest"; grep -n '^name\|^version\|^icon\|^tagline' "$root/patriot-ipod-sync/umbrel-app.yml"
echo "--- compose"; grep -n 'image:\|/music' "$root/patriot-ipod-sync/docker-compose.yml"
