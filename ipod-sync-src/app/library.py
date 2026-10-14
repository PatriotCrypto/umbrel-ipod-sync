"""The music library on the Umbrel: scanning, search, albums and cover art."""
import hashlib
import os
import re
import sqlite3
import subprocess
import threading
import time
import unicodedata

from . import audio, config, genres

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    relpath TEXT UNIQUE NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    title TEXT, artist TEXT, albumartist TEXT, album TEXT, genre TEXT, composer TEXT,
    track INTEGER, tracks INTEGER, disc INTEGER, discs INTEGER, year INTEGER,
    duration_ms INTEGER, bitrate INTEGER, samplerate INTEGER, bits INTEGER,
    codec TEXT, compilation INTEGER,
    album_key TEXT NOT NULL,
    key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_key);
CREATE INDEX IF NOT EXISTS idx_tracks_key ON tracks(key);
"""

ALBUM_KEY_RE = re.compile(r"^[0-9a-f]{12}$")
COVER_NAMES = ("cover", "folder", "front", "album", "albumart")
COVER_EXTS = (".jpg", ".jpeg", ".png")

_scan_lock = threading.Lock()
scan_state = {"running": False, "scanned": 0, "total": 0, "added": 0, "removed": 0,
              "finished": None, "error": None}


def _norm(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def track_key(artist, album, title, track):
    """Identity of a track independent of where it is stored."""
    raw = f"{_norm(artist)}|{_norm(album)}|{_norm(title)}|{int(track or 0)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def album_key(album_artist, album):
    raw = f"{_norm(album_artist)}|{_norm(album)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def album_artist_for(meta):
    if meta["albumartist"]:
        return meta["albumartist"]
    if meta["compilation"]:
        return "Various Artists"
    return meta["artist"]


def connect():
    os.makedirs(config.DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(config.DATA_DIR, "library.db"), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


# ---------- scanning ----------

def _walk_audio(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() in audio.AUDIO_EXTENSIONS:
                yield os.path.join(dirpath, name)


def scan(root=None):
    """Index new and changed files and forget files that are gone."""
    root = root or config.MUSIC_DIR
    if not _scan_lock.acquire(blocking=False):
        return False
    try:
        scan_state.update(running=True, scanned=0, total=0, added=0, removed=0,
                          finished=None, error=None)
        if not os.path.isdir(root):
            raise OSError(f"Music folder not found: {root}")
        conn = connect()
        try:
            known = {r["relpath"]: (r["mtime"], r["size"])
                     for r in conn.execute("SELECT relpath, mtime, size FROM tracks")}
            files = list(_walk_audio(root))
            scan_state["total"] = len(files)
            seen = set()
            for path in files:
                rel = os.path.relpath(path, root)
                seen.add(rel)
                scan_state["scanned"] += 1
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                if known.get(rel) == (st.st_mtime, st.st_size):
                    continue
                meta = audio.read_metadata(path)
                if meta is None:
                    continue
                aa = album_artist_for(meta)
                conn.execute(
                    """INSERT INTO tracks (relpath, mtime, size, title, artist, albumartist,
                         album, genre, composer, track, tracks, disc, discs, year, duration_ms,
                         bitrate, samplerate, bits, codec, compilation, album_key, key)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(relpath) DO UPDATE SET
                         mtime=excluded.mtime, size=excluded.size, title=excluded.title,
                         artist=excluded.artist, albumartist=excluded.albumartist,
                         album=excluded.album, genre=excluded.genre, composer=excluded.composer,
                         track=excluded.track, tracks=excluded.tracks, disc=excluded.disc,
                         discs=excluded.discs, year=excluded.year,
                         duration_ms=excluded.duration_ms, bitrate=excluded.bitrate,
                         samplerate=excluded.samplerate, bits=excluded.bits,
                         codec=excluded.codec, compilation=excluded.compilation,
                         album_key=excluded.album_key, key=excluded.key""",
                    (rel, st.st_mtime, st.st_size, meta["title"], meta["artist"],
                     meta["albumartist"], meta["album"], meta["genre"], meta["composer"],
                     meta["track"], meta["tracks"], meta["disc"], meta["discs"], meta["year"],
                     meta["duration_ms"], meta["bitrate"], meta["samplerate"], meta["bits"],
                     meta["codec"], meta["compilation"],
                     album_key(aa, meta["album"]),
                     track_key(meta["artist"], meta["album"], meta["title"], meta["track"])))
                scan_state["added"] += 1
                if scan_state["added"] % 200 == 0:
                    conn.commit()
            gone = [rel for rel in known if rel not in seen]
            for rel in gone:
                conn.execute("DELETE FROM tracks WHERE relpath = ?", (rel,))
            scan_state["removed"] = len(gone)
            conn.commit()
        finally:
            conn.close()
        scan_state["finished"] = time.time()
        return True
    except Exception as exc:  # reported to the UI
        scan_state["error"] = str(exc)
        return True
    finally:
        scan_state["running"] = False
        _scan_lock.release()


def start_scan():
    if scan_state["running"]:
        return False
    threading.Thread(target=scan, name="library-scan", daemon=True).start()
    return True


# ---------- queries ----------

def summary():
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS tracks, COUNT(DISTINCT album_key) AS albums, "
            "COALESCE(SUM(size),0) AS bytes FROM tracks").fetchone()
        return {"tracks": row["tracks"], "albums": row["albums"], "bytes": row["bytes"],
                "scan": dict(scan_state), "music_dir_exists": os.path.isdir(config.MUSIC_DIR)}
    finally:
        conn.close()


SORTS = ("artist", "album", "year", "size", "recent")
STATUSES = ("all", "new", "on")


def _fold(text):
    """Lower-case and accent-free, so "Émile" sorts with the E's."""
    decomposed = unicodedata.normalize("NFKD", _norm(text))
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def letter_of(text):
    """A-Z index letter for a name; everything else (digits, symbols) is '#'."""
    for ch in unicodedata.normalize("NFKD", text or ""):
        if ch.isalnum():
            return ch.upper() if ch.isascii() and ch.isalpha() else "#"
    return "#"


