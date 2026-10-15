import os
import shutil
import sqlite3
import time

import pytest
from mutagen.easyid3 import EasyID3

from app import config, dupes, library, playlists
from app.server import create_app
from tests.conftest import MUSIC, tone


def _song(folder, album, name, title, artist="Folk Artist", genre="Folk", kbps="128k"):
    p = os.path.join(MUSIC, folder, album, name)
    tone(p, 440, 2, "-c:a", "libmp3lame", "-b:a", kbps)
    tag = EasyID3()
    tag.update({"title": title, "artist": artist, "album": album, "genre": genre})
    tag.save(p)
    return p


def _settle():
    for _ in range(100):
        if not library.summary()["scan"]["running"]:
            break
        time.sleep(0.1)
    library.scan()


@pytest.fixture()
def client():
    original = config.load_settings()["music_folders"]
    for stale in ("V21 Music", "V21 Drive"):
        shutil.rmtree(os.path.join(MUSIC, stale), ignore_errors=True)
    _song("V21 Music", "Porch Songs", "01 Zephyr Café Blues.mp3", "Zephyr Café Blues")
    _song("V21 Music", "Porch Songs", "02 100% Sure_Thing.mp3", "100% Sure_Thing")
    _settle()
    yield create_app(start_scan=False).test_client()
    config.save_settings({"music_folders": original})
    for stale in ("V21 Music", "V21 Drive", "V21 Drive.away"):
        shutil.rmtree(os.path.join(MUSIC, stale), ignore_errors=True)
    shutil.rmtree(os.path.join(MUSIC, ".ipod-trash"), ignore_errors=True)
    _settle()


def _ids(client, query):
    return [t["id"] for t in client.get(f"/api/library/tracks?q={query}&limit=100").json["tracks"]]


# ---------- search and paging ----------

def test_search_ignores_accents_and_wildcards(client):
    assert len(_ids(client, "zephyr+cafe")) == 1   # "Zephyr Café Blues"
    assert len(_ids(client, "100%25")) == 1         # a literal percent sign, not "match everything"
    assert len(_ids(client, "%25")) == 1
    assert len(_ids(client, "sure_thing")) == 1
    assert _ids(client, "zzzznothing") == []


def test_paging_and_sorting_are_consistent(client):
    everything = client.get("/api/library/tracks?limit=5000").json
    total = everything["total"]
    first = client.get("/api/library/tracks?limit=5&offset=0").json
    second = client.get("/api/library/tracks?limit=5&offset=5").json
    assert first["total"] == total
    assert [t["id"] for t in first["tracks"] + second["tracks"]] == [t["id"] for t in everything["tracks"][:10]]
    for sort in ("artist", "title", "album", "recent", "length"):
        assert client.get(f"/api/library/tracks?sort={sort}&limit=3").status_code == 200
    titles = [t["title"].lower() for t in client.get("/api/library/tracks?sort=title&limit=5000").json["tracks"]]
    assert titles == sorted(titles, key=lambda t: t)


# ---------- playlists ----------

def test_playlist_lifecycle(client):
    ids = [t["id"] for t in client.get("/api/library/tracks?limit=4").json["tracks"]]
    made = client.post("/api/playlists", json={"name": "  Road   Trip ", "track_ids": ids + ids[:1]})
    assert made.status_code == 201 and made.json["name"] == "Road Trip" and made.json["added"] == len(ids)
    pid = made.json["id"]
    again = client.post("/api/playlists", json={"name": "road trip"}).json
    assert again["name"] == "road trip (2)"
    assert client.post("/api/playlists", json={"name": "   "}).status_code == 400

    got = client.get(f"/api/playlists/{pid}").json
    assert [t["id"] for t in got["tracks"]] == ids and got["missing"] == 0

    extra = [t["id"] for t in client.get("/api/library/tracks?limit=1&offset=10").json["tracks"]]
    res = client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": ids[:1] + extra}).json
    assert res == {"added": len(extra), "skipped": 1}

    got = client.get(f"/api/playlists/{pid}").json
    order = [t["pos"] for t in got["tracks"]]
    new_order = list(reversed(order))[:-1]            # reverse and drop one
    assert client.post(f"/api/playlists/{pid}/arrange", json={"order": new_order + [9999]}).json["tracks"] == len(new_order)
    after = client.get(f"/api/playlists/{pid}").json
    assert [t["id"] for t in after["tracks"]] == [t["id"] for t in reversed(got["tracks"])][:-1]

    assert client.put(f"/api/playlists/{pid}", json={"name": "Renamed"}).json["name"] == "Renamed"
    assert client.put(f"/api/playlists/{again['id']}", json={"name": "renamed"}).json["name"] == "renamed (2)"
    listing = client.get("/api/playlists").json["playlists"]
    row = next(p for p in listing if p["id"] == pid)
    assert row["tracks"] == len(new_order) and row["covers"]

    assert client.delete(f"/api/playlists/{pid}").status_code == 200
    assert client.get(f"/api/playlists/{pid}").status_code == 404
    client.delete(f"/api/playlists/{again['id']}")


