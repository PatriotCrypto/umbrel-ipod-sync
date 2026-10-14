import os
import shutil
import time

import pytest
from mutagen.easyid3 import EasyID3

from app import dupes, genres, library
from app.server import create_app
from tests.conftest import MUSIC, tone

BASE = os.path.join(MUSIC, "Dup Artist")


def _settle():
    for _ in range(100):
        if not library.summary()["scan"]["running"]:
            break
        time.sleep(0.1)
    library.scan()


def _song(album, name, title, artist="Dup Artist", genre="hip hop", kbps="128k"):
    p = os.path.join(BASE, album, name)
    tone(p, 440, 2, "-c:a", "libmp3lame", "-b:a", kbps)
    tag = EasyID3()
    tag.update({"title": title, "artist": artist, "album": album, "genre": genre})
    tag.save(p)
    return p


@pytest.fixture()
def dup_library():
    shutil.rmtree(BASE, ignore_errors=True)
    _song("Album One", "01 Same Song.mp3", "Same Song", kbps="192k")
    _song("Album One", "02 Only Here.mp3", "Only Here")
    _song("Album Two", "01 Same Song!.mp3", "same song", kbps="96k")      # same song, other album
    _song("Album Three", "05 Same Song.mp3", "Same  Song", kbps="128k")
    _song("Album Three", "06 Other Artist.mp3", "Same Song", artist="Someone Else")  # not a dupe
    _settle()
    yield create_app(start_scan=False).test_client()
    dupes.restore_trash()
    dupes.empty_trash()
    shutil.rmtree(BASE, ignore_errors=True)
    shutil.rmtree(os.path.join(MUSIC, ".ipod-trash"), ignore_errors=True)
    _settle()


def test_genre_names_are_normalised():
    assert genres.canonical("hip hop") == "Hip-Hop/Rap"
    assert genres.canonical("(17)") == "Rock"
    assert genres.canonical("Alt. Rock") == "Alternative"
    assert genres.canonical("R&B") == "R&B/Soul"
    assert genres.canonical("") is None


def test_genres_and_songs_endpoints(dup_library):
    names = [g["name"] for g in dup_library.get("/api/library/genres").json["genres"]]
    assert "Hip-Hop/Rap" in names
    data = dup_library.get("/api/library/tracks?genre=Hip-Hop/Rap&sort=title").json
    assert data["total"] >= 5
    assert all(t["genre"] == "Hip-Hop/Rap" for t in data["tracks"])
    assert dup_library.get("/api/library/tracks?q=only+here").json["total"] == 1


def test_scan_finds_only_real_duplicates(dup_library):
    scan = dup_library.get("/api/library/duplicates").json
    mine = [g for g in scan["groups"] if g["artist"] == "Dup Artist"]
    assert len(mine) == 1 and len(mine[0]["items"]) == 3
    kept = [i for i in mine[0]["items"] if i["keep"]]
    assert len(kept) == 1 and kept[0]["bitrate"] >= 180      # the 192k copy is the best one
    assert scan["can_delete"] is True


def test_delete_restore_and_empty(dup_library):
    group = next(g for g in dup_library.get("/api/library/duplicates").json["groups"] if g["artist"] == "Dup Artist")
    extras = [i["id"] for i in group["items"] if not i["keep"]]
    best = next(i for i in group["items"] if i["keep"])
    res = dup_library.post("/api/library/duplicates/delete", json={"ids": extras}).json
    assert res["moved"] == 2 and not res["failed"]
    assert os.path.exists(os.path.join(MUSIC, best["path"]))
    assert not os.path.exists(os.path.join(MUSIC, "Dup Artist", "Album Two", "01 Same Song!.mp3"))
    assert res["trash"]["files"] == 2
    assert not [g for g in dup_library.get("/api/library/duplicates").json["groups"] if g["artist"] == "Dup Artist"]

    assert dup_library.post("/api/library/trash/empty", json={}).status_code == 400   # needs confirmation
    restored = dup_library.post("/api/library/trash/restore").json
    assert restored["restored"] == 2 if "restored" in restored else True
    assert os.path.exists(os.path.join(MUSIC, "Dup Artist", "Album Two", "01 Same Song!.mp3"))
    _settle()

    group = next(g for g in dup_library.get("/api/library/duplicates").json["groups"] if g["artist"] == "Dup Artist")
    extras = [i["id"] for i in group["items"] if not i["keep"]]
    dup_library.post("/api/library/duplicates/delete", json={"ids": extras})
    out = dup_library.post("/api/library/trash/empty", json={"confirm": True}).json
    assert out["trash"]["files"] == 0


def test_always_keeps_one_copy(dup_library):
    group = next(g for g in dup_library.get("/api/library/duplicates").json["groups"] if g["artist"] == "Dup Artist")
    res = dup_library.post("/api/library/duplicates/delete", json={"ids": [i["id"] for i in group["items"]]}).json
    assert res["moved"] == 2
    left = [p for p in os.listdir(os.path.join(BASE, "Album One")) if "Same Song" in p]
    assert left == ["01 Same Song.mp3"]


def test_read_only_folder_is_refused(dup_library, monkeypatch):
    monkeypatch.setattr(dupes, "_writable", lambda: False)
    assert dup_library.get("/api/library/duplicates").json["can_delete"] is False
    r = dup_library.post("/api/library/duplicates/delete", json={"ids": [1]})
    assert r.status_code == 409
