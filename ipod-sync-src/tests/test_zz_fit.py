"""Select-all can pick more than the iPod holds; "Keep what fits" trims it."""
from collections import namedtuple

from app import library, sync
from app.server import create_app
from tests.test_end_to_end import scanned  # noqa: F401  (fixture)

Usage = namedtuple("Usage", "total used free")


def _album_ids():
    return [a["id"] for a in library.list_albums(limit=200)["albums"]]


def test_fit_keeps_whole_albums_in_order_until_the_room_runs_out(scanned, pod, monkeypatch):  # noqa: F811
    ids = _album_ids()
    assert len(ids) >= 3
    sizes = [sync.build_plan([i], [], [])["bytes"]["add"] for i in ids]
    room = sizes[0] + sizes[1] + 1000
    monkeypatch.setattr(sync.shutil, "disk_usage",
                        lambda path: Usage(10**9, 0, room + sync.config.FREE_SPACE_RESERVE))
    fit = sync.fit_selection(ids, [])
    assert fit["albums"][:2] == ids[:2]
    assert fit["bytes"] <= room
    assert fit["dropped"] == len(ids) - len(fit["albums"])
    assert fit["dropped"] >= 1
    plan = sync.build_plan(fit["albums"], fit["tracks"], [])
    assert plan["fits"]


def test_fit_keeps_everything_when_there_is_room(scanned, pod):  # noqa: F811
    ids = _album_ids()
    fit = sync.fit_selection(ids, [])
    assert fit["albums"] == ids and fit["dropped"] == 0


def test_fit_endpoint(scanned, pod):  # noqa: F811
    client = create_app(start_scan=False).test_client()
    ids = _album_ids()
    out = client.post("/api/sync/fit", json={"albums": ids, "tracks": []}).get_json()
    assert out["albums"] == ids
