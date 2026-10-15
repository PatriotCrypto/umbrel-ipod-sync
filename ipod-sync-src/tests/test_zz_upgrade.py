"""Upgrading a real 2.0.0 install to the whole-storage layout.

Each step runs in its own process because the app reads its paths from the environment
when it is imported, which is what happens on a real Umbrel when the container restarts.
"""
import json
import os
import subprocess
import sys
import tempfile

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

STEP = r"""
import json, os, sys
sys.path.insert(0, %(repo)r)
from app import config, library, playlists

what = sys.argv[1]
if what == "old":
    library.scan()
    rels = sorted(r["relpath"] for r in library.connect().execute("SELECT relpath FROM tracks"))
    pid = playlists.create("Road Trip")["id"]
    conn = library.connect()
    conn.execute("INSERT INTO playlist_items VALUES (?,?,?)", (pid, 0, rels[0]))
    # A real 2.0.0 database has no layout marker, so the upgrade step has to do its work.
    conn.execute("DELETE FROM meta WHERE key = 'layout'")
    conn.commit(); conn.close()
    print(json.dumps({"rels": rels}))
else:
    library.scan()
    conn = library.connect()
    rels = sorted(r["relpath"] for r in conn.execute("SELECT relpath FROM tracks"))
    items = sorted(r["relpath"] for r in conn.execute("SELECT relpath FROM playlist_items"))
    conn.close()
    here = [t for t in library.list_tracks(limit=50)["tracks"]]
    playable = [os.path.isfile(library.absolute_path(r)) for r in rels]
    print(json.dumps({"rels": rels, "items": items, "folders": config.music_folders(),
                      "playable": playable, "error": library.summary()["scan"]["error"],
                      "count": len(here)}))
""" % {"repo": REPO}


def _run(music_dir, data_dir, what, **env):
    environ = dict(os.environ, MUSIC_DIR=music_dir, DATA_DIR=data_dir, IPOD_FAKE_MOUNT="",
                   WORK_DIR=os.path.join(data_dir, "work"))
    environ.pop("IPOD_FAKE_MOUNT")
    environ.update({k: v for k, v in env.items()})
    out = subprocess.run([sys.executable, "-c", STEP, what], capture_output=True, text=True,
                         env=environ, cwd=REPO, timeout=300)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.fixture()
def umbrel():
    """A storage folder laid out the way umbrelOS does it, with capitalised folder names."""
    root = tempfile.mkdtemp(prefix="upod-upgrade-")
    storage, data = os.path.join(root, "storage"), os.path.join(root, "data")
    os.makedirs(data)
    from tests.conftest import tone
    for name in ("Documents", "Photos", "Media"):
        os.makedirs(os.path.join(storage, name))
    tone(os.path.join(storage, "Downloads", "downtify", "a.mp3"), 440, 1,
         "-c:a", "libmp3lame", "-b:a", "128k")
    tone(os.path.join(storage, "Downloads", "downtify", "b.mp3"), 660, 1,
         "-c:a", "libmp3lame", "-b:a", "128k")
    return storage, data


def test_upgrade_keeps_library_when_folder_is_capitalised(umbrel):
    storage, data = umbrel
    # 2.0.0: the Downloads folder itself was mounted, so paths were relative to it.
    old = _run(os.path.join(storage, "Downloads"), data, "old")
    assert old["rels"] == ["downtify/a.mp3", "downtify/b.mp3"]

    # 2.1: the whole storage folder is mounted and the default folder is spelled "downloads",
    # but on this Umbrel it is really "Downloads".
    new = _run(storage, data, "new", DEFAULT_MUSIC_FOLDERS="downloads",
               LEGACY_MUSIC_PREFIX="downloads")
    assert new["error"] is None
    assert new["folders"] == ["Downloads"]
    assert new["rels"] == ["Downloads/downtify/a.mp3", "Downloads/downtify/b.mp3"]
    assert new["items"] == ["Downloads/downtify/a.mp3"]   # the playlist followed
    assert all(new["playable"])                           # and the files really are there
    assert new["count"] == 2


def test_upgrade_when_the_folder_is_lowercase(umbrel):
    """The other Umbrel: its folder really is called "downloads"."""
    storage, data = umbrel
    os.rename(os.path.join(storage, "Downloads"), os.path.join(storage, "downloads"))
    old = _run(os.path.join(storage, "downloads"), data, "old")
    assert old["rels"] == ["downtify/a.mp3", "downtify/b.mp3"]
    new = _run(storage, data, "new", DEFAULT_MUSIC_FOLDERS="downloads",
               LEGACY_MUSIC_PREFIX="downloads")
    assert new["folders"] == ["downloads"]
    assert new["rels"] == ["downloads/downtify/a.mp3", "downloads/downtify/b.mp3"]
    assert all(new["playable"])


def test_no_downloads_folder_falls_back_to_everything(umbrel):
    """An Umbrel that keeps music somewhere else: use the whole storage folder."""
    storage, data = umbrel
    os.rename(os.path.join(storage, "Downloads"), os.path.join(storage, "Tunes"))
    new = _run(storage, data, "new", DEFAULT_MUSIC_FOLDERS="downloads",
               LEGACY_MUSIC_PREFIX="downloads")
    assert new["folders"] == [""]
    assert new["rels"] == ["Tunes/downtify/a.mp3", "Tunes/downtify/b.mp3"]
    assert new["error"] is None


def test_repairs_an_already_broken_2_1_0_install(umbrel):
    """What 2.1.0 did on an Umbrel with a capitalised Downloads folder: it recorded the paths
    under "downloads", found nothing, and could not play anything. The songs must come back
    without a re-scan, and playlists with them."""
    storage, data = umbrel
    _run(os.path.join(storage, "Downloads"), data, "old")
    broken = _run(storage, data, "new", DEFAULT_MUSIC_FOLDERS="downloads",
                  LEGACY_MUSIC_PREFIX="downloads")
    # 2.1.0 left the library pointing at a folder that is not there.
    assert broken["rels"] == ["Downloads/downtify/a.mp3", "Downloads/downtify/b.mp3"]
    import sqlite3
    conn = sqlite3.connect(os.path.join(data, "library.db"))
    for table in ("tracks", "playlist_items"):
        conn.execute(f"UPDATE {table} SET relpath = 'downloads' || substr(relpath, 10)")
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('layout', '2')")
    conn.commit()
    ids = [r[0] for r in conn.execute("SELECT id FROM tracks ORDER BY relpath")]
    conn.close()
    assert ids

    fixed = _run(storage, data, "new", DEFAULT_MUSIC_FOLDERS="downloads",
                 LEGACY_MUSIC_PREFIX="downloads")
    assert fixed["rels"] == ["Downloads/downtify/a.mp3", "Downloads/downtify/b.mp3"]
    assert fixed["items"] == ["Downloads/downtify/a.mp3"]
    assert all(fixed["playable"])
    conn = sqlite3.connect(os.path.join(data, "library.db"))
    assert [r[0] for r in conn.execute("SELECT id FROM tracks ORDER BY relpath")] == ids
    conn.close()   # same rows repaired, not deleted and read again
