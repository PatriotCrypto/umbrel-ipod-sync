# uPod for Umbrel

uPod (Umbrel iPod, or Your iPod) is a music player and retro visualizer for the music on your Umbrel, and it still copies that music onto an iPod plugged into the Umbrel's USB port.

New in this version: a full player with early-2000s style visualizations (full screen, auto-change), a playlist, skins, automatic genre sorting, a Songs list, and a one-button **Duplicates** finder that moves extra copies of the same song and artist to a hidden `.ipod-trash` folder (restore or empty it any time; one copy always stays).
Built for the **iPod nano 5th generation** (the one with the camera). It uses
[libgpod](https://sourceforge.net/projects/gtkpod/), the same library that Rhythmbox and gtkpod use to
write an iPod's music database.

- Browse the music in your Umbrel's Downloads folder as album tiles, grouped under artist headings.
  Search, sort (artist, album, newest year, recently added, biggest), jump by letter, and resize the tiles.
- Albums that are already on the iPod are kept apart: the Library tab defaults to **To add**, and the
  **On iPod** tab shows what is on the device. Partly copied albums are flagged.
- Open an album to pick single songs. Select a whole artist with one click. "Surprise me" picks random
  albums to fill about 1, 2 or 4 GB, or the whole iPod.
- See the space a sync will use before you start (capacity bar in your iPod's own case colour).
- FLAC, Ogg, Opus, WMA and other formats the iPod can't play are converted to AAC. MP3 and AAC are copied untouched.
- Album covers are copied across.
- The iPod's database is backed up before every sync and can be restored from Settings.
- Songs already on the iPod are recognised and skipped; you can also remove albums or songs from the iPod.

## What has and hasn't been tested

Tested, automatically (`ipod-sync-src/tests` plus a browser run): library scanning, conversion rules, planning,
copying, writing and reading back the database with the real libgpod, removal, backup and restore,
refusing to touch an unreadable database, and the whole interface in a headless browser.
Those ran against a **simulated iPod folder**, using an older iPod model that needs no signature.

**Not tested, because it needs hardware or a real Umbrel:** writing to a physical nano 5G (including its
signed database and album covers), mounting an iPod from inside the container, and the Docker image build.
Expect the first real sync to be the real test. The backup taken before each sync is there for exactly that.
If something goes wrong, the app's messages and `data/last-sync-helper.log` (in the app's data folder) say what.

## Before the first sync: the nano 5G needs one iTunes sync

The nano 5th generation signs its music database. libgpod can only learn the signing key from a database
that iTunes (or Apple Devices / Finder) has written. So:

1. Plug the nano into a computer with iTunes, Apple Devices or Finder and sync any song to it once.
2. Eject it and plug it into the Umbrel.

Until then the app shows "This iPod needs one sync with iTunes first" and will not write anything.
You only do this once per iPod.

Mac-formatted iPods (HFS+) with journaling on can only be read from Linux. Either turn journaling off on a
Mac (`diskutil disableJournal /Volumes/<iPod name>`) or restore the iPod as a Windows iPod in iTunes
(FAT32). The app tells you if this applies.

## Install

You need a free GitHub account. The Umbrel pulls a ready-made image, which GitHub builds for you.

1. Create a new GitHub repository named `umbrel-ipod-sync` and push this folder to it.
2. On GitHub open **Actions → Publish image → Run workflow**. When it finishes, open the run: its summary
   shows one line starting `./scripts/set-image.sh ...`.
3. Run that line in your checkout. It fills in the image and your username. Commit and push.
4. On GitHub go to your profile → **Packages → umbrel-ipod-sync → Package settings → Change visibility →
   Public**. (The Umbrel can't pull a private image.)
5. In Umbrel: open the **App Store**, find its **Community App Stores** option (menu labels vary a little
   between umbrelOS versions) and add `https://github.com/<you>/umbrel-ipod-sync`. Then install
   **uPod** from "Patriot Apps".
6. The store listing already points at the icon in this repository.

Put music anywhere inside your Umbrel's **Downloads** folder; it is mounted read-write only so duplicates can be moved to
`.ipod-trash` inside it. Nothing else is ever changed, and nothing is erased until you empty the trash.

## Using it

1. Plug the iPod into the Umbrel and open the app. The panel on the right shows the iPod once it is opened.
2. Tick albums (or click one to pick songs). The panel shows what will be copied and whether it fits.
   Press `/` to jump to the search box.
3. Press the play button on an album (or a song inside an album) to listen in the browser before or after syncing.
4. **Sync now.** Wait for "Sync finished", then **Eject** and unplug.

## Safety

- Before every write the iPod's `iTunes`, `Device` and `Artwork` folders are copied to the app's data folder
  (the last three are kept).
- The iPod's database is only rewritten at the very end, in one step. If anything fails, or you cancel, the
  files already copied are removed again and the database is left as it was.
- If the iPod's database exists but can't be read, the app refuses to write rather than replace it.
- Removing a song asks for confirmation, and a request made from a stale view of the iPod is rejected
  (libgpod renumbers tracks on every write).

## Why the container is privileged

It has to mount the iPod's storage and read the nano's description over raw USB (libgpod's
`ipod-read-sysinfo-extended`), and Docker can't grant a device that isn't plugged in yet. The web interface
sits behind Umbrel's sign-in. A narrower, untested alternative is written in
`patriot-ipod-sync/docker-compose.yml` if you'd rather try that.

Do not format or "use" the iPod from Umbrel's own storage settings.

## Troubleshooting

| You see | What to do |
| --- | --- |
| No iPod connected, but it is plugged in | Try another USB port. The iPod must show up as storage ("disk mode"). |
| Could not open the iPod | The message says why. Mac-formatted iPods may need journaling turned off (above). |
| Needs one sync with iTunes first | See "Before the first sync" above. |
| Database can't be read | Restore the latest backup in Settings, or restore the iPod with iTunes. |
| Songs copied but covers look wrong | Turn off "Copy album covers" in Settings and sync again. |

## Development

```sh
sudo apt install libgpod-dev libgpod-common libglib2.0-dev gcc make pkg-config ffmpeg \
                 python3-flask python3-mutagen python3-waitress python3-pytest
make -C ipod-sync-src/helper
cd ipod-sync-src && python3 -m pytest -q tests
```

To try the interface without an iPod, point `IPOD_FAKE_MOUNT` at a folder shaped like one
(`iPod_Control/{Device,iTunes,Music/F00..F19}` and a `Device/SysInfo` containing `ModelNumStr: MA002`),
set `MUSIC_DIR` and `DATA_DIR`, and run `python3 -m app.server`.

```
umbrel-app-store.yml        store id and name
patriot-ipod-sync/            the Umbrel app (manifest, compose file, icon)
ipod-sync-src/              the image: Flask backend, static UI, C helper around libgpod, tests
scripts/set-image.sh        wires the built image into the compose file
.github/workflows/          builds and publishes the image
```