def list_albums(query="", limit=60, offset=0, ipod_keys=None, sort="artist",
                status="all", letter="", artist="", genre=""):
    """Albums as tiles. `status`: all, new (something still to add) or on (anything on the
    iPod). `letter` filters by the first letter of the artist (sort=artist) or album."""
    ipod_keys = ipod_keys or set()
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    sort = sort if sort in SORTS else "artist"
    status = status if status in STATUSES else "all"
    letter = (letter or "").upper()[:1]
    where, args = "", []
    terms = [t for t in _norm(query).split(" ") if t]
    if terms:
        clauses = []
        for term in terms:
            clauses.append("lower(album || ' ' || artist || ' ' || COALESCE(albumartist,'') "
                           "|| ' ' || title) LIKE ?")
            args.append(f"%{term}%")
        where = "WHERE " + " AND ".join(clauses)
    conn = connect()
    try:
        _, album_genres = genre_maps(conn)
        rows = conn.execute(
            f"""SELECT album_key, MIN(album) AS album,
                       MIN(CASE WHEN albumartist != '' THEN albumartist END) AS albumartist,
                       MIN(artist) AS artist, MAX(compilation) AS compilation,
                       MAX(year) AS year, COUNT(*) AS tracks,
                       SUM(duration_ms) AS duration_ms, SUM(size) AS size,
                       MAX(mtime) AS added
                FROM tracks {where}
                GROUP BY album_key""", args).fetchall()
        on_ipod = {}
        if rows and ipod_keys:
            for r in conn.execute("SELECT album_key, key FROM tracks"):
                if r["key"] in ipod_keys:
                    on_ipod[r["album_key"]] = on_ipod.get(r["album_key"], 0) + 1
    finally:
        conn.close()

    albums = []
    for r in rows:
        shown = r["albumartist"] or ("Various Artists" if r["compilation"] else r["artist"])
        albums.append({
            "id": r["album_key"], "album": r["album"] or "", "artist": shown or "",
            "year": r["year"] or None, "tracks": r["tracks"],
            "duration_ms": r["duration_ms"] or 0, "size": r["size"] or 0,
            "on_ipod": on_ipod.get(r["album_key"], 0), "added": int(r["added"] or 0),
            "genre": album_genres.get(r["album_key"], genres.UNSORTED),
        })

    if genre:
        wanted = _norm(genre)
        albums = [a for a in albums if _norm(a["genre"]) == wanted]

    counts = {"all": len(albums),
              "new": sum(1 for a in albums if a["on_ipod"] < a["tracks"]),
              "on": sum(1 for a in albums if a["on_ipod"] > 0)}
    if status == "new":
        albums = [a for a in albums if a["on_ipod"] < a["tracks"]]
    elif status == "on":
        albums = [a for a in albums if a["on_ipod"] > 0]
    if artist:
        wanted = _norm(artist)
        albums = [a for a in albums if _norm(a["artist"]) == wanted]

    by_artist = lambda a: (_fold(a["artist"]), _fold(a["album"]))
    by_album = lambda a: (_fold(a["album"]), _fold(a["artist"]))
    if sort == "album":
        albums.sort(key=by_album)
    elif sort == "year":
        albums.sort(key=lambda a: (a["year"] is None, -(a["year"] or 0)) + by_artist(a))
    elif sort == "size":
        albums.sort(key=lambda a: (-a["size"],) + by_artist(a))
    elif sort == "recent":
        albums.sort(key=lambda a: (-a["added"],) + by_artist(a))
    else:
        albums.sort(key=by_artist)

    letters = []
    if sort in ("artist", "album"):
        field = "album" if sort == "album" else "artist"
        letters = sorted({letter_of(a[field]) for a in albums})
        if letter:
            albums = [a for a in albums if letter_of(a[field]) == letter]
    return {"total": len(albums), "albums": albums[offset:offset + limit],
            "counts": counts, "letters": letters}


