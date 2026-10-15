#!/usr/bin/env bash
# One-time listing update for uPod 2.1: playlists, folder choice, faster pages.
# uPod now sees your whole Umbrel storage folder (you pick which folders count as music in
# Settings), so the compose file mounts that instead of only Downloads.
# It keeps your version, image line and icon line exactly as they are.
# Run: bash ./scripts/upod-2.1.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$root" <<'PY'
import re, sys
root = sys.argv[1]
mp = f"{root}/patriot-ipod-sync/umbrel-app.yml"
cp = f"{root}/patriot-ipod-sync/docker-compose.yml"

m = open(mp).read()
desc = """description: >-
  uPod is a music player and nostalgic visualizer for the music on your Umbrel, with the
  original trick kept: plug in an old iPod and copy music onto it.


  Play your library in the browser with full-screen visualizations in the style of the
  early-2000s media players, your own playlists, and skins. Your music is sorted by genre
  automatically, even when the tags are messy.


  In Settings you choose which folders on your Umbrel uPod reads music from. By default
  it uses your Downloads folder.


  One button finds songs that appear more than once (same title and artist, and about the
  same length) and lets you move the extra copies to a trash folder. One copy of every song
  always stays, and the trash can be restored or emptied. This is the only time uPod changes
  your files.


  Copying to an iPod works as before: pick albums, songs or a playlist, see the space they
  will use, and sync. Songs the iPod cannot play (FLAC, Ogg, Opus) are converted to AAC,
  covers are copied, and the iPod's database is backed up before every sync. Built and
  tested for the iPod nano 5th generation; other libgpod-supported iPods should work too.


  Before the first sync, the nano 5th generation must have been synced once with iTunes (or
  Apple Devices or Finder) so the iPod's database signature is learned.
"""
m = re.sub(r"(?ms)^description: >-\n.*?(?=^developer:)", lambda _: desc, m)
notes = """releaseNotes: >-
  New: playlists you can make in the app, a Settings option to choose which folders uPod
  reads music from, and much faster Songs, Library and Genres pages on big collections.
  Plus a small surprise for anyone who loves old-school music players.
"""
m = re.sub(r"(?ms)^releaseNotes: >-\n.*?(?=^icon:)", lambda _: notes, m)
open(mp, "w").write(m)

c = open(cp).read()
# the storage mount (with whatever comment sat above it)
c = re.sub(r"(?m)^(\s*)#[^\n]*\n(?:\s*#[^\n]*\n)*?(\s*)- \$\{UMBREL_ROOT\}/data/storage[^\n]*:/music[^\n]*\n",
           lambda mo: (f"{mo.group(1)}# Your Umbrel's storage folder. In Settings you choose which folders inside it hold\n"
                       f"{mo.group(1)}# music (Downloads by default). uPod only changes files when you remove duplicates:\n"
                       f"{mo.group(1)}# they are moved to a hidden .ipod-trash folder, never erased.\n"
                       f"{mo.group(2)}- ${{UMBREL_ROOT}}/data/storage:/storage\n"), c)
c = re.sub(r"(?m)^(\s*)- \$\{UMBREL_ROOT\}/data/storage[^\n]*:/music[^\n]*$",
           r"\1- ${UMBREL_ROOT}/data/storage:/storage", c)
c = c.replace("MUSIC_DIR: /music", "MUSIC_DIR: /storage")
if "DEFAULT_MUSIC_FOLDERS" not in c:
    c = c.replace("      MUSIC_DIR: /storage\n",
                  "      MUSIC_DIR: /storage\n      DEFAULT_MUSIC_FOLDERS: downloads\n      LEGACY_MUSIC_PREFIX: downloads\n")
open(cp, "w").write(c)
PY
echo "--- manifest"; grep -n '^name\|^version\|^icon' "$root/patriot-ipod-sync/umbrel-app.yml"
echo "--- compose"; grep -n 'image:\|/storage\|MUSIC' "$root/patriot-ipod-sync/docker-compose.yml"
