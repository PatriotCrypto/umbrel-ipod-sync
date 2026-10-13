import os
import time

import pytest

from app import audio, config, ipod, library, sync
from app.server import create_app
from tests.conftest import MUSIC, POD, make_pod


def wait_for_job(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = sync.current_job()
        if job and job["state"] != "running":
            return job
        time.sleep(0.2)
    raise AssertionError("sync did not finish")


@pytest.fixture(scope="module")
def scanned():
    library.scan()
    return library.summary()


def all_album_ids():
    return [a["id"] for a in library.list_albums("", 200)["albums"]]


# ---------- library ----------

def test_scan_indexes_audio_and_ignores_junk(scanned):
    assert scanned["tracks"] == 5          # 2 mp3 + flac + m4a + ogg; txt and broken mp3 skipped
    assert scanned["albums"] == 3
    assert not library.scan_state["error"]


def test_albums_grouped_and_searchable(scanned):
    names = {a["album"] for a in library.list_albums("", 50)["albums"]}
    assert names == {"First Light", "Café Sessions", "Mixed"}
    hit = library.list_albums("alpha dawn", 50)["albums"]
    assert [a["album"] for a in hit] == ["First Light"]
    assert library.list_albums("nothing matches this", 50)["total"] == 0


def test_cover_from_folder_image(scanned):
    first_light = next(a for a in library.list_albums("", 50)["albums"] if a["album"] == "First Light")
    path = library.cover_path(first_light["id"])
    assert path and os.path.getsize(path) > 0
    mixed = next(a for a in library.list_albums("", 50)["albums"] if a["album"] == "Mixed")
    assert library.cover_path(mixed["id"]) is None


def test_path_escape_is_refused():
    with pytest.raises(ValueError):
        library.absolute_path("../../etc/passwd")


def test_conversion_rules():
    s = dict(config.DEFAULT_SETTINGS)
    base = {"codec": "mp3", "samplerate": 44100, "bitrate": 192, "bits": 0, "duration_ms": 1000}
    assert audio.plan_conversion(base, s)[0] == "copy"
    assert audio.plan_conversion({**base, "codec": "flac"}, s)[0] == "convert"
    assert audio.plan_conversion({**base, "codec": "opus"}, s)[0] == "convert"
    assert audio.plan_conversion({**base, "samplerate": 96000}, s)[0] == "convert"
    assert audio.plan_conversion({**base, "bitrate": 500}, s)[0] == "convert"
    assert audio.plan_conversion({**base, "codec": "protected"}, s)[0] == "skip"
    assert audio.plan_conversion({**base, "codec": "alac"}, s)[0] == "convert"
    keep = {**s, "convert_lossless": False}
    assert audio.plan_conversion({**base, "codec": "alac"}, keep)[0] == "copy"
    assert audio.plan_conversion({**base, "codec": "wav", "bits": 24}, keep)[0] == "convert"


# ---------- the iPod ----------

def test_status_for_a_plain_ipod(pod, scanned):
    st = ipod.status()
    assert st["state"] == "ready" and st["can_sync"]
    assert st["device"]["generation"].startswith("Video")
    assert st["device"]["guid"] == "000A270012345678"


def test_full_sync_cycle(pod, scanned):
    plan = sync.build_plan(all_album_ids(), [], [])
    assert plan["counts"]["add"] == 5
    assert plan["counts"]["convert"] == 2          # flac + ogg
    assert plan["fits"]

    sync.start_job(all_album_ids(), [], [])
    job = wait_for_job()
    assert job["state"] == "done", job
    assert job["added"] == 5 and job["converted"] == 2 and job["error_count"] == 0

    tracks = ipod.current_tracks(force=True)
    assert len(tracks) == 5
    titles = {t["title"] for t in tracks}
    assert "Tab\there \\ slash" in titles            # escaping survives the round trip
    assert any(t["artist"] == "Béta & Friends" for t in tracks)
    for t in tracks:
        on_disk = os.path.join(POD, t["path"].lstrip(":").replace(":", os.sep))
        assert os.path.exists(on_disk), on_disk
        assert t["path"].endswith((".mp3", ".m4a"))  # nothing the iPod cannot play
    assert not os.listdir(os.path.join(config.WORK_DIR)) if os.path.isdir(config.WORK_DIR) else True

    # a second run finds nothing new
    again = sync.build_plan(all_album_ids(), [], [])
    assert again["counts"]["add"] == 0 and again["counts"]["already_on_ipod"] == 5
    with pytest.raises(ipod.IpodError):
        sync.start_job(all_album_ids(), [], [])

    # albums now report as present
    keys = {t["key"] for t in tracks}
    albums = library.list_albums("", 50, 0, keys)["albums"]
    assert all(a["on_ipod"] == a["tracks"] for a in albums)

    # a backup of the database was taken before writing
    assert len(sync.list_backups("000A270012345678")) == 1


def test_remove_tracks_and_restore_backup(pod, scanned):
    sync.start_job(all_album_ids(), [], [])
    job = wait_for_job()
    assert job["state"] == "done", job
    before = ipod.current_tracks(force=True)
    victim = before[0]
    victim_file = os.path.join(POD, victim["path"].lstrip(":").replace(":", os.sep))
    assert os.path.exists(victim_file)

    sync.start_job([], [], [victim["id"]])
    job = wait_for_job()
    assert job["state"] == "done", job
    after = ipod.current_tracks(force=True)
    assert len(after) == len(before) - 1
    assert victim["key"] not in {t["key"] for t in after}     # ids are renumbered on write
    assert not os.path.exists(victim_file)

    backups = sync.list_backups("000A270012345678")
    assert len(backups) == 2
    oldest = backups[-1]["id"]                       # state before the first sync: no tracks
    sync.restore_backup("000A270012345678", oldest)
    assert ipod.current_tracks(force=True) == []


def test_unreadable_database_blocks_everything(pod, scanned):
    sync.start_job(all_album_ids(), [], [])
    assert wait_for_job()["state"] == "done"
    db = os.path.join(POD, "iPod_Control", "iTunes", "iTunesDB")
    good = open(db, "rb").read()
    open(db, "wb").write(b"garbage")
    try:
        st = ipod.status()
        assert not st["can_sync"]
        assert st["problems"][0]["code"] == "database_unreadable"
        with pytest.raises(ipod.IpodError):
            sync.start_job(all_album_ids(), [], [])
        assert open(db, "rb").read() == b"garbage"   # untouched
    finally:
        open(db, "wb").write(good)


def test_nano_5g_without_itunes_setup_is_blocked(scanned):
    make_pod(POD, model="MC027")
    ipod.invalidate_tracks()
    st = ipod.status()
    assert st["device"]["generation"].startswith("Nano with camera")
    assert not st["can_sync"]
    assert st["problems"][0]["code"] == "needs_itunes_setup"
    with pytest.raises(ipod.IpodError):
        sync.start_job(all_album_ids(), [], [])


def test_nano_5g_commit_failure_changes_nothing(scanned):
    """If the preflight were bypassed, the helper still refuses and rolls back."""
    make_pod(POD, model="MC027")
    from tests.conftest import HELPER
    import subprocess
    line = "\t".join(["ADD", "k", os.path.join(MUSIC, "Alpha Band", "First Light", "01 Dawn.mp3"),
                      "t", "a", "b", "", "", "", "1", "1", "1", "1", "2020", "2000", "128",
                      "44100", "mp3", "0", ""]) + "\nCOMMIT\n"
    out = subprocess.run([HELPER, "sync", POD], input=line, capture_output=True, text=True)
    assert "missing HashInfo" in out.stdout
    assert not any(files for _d, _s, files in os.walk(os.path.join(POD, "iPod_Control", "Music")))


def test_stale_removal_request_is_rejected(pod, scanned):
    client = create_app(start_scan=False).test_client()
    assert client.post("/api/sync/start", json={"albums": all_album_ids()}).status_code == 200
    assert wait_for_job()["state"] == "done"
    listing = client.get("/api/ipod/tracks?refresh=1").json
    victim = listing["tracks"][0]["id"]
    stale = client.post("/api/sync/plan", json={"remove": [victim], "revision": "deadbeef0000"})
    assert stale.status_code == 409
    missing = client.post("/api/sync/plan", json={"remove": [victim]})
    assert missing.status_code == 409
    ok = client.post("/api/sync/plan", json={"remove": [victim], "revision": listing["revision"]})
    assert ok.status_code == 200 and ok.json["counts"]["remove"] == 1


# ---------- HTTP API ----------

def test_http_api(pod, scanned):
    client = create_app(start_scan=False).test_client()
    assert client.get("/api/health").json == {"ok": True}
    assert client.get("/").status_code == 200
    st = client.get("/api/status").json
    assert st["ipod"]["state"] == "ready" and st["library"]["tracks"] == 5

    albums = client.get("/api/library/albums?q=caf").json
    assert albums["total"] == 1
    tracks = client.get(f"/api/library/albums/{albums['albums'][0]['id']}/tracks").json["tracks"]
    assert tracks[0]["title"] == "Tab\there \\ slash"
    assert client.get("/api/library/albums/not-a-key/tracks").status_code == 400
    assert client.get("/api/library/cover/zzzz").status_code == 404

    plan = client.post("/api/sync/plan", json={"albums": all_album_ids()}).json
    assert plan["counts"]["add"] == 5
    assert client.post("/api/sync/plan", json={"albums": "nope"}).status_code == 400

    r = client.put("/api/settings", json={"bitrate": 192})
    assert r.json["bitrate"] == 192
    assert client.put("/api/settings", json={"bitrate": 999}).status_code == 400
    client.put("/api/settings", json={"bitrate": 256})

    assert client.post("/api/sync/start", json={"albums": all_album_ids()}).status_code == 200
    job = wait_for_job()
    assert job["state"] == "done"
    listed = client.get("/api/ipod/tracks?q=gamma").json
    assert listed["total"] == 2
    assert client.post("/api/sync/start", json={"albums": all_album_ids()}).status_code == 409