def album_keys_for(track_keys):
    """Map track key -> album key for the tracks the library knows about."""
    if not track_keys:
        return {}
    conn = connect()
    try:
        return {r["key"]: r["album_key"] for r in conn.execute("SELECT key, album_key FROM tracks")
                if r["key"] in track_keys}
    finally:
        conn.close()


# ---------- genres ----------

_genre_cache = {"sig": None, "tracks": {}, "albums": {}}


def genre_maps(conn=None):
    """({track id: genre}, {album key: genre}). Tags are tidied into broad genres, and a
    song without a usable tag borrows the most common genre on its album."""
    own = conn is None
    conn = conn or connect()
    try:
        sig = tuple(conn.execute("SELECT COUNT(*), COALESCE(SUM(mtime),0), COALESCE(SUM(size),0) "
                                 "FROM tracks").fetchone())
        if _genre_cache["sig"] == sig:
            return _genre_cache["tracks"], _genre_cache["albums"]
        per_track, votes = {}, {}
        rows = conn.execute("SELECT id, album_key, genre FROM tracks").fetchall()
        for r in rows:
            name = genres.canonical(r["genre"])
            per_track[r["id"]] = (r["album_key"], name)
            if name:
                tally = votes.setdefault(r["album_key"], {})
                tally[name] = tally.get(name, 0) + 1
        albums = {key: max(sorted(tally), key=lambda g: tally[g]) for key, tally in votes.items()}
        tracks = {tid: (name or albums.get(akey) or genres.UNSORTED)
                  for tid, (akey, name) in per_track.items()}
        _genre_cache.update(sig=sig, tracks=tracks, albums=albums)
        return tracks, albums
    finally:
        if own:
            conn.close()


def list_genres():
    """Genre shelves with counts and a cover to show, biggest first, 'Unsorted' last."""
    conn = connect()
    try:
        by_track, by_album = genre_maps(conn)
        shelves = {}
        for r in conn.execute("SELECT id, album_key, size, duration_ms FROM tracks"):
            name = by_track.get(r["id"], genres.UNSORTED)
            g = shelves.setdefault(name, {"name": name, "tracks": 0, "size": 0, "duration_ms": 0,
                                          "albums": {}})
            g["tracks"] += 1
            g["size"] += r["size"] or 0
            g["duration_ms"] += r["duration_ms"] or 0
            g["albums"][r["album_key"]] = g["albums"].get(r["album_key"], 0) + 1
    finally:
        conn.close()
    out = []
    for g in shelves.values():
        albums = g.pop("albums")
        g["album_count"] = len(albums)
        g["covers"] = [k for k, _ in sorted(albums.items(), key=lambda kv: (-kv[1], kv[0]))[:4]]
        out.append(g)
    out.sort(key=lambda g: (g["name"] == genres.UNSORTED, -g["tracks"], g["name"].lower()))
    return out


TRACK_SORTS = ("artist", "title", "album", "recent", "length")


