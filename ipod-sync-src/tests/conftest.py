"""Test fixtures: a real little music library and a simulated iPod folder.

Environment is set before the app package is imported because its paths are
read at import time.
"""
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

ROOT = tempfile.mkdtemp(prefix="ipodsync-test-")
MUSIC = os.path.join(ROOT, "music")
DATA = os.path.join(ROOT, "data")
POD = os.path.join(ROOT, "pod")
WORK = os.path.join(ROOT, "work")
HELPER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "helper", "ipodsync"))

os.environ.update(MUSIC_DIR=MUSIC, DATA_DIR=DATA, IPOD_FAKE_MOUNT=POD, WORK_DIR=WORK,
                  IPODSYNC_BIN=HELPER)
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args],
                   check=True)


def tone(path, freq, seconds, *codec_args):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ffmpeg("-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}", *codec_args, path)


def make_pod(path, model="MA002", guid="000A270012345678"):
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(os.path.join(path, "iPod_Control", "Device"))
    os.makedirs(os.path.join(path, "iPod_Control", "iTunes"))
    for i in range(20):
        os.makedirs(os.path.join(path, "iPod_Control", "Music", f"F{i:02d}"))
    with open(os.path.join(path, "iPod_Control", "Device", "SysInfo"), "w") as fh:
        fh.write(f"ModelNumStr: {model}\nFirewireGuid: {guid}\n")


def build_library():
    from mutagen.easyid3 import EasyID3
    from mutagen.flac import FLAC
    from mutagen.oggvorbis import OggVorbis
    from mutagen.mp4 import MP4

    cover = os.path.join(ROOT, "cover.jpg")
    ffmpeg("-f", "lavfi", "-i", "color=c=red:s=300x300", "-frames:v", "1", cover)

    # Album 1: mp3 files, plus folder artwork
    a1 = os.path.join(MUSIC, "Alpha Band", "First Light")
    for n, title in enumerate(["Dawn", "Noon"], start=1):
        p = os.path.join(a1, f"0{n} {title}.mp3")
        tone(p, 400 + n * 50, 2, "-c:a", "libmp3lame", "-b:a", "128k")
        t = EasyID3()
        t.update({"title": title, "artist": "Alpha Band", "album": "First Light",
                  "tracknumber": f"{n}/2", "date": "2019", "genre": "Rock"})
        t.save(p)
    shutil.copy(cover, os.path.join(a1, "cover.jpg"))

    # Album 2: FLAC (must be converted), awkward characters in tags
    a2 = os.path.join(MUSIC, "Beta", "Café Sessions")
    p = os.path.join(a2, "01 weird.flac")
    tone(p, 600, 2, "-c:a", "flac")
    f = FLAC(p)
    f["title"] = "Tab\there \\ slash"
    f["artist"] = "Béta & Friends"
    f["album"] = "Café Sessions"
    f["tracknumber"] = "1"
    f.save()

    # Album 3: AAC in m4a (copied as is) and an Ogg (converted)
    a3 = os.path.join(MUSIC, "Gamma", "Mixed")
    p = os.path.join(a3, "01 aac.m4a")
    tone(p, 700, 2, "-c:a", "aac", "-b:a", "128k")
    m = MP4(p)
    m["\xa9nam"], m["\xa9ART"], m["\xa9alb"], m["trkn"] = ["AAC Song"], ["Gamma"], ["Mixed"], [(1, 2)]
    m.save()
    p = os.path.join(a3, "02 ogg.ogg")
    tone(p, 800, 2, "-c:a", "libvorbis")
    o = OggVorbis(p)
    o["title"], o["artist"], o["album"], o["tracknumber"] = "Ogg Song", "Gamma", "Mixed", "2"
    o.save()

    # Not audio / unreadable: must be ignored without breaking the scan
    with open(os.path.join(MUSIC, "Gamma", "notes.txt"), "w") as fh:
        fh.write("hello")
    with open(os.path.join(MUSIC, "Gamma", "broken.mp3"), "wb") as fh:
        fh.write(b"not really an mp3")


@pytest.fixture(scope="session", autouse=True)
def _library():
    if not os.path.exists(HELPER):
        subprocess.run(["make", "-C", os.path.dirname(HELPER)], check=True)
    build_library()
    yield
    shutil.rmtree(ROOT, ignore_errors=True)


@pytest.fixture()
def pod():
    make_pod(POD)
    shutil.rmtree(DATA + "/backups", ignore_errors=True)
    from app import ipod
    ipod.invalidate_tracks()
    return POD
