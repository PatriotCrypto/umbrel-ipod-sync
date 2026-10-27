"""HTTP API and static UI. Umbrel's app proxy handles sign-in in front of this."""
import os
import threading
import time

from flask import Flask, jsonify, request, send_file, send_from_directory

from . import audio, config, dupes, ipod, library, playlists, sync

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static")
MAX_IDS = 20000

_status_cache = {"at": 0.0, "value": None}
_status_lock = threading.Lock()


def _ids(payload, key, kind):
    values = payload.get(key) or []
    if not isinstance(values, list) or len(values) > MAX_IDS:
        raise ValueError(f"'{key}' must be a list of at most {MAX_IDS} items")
    if kind is int:
        return [int(v) for v in values]
    return [str(v) for v in values]


def _ipod_status(max_age=3.0):
    """iPod status, reused for a few seconds and never fetched mid-sync."""
    job = sync.current_job()
    with _status_lock:
        age = time.time() - _status_cache["at"]
        busy = job is not None and job["state"] == "running"
        finished = (job or {}).get("finished") or 0
        stale = _status_cache["at"] < finished   # cached before the last sync ended
        if _status_cache["value"] is not None and (busy or (age < max_age and not stale)):
            return _status_cache["value"]
        value = ipod.status()
        _status_cache.update(at=time.time(), value=value)
        return value


def _check_revision(body, remove):
    if remove and body.get("revision") != ipod.revision():
        raise ipod.IpodError("The iPod's music list has changed since it was loaded. "
                             "Reload and choose the tracks to remove again.")


def _drop_status_cache():
    with _status_lock:
        _status_cache["value"] = None