def test_playlist_waits_for_missing_songs(client):
    track = client.get("/api/library/tracks?q=zephyr").json["tracks"][0]
    pid = client.post("/api/playlists", json={"name": "Waiting", "track_ids": [track["id"]]}).json["id"]
    path = os.path.join(MUSIC, "V21 Music", "Porch Songs", "01 Zephyr Café Blues.mp3")
    away = path + ".away"
    os.rename(path, away)
    _settle()
    got = client.get(f"/api/playlists/{pid}").json
    assert got["tracks"] == [] and got["missing"] == 1
    os.rename(away, path)
    _settle()
    got = client.get(f"/api/playlists/{pid}").json
    assert len(got["tracks"]) == 1 and got["missing"] == 0
    client.delete(f"/api/playlists/{pid}")


def test_playlist_follows_the_surviving_copy_when_duplicates_are_removed(client):
    _song("V21 Music", "Copy A", "01 Twin.mp3", "Twin Song", kbps="192k")
    _song("V21 Music", "Copy B", "01 Twin.mp3", "Twin Song", kbps="96k")
    _settle()
    group = next(g for g in client.get("/api/library/duplicates").json["groups"] if g["title"] == "Twin Song")
    worst = next(i for i in group["items"] if not i["keep"])
    best = next(i for i in group["items"] if i["keep"])
    pid = client.post("/api/playlists", json={"name": "Twins", "track_ids": [worst["id"]]}).json["id"]
    assert client.post("/api/library/duplicates/delete", json={"ids": [worst["id"]]}).json["moved"] == 1
    got = client.get(f"/api/playlists/{pid}").json
    assert [t["id"] for t in got["tracks"]] == [best["id"]] and got["missing"] == 0
    client.delete(f"/api/playlists/{pid}")


# ---------- music folders ----------

def test_folder_browser_and_validation(client):
    root = client.get("/api/folders").json
    names = [f["name"] for f in root["folders"]]
    assert "V21 Music" in names and not any(n.startswith(".") for n in names)
    assert next(f for f in root["folders"] if f["name"] == "V21 Music")["music"] is False   # music is one level down
    inner = client.get("/api/folders?path=V21 Music/Porch Songs").json
    assert inner["music_here"] is True and inner["parent"] == "V21 Music"
    assert client.get("/api/folders?path=../..").status_code == 400
    assert client.get("/api/folders?path=nope/never").status_code == 400
    for bad in (["../etc"], ["V21 Music/../.."], [".hidden"], [], "V21 Music", ["not a folder"]):
        r = client.put("/api/settings", json={"music_folders": bad})
        assert r.status_code == 400, bad


def test_choosing_folders_changes_the_library(client):
    ok = client.put("/api/settings", json={"music_folders": ["V21 Music"]})
    assert ok.status_code == 200 and ok.json["music_folders"] == ["V21 Music"]
    _settle()
    assert client.get("/api/library/albums?limit=50").json["total"] == 1
    assert client.get("/api/library/tracks?limit=50").json["total"] == 2
    # a folder inside a chosen folder is redundant and dropped
    both = client.put("/api/settings", json={"music_folders": ["V21 Music", "V21 Music/Porch Songs"]}).json
    assert both["music_folders"] == ["V21 Music"]
    client.put("/api/settings", json={"music_folders": [""]})
    _settle()
    assert client.get("/api/library/albums?limit=50").json["total"] > 1


def test_a_missing_folder_does_not_wipe_its_songs(client):
    _song("V21 Drive", "Away Album", "01 Far.mp3", "Far Away", artist="Drive Artist")
    client.put("/api/settings", json={"music_folders": ["V21 Music", "V21 Drive"]})
    _settle()
    assert _ids(client, "far+away")
    drive = os.path.join(MUSIC, "V21 Drive")
    os.rename(drive, drive + ".away")                      # like an unplugged drive
    _settle()
    assert library.scan_state["missing_folders"] == ["V21 Drive"]
    assert _ids(client, "far+away"), "songs on an unplugged drive must stay in the library"
    assert _ids(client, "zephyr")
    os.rename(drive + ".away", drive)


def test_trash_goes_into_the_folder_the_song_came_from(client):
    _song("V21 Music", "Dupe One", "01 Same.mp3", "Same Tune", kbps="192k")
    _song("V21 Music", "Dupe Two", "01 Same.mp3", "Same Tune", kbps="96k")
    client.put("/api/settings", json={"music_folders": ["V21 Music"]})
    _settle()
    group = next(g for g in client.get("/api/library/duplicates").json["groups"] if g["title"] == "Same Tune")
    victim = next(i for i in group["items"] if not i["keep"])
    assert client.post("/api/library/duplicates/delete", json={"ids": [victim["id"]]}).json["moved"] == 1
    assert os.path.isdir(os.path.join(MUSIC, "V21 Music", ".ipod-trash"))
    assert client.get("/api/library/duplicates").json["trash"]["files"] >= 1
    assert client.post("/api/library/trash/restore").json["restored"] >= 1
    _settle()
    assert os.path.exists(os.path.join(MUSIC, victim["path"]))


# ---------- upgrading an older index ----------