def list_tracks(query="", genre="", sort="artist", limit=200, offset=0):
    """Every song as a flat list (the Songs view and 'play everything')."""
    limit = max(1, min(int(limit), 5000))
    offset = max(0, int(offset))
    sort = sort if sort in TRACK_SORTS else "artist"
    where, args = "", []
    terms = [t for t in _norm(query).split(" ") if t]
    if terms:
        where = "WHERE " + " AND ".join(
            "lower(album || ' ' || artist || ' ' || title || ' ' || COALESCE(genre,'')) LIKE ?"
            for _ in terms)
        args = [f"%{t}%" for t in terms]
    conn = connect()
    try:
        by_track, _ = genre_maps(conn)
        rows = conn.execute(f"SELECT * FROM tracks {where}", args).fetchall()
    finally:
        conn.close()
    wanted = _norm(genre)
    items = []
    for r in rows:
        g = by_track.get(r["id"], genres.UNSORTED)
        if wanted and _norm(g) != wanted:
            continue
        items.append({
            "id": r["id"], "title": r["title"] or "", "artist": r["artist"] or "",
            "album": r["album"] or "", "album_key": r["album_key"], "genre": g,
            "track": r["track"] or 0, "disc": r["disc"] or 1, "year": r["year"] or None,
            "duration_ms": r["duration_ms"] or 0, "codec": r["codec"], "bitrate": r["bitrate"] or 0,
            "size": r["size"] or 0, "added": int(r["mtime"] or 0),
        })
    by_artist = lambda t: (_fold(t["artist"]), _fold(t["album"]), t["disc"], t["track"], _fold(t["title"]))
    if sort == "title":
        items.sort(key=lambda t: (_fold(t["title"]),) + by_artist(t))
    elif sort == "album":
        items.sort(key=lambda t: (_fold(t["album"]), t["disc"], t["track"], _fold(t["title"])))
    elif sort == "recent":
        items.sort(key=lambda t: (-t["added"],) + by_artist(t))
    elif sort == "length":
        items.sort(key=lambda t: (-t["duration_ms"],) + by_artist(t))
    else:
        items.sort(key=by_artist)
    return {"total": len(items), "tracks": items[offset:offset + limit]}


def album_tracks(key, ipod_keys=None):
    ipod_keys = ipod_keys or set()
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE album_key = ? ORDER BY disc, track, lower(title)",
            (key,)).fetchall()
        return [{
            "id": r["id"], "title": r["title"], "artist": r["artist"], "track": r["track"],
            "disc": r["disc"], "duration_ms": r["duration_ms"], "codec": r["codec"],
            "size": r["size"], "on_ipod": r["key"] in ipod_keys,
            "album": r["album"], "album_key": r["album_key"],
        } for r in rows]
    finally:
        conn.close()


def track_by_id(track_id):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (int(track_id),)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def tracks_by_ids(ids):
    if not ids:
        return []
    conn = connect()
    try:
        marks = ",".join("?" * len(ids))
        return [dict(r) for r in conn.execute(
            f"SELECT * FROM tracks WHERE id IN ({marks}) "
            f"ORDER BY album_key, disc, track", [int(i) for i in ids])]
    finally:
        conn.close()


def tracks_by_albums(keys):
    keys = [k for k in keys if ALBUM_KEY_RE.match(k)]
    if not keys:
        return []
    conn = connect()
    try:
        marks = ",".join("?" * len(keys))
        return [dict(r) for r in conn.execute(
            f"SELECT * FROM tracks WHERE album_key IN ({marks}) "
            f"ORDER BY album_key, disc, track", keys)]
    finally:
        conn.close()


def absolute_path(relpath):
    """Resolve a stored relative path, refusing anything outside the music folder."""
    root = os.path.realpath(config.MUSIC_DIR)
    path = os.path.realpath(os.path.join(root, relpath))
    if os.path.commonpath([root, path]) != root:
        raise ValueError("path escapes the music folder")
    return path


# ---------- cover art ----------

def _covers_dir():
    path = os.path.join(config.DATA_DIR, "covers")
    os.makedirs(path, exist_ok=True)
    return path


def _extract_embedded(src, dst):
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-an", "-frames:v", "1", "-vf", "scale=600:600:force_original_aspect_ratio=decrease",
           "-q:v", "3", dst]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def _shrink(src, dst):
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-frames:v", "1", "-vf", "scale=600:600:force_original_aspect_ratio=decrease",
           "-q:v", "3", dst]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def cover_path(key):
    """Path to a JPEG cover (max 600 px) for the album, or None. Cached on disk."""
    if not ALBUM_KEY_RE.match(key):
        return None
    cache = os.path.join(_covers_dir(), f"{key}.jpg")
    marker = os.path.join(_covers_dir(), f"{key}.none")
    if os.path.exists(cache):
        return cache
    if os.path.exists(marker):
        return None
    conn = connect()
    try:
        rows = conn.execute("SELECT relpath FROM tracks WHERE album_key = ? "
                            "ORDER BY disc, track LIMIT 3", (key,)).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            src = absolute_path(row["relpath"])
        except ValueError:
            continue
        if _extract_embedded(src, cache):
            return cache
        folder = os.path.dirname(src)
        try:
            names = os.listdir(folder)
        except OSError:
            names = []
        for name in sorted(names):
            stem, ext = os.path.splitext(name)
            if stem.lower() in COVER_NAMES and ext.lower() in COVER_EXTS:
                if _shrink(os.path.join(folder, name), cache):
                    return cache
    try:
        open(marker, "w").close()
    except OSError:
        pass
    return None