def create_app(start_scan=True):
    app = Flask(__name__, static_folder=None)
    app.config["JSON_SORT_KEYS"] = False

    @app.errorhandler(ipod.IpodError)
    def _ipod_error(exc):
        return jsonify(error=str(exc)), 409

    @app.errorhandler(dupes.DupeError)
    def _dupe_error(exc):
        return jsonify(error=str(exc)), 409

    @app.errorhandler(ValueError)
    def _value_error(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(LookupError)
    def _missing(exc):
        return jsonify(error=str(exc)), 404

    @app.before_request
    def _same_site_only():
        # Changes are only accepted from this app's own pages, never from another website.
        if request.method not in ("GET", "HEAD", "OPTIONS") \
                and request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(error="Cross-site requests are not allowed."), 403

    @app.after_request
    def _headers(response):
        # The page is tiny and changes with every release; lists are cached by the browser
        # only for the moment it takes to flip between sections.
        if request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(STATIC_DIR, name)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True)

    @app.get("/api/status")
    def status():
        return jsonify(ipod=_ipod_status(), library=library.summary(),
                       job=sync.current_job(), settings=config.load_settings())

    @app.post("/api/ipod/mount")
    def mount():
        ipod.mount_ipod()
        _drop_status_cache()
        return jsonify(ipod=_ipod_status(0))

    @app.post("/api/ipod/eject")
    def eject():
        job = sync.current_job()
        if job and job["state"] == "running":
            raise ipod.IpodError("A sync is running. Wait for it to finish before ejecting.")
        ipod.unmount_ipod()
        _drop_status_cache()
        return jsonify(ipod=_ipod_status(0))

    @app.get("/api/ipod/tracks")
    def ipod_tracks():
        query = (request.args.get("q") or "").strip().lower()
        limit = max(1, min(int(request.args.get("limit", 100)), 500))
        offset = max(0, int(request.args.get("offset", 0)))
        tracks = ipod.current_tracks(force=request.args.get("refresh") == "1")
        if query:
            terms = query.split()
            tracks = [t for t in tracks
                      if all(term in f"{t['title']} {t['artist']} {t['album']}".lower()
                             for term in terms)]
        tracks = sorted(tracks, key=lambda t: (t["artist"].lower(), t["album"].lower(),
                                               t["disc"], t["track"], t["title"].lower()))
        page = tracks[offset:offset + limit]
        covers = library.album_keys_for({t["key"] for t in page})
        return jsonify(total=len(tracks), revision=ipod.revision(), tracks=[
            dict({k: t[k] for k in ("id", "title", "artist", "album", "albumartist", "track",
                                    "year", "duration_ms", "size")},
                 album_key=covers.get(t["key"], ""))
            for t in page])

    @app.get("/api/library")
    def library_summary():
        return jsonify(library.summary())

    @app.post("/api/library/scan")
    def library_scan():
        started = library.start_scan()
        return jsonify(started=started, scan=dict(library.scan_state))

    @app.get("/api/library/albums")
    def albums():
        keys = {t["key"] for t in ipod.current_tracks()} if ipod.is_mounted() else set()
        return jsonify(library.list_albums(
            request.args.get("q", ""), request.args.get("limit", 60),
            request.args.get("offset", 0), keys, sort=request.args.get("sort", "artist"),
            status=request.args.get("status", "all"), letter=request.args.get("letter", ""),
            artist=request.args.get("artist", ""), genre=request.args.get("genre", "")))

    @app.get("/api/library/genres")
    def genres_list():
        return jsonify(genres=library.list_genres())

    @app.get("/api/library/tracks")
    def tracks_list():
        return jsonify(library.list_tracks(
            request.args.get("q", ""), request.args.get("genre", ""),
            request.args.get("sort", "artist"), request.args.get("limit", 200),
            request.args.get("offset", 0)))

    @app.get("/api/library/duplicates")
    def duplicates():
        return jsonify(dupes.scan_duplicates())

    @app.post("/api/library/duplicates/delete")
    def duplicates_delete():
        body = request.get_json(silent=True) or {}
        result = dupes.trash_duplicates(_ids(body, "ids", int))
        return jsonify(dict(result, trash=dupes.trash_info()))

    @app.post("/api/library/trash/restore")
    def trash_restore():
        result = dupes.restore_trash()
        library.start_scan()
        return jsonify(dict(result, trash=dupes.trash_info()))

    @app.post("/api/library/trash/empty")
    def trash_empty():
        body = request.get_json(silent=True) or {}
        if body.get("confirm") is not True:
            raise ValueError("confirmation missing")
        return jsonify(emptied=dupes.empty_trash(), trash=dupes.trash_info())

    @app.get("/api/library/albums/<key>/tracks")
    def album_tracks(key):
        if not library.ALBUM_KEY_RE.match(key):
            raise ValueError("invalid album id")
        keys = {t["key"] for t in ipod.current_tracks()} if ipod.is_mounted() else set()
        return jsonify(tracks=library.album_tracks(key, keys))

    @app.get("/api/library/tracks/<int:track_id>/audio")
    def library_audio(track_id):
        row = library.track_by_id(track_id)
        if not row:
            return ("", 404)
        src = library.absolute_path(row["relpath"])
        if not os.path.isfile(src):
            return ("", 404)
        try:
            path = audio.preview_file(src, row["id"], row["mtime"],
                                      os.path.join(config.DATA_DIR, "preview"), row["codec"])
        except RuntimeError as exc:
            return jsonify(error=f"This song could not be prepared for playing: {exc}"), 500
        return send_file(path, conditional=True, max_age=3600)

    @app.get("/api/ipod/tracks/<int:track_id>/audio")
    def ipod_audio(track_id):
        if not ipod.is_mounted():
            return ("", 404)
        track = next((t for t in ipod.current_tracks() if t["id"] == track_id), None)
        if not track or not track["path"]:
            return ("", 404)
        root = os.path.realpath(ipod.mount_path())
        path = os.path.realpath(os.path.join(root, track["path"].lstrip(":").replace(":", "/")))
        if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
            return ("", 404)
        if os.path.splitext(path)[1].lower() not in (".mp3", ".m4a", ".m4p", ".wav"):
            return jsonify(error="This song's format can't be played in the browser."), 415
        return send_file(path, conditional=True, max_age=3600)

    @app.get("/api/library/cover/<key>")
    def cover(key):
        path = library.cover_path(key)
        if not path:
            return ("", 404)
        response = send_file(path, mimetype="image/jpeg")
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response

    @app.post("/api/sync/plan")
    def sync_plan():
        body = request.get_json(silent=True) or {}
        remove = _ids(body, "remove", int)
        _check_revision(body, remove)
        plan = sync.build_plan(_ids(body, "albums", str), _ids(body, "tracks", int), remove)
        plan["add"] = plan["add"][:5]  # the UI only needs counts and a sample
        return jsonify(plan)

    @app.post("/api/sync/fit")
    def sync_fit():
        body = request.get_json(silent=True) or {}
        return jsonify(sync.fit_selection(_ids(body, "albums", str), _ids(body, "tracks", int)))

    @app.post("/api/sync/start")
    def sync_start():
        body = request.get_json(silent=True) or {}
        remove = _ids(body, "remove", int)
        _check_revision(body, remove)
        job = sync.start_job(_ids(body, "albums", str), _ids(body, "tracks", int), remove)
        return jsonify(job=job)

    @app.get("/api/sync/job")
    def sync_job():
        return jsonify(job=sync.current_job())

    @app.post("/api/sync/cancel")
    def sync_cancel():
        return jsonify(cancelled=sync.cancel_job())

    def _with_folder_state(settings):
        root = config.storage_root()
        settings = dict(settings)
        settings["missing_folders"] = [f for f in settings.get("music_folders", [])
                                       if not os.path.isdir(os.path.join(root, f))]
        return settings

    @app.get("/api/settings")
    def get_settings():
        return jsonify(_with_folder_state(config.load_settings()))

    @app.put("/api/settings")
    def put_settings():
        before = config.music_folders()
        settings = config.save_settings(request.get_json(silent=True) or {})
        if config.music_folders() != before:
            library.start_scan()
        return jsonify(_with_folder_state(settings))

    @app.get("/api/folders")
    def folders():
        return jsonify(library.browse_folders(request.args.get("path", "")))

    # ---- playlists ----
    @app.get("/api/playlists")
    def playlists_list():
        return jsonify(playlists=playlists.list_playlists())

    @app.post("/api/playlists")
    def playlists_create():
        body = request.get_json(silent=True) or {}
        made = playlists.create(body.get("name"), _ids(body, "track_ids", int))
        return jsonify(made), 201

    @app.get("/api/playlists/<int:pid>")
    def playlists_get(pid):
        return jsonify(playlists.get_playlist(pid))

    @app.put("/api/playlists/<int:pid>")
    def playlists_rename(pid):
        body = request.get_json(silent=True) or {}
        return jsonify(playlists.rename(pid, body.get("name")))

    @app.delete("/api/playlists/<int:pid>")
    def playlists_delete(pid):
        playlists.delete(pid)
        return jsonify(ok=True)

    @app.post("/api/playlists/<int:pid>/tracks")
    def playlists_add(pid):
        body = request.get_json(silent=True) or {}
        return jsonify(playlists.add_tracks(pid, _ids(body, "track_ids", int)))

    @app.post("/api/playlists/<int:pid>/arrange")
    def playlists_arrange(pid):
        body = request.get_json(silent=True) or {}
        return jsonify(playlists.arrange(pid, _ids(body, "order", int)))

    @app.get("/api/backups")
    def backups():
        state = _ipod_status()
        guid = (state.get("device") or {}).get("guid", "")
        return jsonify(backups=sync.list_backups(guid))

    @app.post("/api/backups/restore")
    def restore():
        body = request.get_json(silent=True) or {}
        state = _ipod_status(0)
        if state.get("state") != "ready":
            raise ipod.IpodError("The iPod is not connected.")
        sync.restore_backup(state["device"]["guid"], str(body.get("id", "")))
        _drop_status_cache()
        return jsonify(ipod=_ipod_status(0))

    if start_scan and os.path.isdir(config.MUSIC_DIR):
        library.start_scan()
    return app


def main():
    from waitress import serve
    port = int(os.environ.get("PORT", "8080"))
    serve(create_app(), host="0.0.0.0", port=port, threads=24)


if __name__ == "__main__":
    main()