def test_old_index_is_upgraded(tmp_path, monkeypatch):
    db = sqlite3.connect(tmp_path / "old.db")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE tracks (id INTEGER PRIMARY KEY, relpath TEXT UNIQUE NOT NULL, mtime REAL NOT NULL,
            size INTEGER NOT NULL, title TEXT, artist TEXT, albumartist TEXT, album TEXT, genre TEXT,
            composer TEXT, track INTEGER, tracks INTEGER, disc INTEGER, discs INTEGER, year INTEGER,
            duration_ms INTEGER, bitrate INTEGER, samplerate INTEGER, bits INTEGER, codec TEXT,
            compilation INTEGER, album_key TEXT NOT NULL, key TEXT NOT NULL);
        INSERT INTO tracks (relpath, mtime, size, title, artist, albumartist, album, genre, album_key, key)
        VALUES ('Artist/Album/01 Song.mp3', 1, 10, 'Song', 'Artist', '', 'Album', 'hip hop', 'aaaaaaaaaaaa', 'k1'),
               ('Artist/Album/02 Other.mp3', 1, 10, 'Other', 'Artist', '', 'Album', '', 'aaaaaaaaaaaa', 'k2');""")
    monkeypatch.setattr(config, "LEGACY_PREFIX", "downloads")
    library._ensure_schema(db)
    rows = db.execute("SELECT relpath, genre_c, f_title, search FROM tracks ORDER BY id").fetchall()
    assert rows[0]["relpath"] == "downloads/Artist/Album/01 Song.mp3"
    assert rows[0]["genre_c"] == "Hip-Hop/Rap" and rows[1]["genre_c"] == "Hip-Hop/Rap"   # borrowed from the album
    assert "artist" in rows[0]["search"] and rows[0]["f_title"] == "song"
    assert db.execute("SELECT COUNT(*) FROM albums").fetchone()[0] == 1
    before = [r["relpath"] for r in db.execute("SELECT relpath FROM tracks")]
    library._ensure_schema(db)                     # running it again changes nothing
    assert [r["relpath"] for r in db.execute("SELECT relpath FROM tracks")] == before


def test_page_is_served_with_safe_headers(client):
    r = client.get("/")
    assert r.status_code == 200 and b"uPod" in r.data
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert client.get("/api/status").headers["Cache-Control"] == "no-store"
    for script in ("folders.js", "playlists.js", "app.js"):
        assert client.get(f"/static/{script}").status_code == 200


# ---------- review fixes ----------

def test_arrange_keeps_missing_songs(client):
    config.save_settings({"music_folders": ["V21 Music"]})
    _settle()
    ids = _ids(client, "porch")
    assert len(ids) == 2
    pid = client.post("/api/playlists", json={"name": "Keep"}).json["id"]
    client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": ids})
    one = client.get(f"/api/playlists/{pid}").json
    assert len(one["tracks"]) == 2
    client.post(f"/api/playlists/{pid}/arrange", json={"order": [one["tracks"][0]["pos"]]})
    assert len(client.get(f"/api/playlists/{pid}").json["tracks"]) == 1


def test_arrange_does_not_drop_absent_entries():
    conn = library.connect()
    conn.execute("INSERT INTO playlists (name, created, updated) VALUES ('Ghost', 0, 0)")
    pid = conn.execute("SELECT id FROM playlists WHERE name='Ghost'").fetchone()[0]
    conn.execute("INSERT INTO playlist_items VALUES (?,?,?)", (pid, 0, "nowhere/ghost.mp3"))
    conn.commit(); conn.close()
    try:
        playlists.arrange(pid, [])
        conn = library.connect()
        assert conn.execute("SELECT COUNT(*) FROM playlist_items WHERE playlist_id=?", (pid,)).fetchone()[0] == 1
        conn.close()
    finally:
        playlists.delete(pid)


def test_empty_folder_does_not_wipe_index(client):
    config.save_settings({"music_folders": ["V21 Music"]})
    _settle()
    before = library.summary()["tracks"]
    assert before >= 2
    for name in os.listdir(os.path.join(MUSIC, "V21 Music")):
        shutil.rmtree(os.path.join(MUSIC, "V21 Music", name))
    library.scan()
    assert library.summary()["tracks"] == before
    assert library.summary()["scan"]["error"]


def test_cross_site_writes_refused(client):
    r = client.post("/api/library/scan", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert client.post("/api/library/scan", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200


def test_unknown_cover_leaves_no_marker(client):
    assert library.cover_path("deadbeef0000") is None
    assert not os.path.exists(os.path.join(library._covers_dir(), "deadbeef0000.none"))


def test_symlink_not_indexed_or_trashed(client):
    config.save_settings({"music_folders": ["V21 Music"]})
    real = _song("V21 Music", "Real", "a.mp3", "Linked Song")
    os.makedirs(os.path.join(MUSIC, "V21 Music", "Links"), exist_ok=True)
    os.symlink(real, os.path.join(MUSIC, "V21 Music", "Links", "b.mp3"))
    _settle()
    assert len(_ids(client, "linked+song")) == 1
