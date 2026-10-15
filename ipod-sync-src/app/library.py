"""The music library on the Umbrel: scanning, search, albums and cover art.

The index lives in SQLite. Everything a list needs (folded sort keys, a search string, the
tidied genre) is stored on the row, and albums have a table of their own, so a page of songs
or albums is one indexed query rather than a trip through the whole library.
"""
import hashlib
import os
import re
import sqlite3
import subprocess
import threading
import time
import unicodedata

from . import audio, config, genres

LAYOUT = "2"            # relpaths are relative to MUSIC_DIR (the whole storage folder)
DERIVED_VERSION = "1"   # bump when the derived columns change

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
    key TEXT NOT NULL,
    genre_c TEXT, f_artist TEXT, f_album TEXT, f_title TEXT, search TEXT
);
CREATE TABLE IF NOT EXISTS albums (
    album_key TEXT PRIMARY KEY,
    album TEXT, artist TEXT, year INTEGER, tracks INTEGER, duration_ms INTEGER,
    size INTEGER, added REAL, genre TEXT,
    f_artist TEXT, f_album TEXT, l_artist TEXT, l_album TEXT, search TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, created REAL, updated REAL
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id INTEGER NOT NULL, pos INTEGER NOT NULL, relpath TEXT NOT NULL,
    PRIMARY KEY (playlist_id, pos)
);
CREATE INDEX IF NOT EXISTS idx_pi_rel ON playlist_items(relpath);
"""
DERIVED_COLUMNS = ("genre_c", "f_artist", "f_album", "f_title", "search")
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_key);
CREATE INDEX IF NOT EXISTS idx_tracks_key ON tracks(key);
CREATE INDEX IF NOT EXISTS idx_t_artist ON tracks(f_artist, f_album, disc, track, f_title, id);
CREATE INDEX IF NOT EXISTS idx_t_title ON tracks(f_title, f_artist, f_album, disc, track, id);
CREATE INDEX IF NOT EXISTS idx_t_album ON tracks(f_album, disc, track, f_title, id);
CREATE INDEX IF NOT EXISTS idx_t_recent ON tracks(mtime);
CREATE INDEX IF NOT EXISTS idx_t_length ON tracks(duration_ms);
CREATE INDEX IF NOT EXISTS idx_t_genre ON tracks(genre_c);
"""

ALBUM_KEY_RE = re.compile(r"^[0-9a-f]{12}$")
COVER_NAMES = ("cover", "folder", "front", "album", "albumart")
COVER_EXTS = (".jpg", ".jpeg", ".png")

_start_lock = threading.Lock()
_rescan = threading.Event()
scan_state = {"running": False, "scanned": 0, "total": 0, "added": 0, "removed": 0,
              "finished": None, "error": None, "missing_folders": []}

_schema_lock = threading.Lock()
_schema_ready = set()
_generation = 0
_cache_lock = threading.Lock()
_cache = {"gen": -1, "keymap": None, "genres": None}


def bump():
    """Something in the library changed: forget cached lists."""
    global _generation
    _generation += 1


def generation():
    return _generation


def _norm(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _fold(text):
    """Lower-case and accent-free, so "Émile" sorts and searches with the E's."""
    decomposed = unicodedata.normalize("NFKD", _norm(text))
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


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


def _derived(artist, album, albumartist, title, genre):
    return (_fold(artist), _fold(album), _fold(title),
            _fold(" ".join(x for x in (album, artist, albumartist, title, genre) if x)))


def _like(term):
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _terms(query):
    return [t for t in _fold(query).split(" ") if t]


def connect():
    os.makedirs(config.DATA_DIR, exist_ok=True)
    path = os.path.join(config.DATA_DIR, "library.db")
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    if path not in _schema_ready:
        with _schema_lock:
            if path not in _schema_ready:
                conn.execute("PRAGMA journal_mode=WAL")
                _ensure_schema(conn)
                _schema_ready.add(path)
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def _set_meta(conn, key, value):
    conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def _ensure_schema(conn):
    conn.executescript(SCHEMA)
    have = {r["name"] for r in conn.execute("PRAGMA table_info(tracks)")}
    for name in DERIVED_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE tracks ADD COLUMN {name} TEXT")
    conn.executescript(INDEXES)
    count = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    if _meta(conn, "layout") != LAYOUT:
        # An index made before uPod could browse the whole storage folder holds paths relative
        # to the Downloads folder: put the folder name back in front of them.
        if count and config.LEGACY_PREFIX:
            prefix = config.real_case(config.LEGACY_PREFIX)
            for table in ("tracks", "playlist_items"):
                conn.execute(f"UPDATE {table} SET relpath = ? || '/' || relpath", (prefix,))
        if not count or config.LEGACY_PREFIX:
            _set_meta(conn, "layout", LAYOUT)
            _set_meta(conn, "derived", "")
        # Otherwise leave the marker alone: an old index with no folder name to put back is
        # better migrated on a later start than quietly treated as up to date.
    version = f"{DERIVED_VERSION}:{genres.RULES_VERSION}"
    if _meta(conn, "derived") != version:
        _rederive_all(conn)
        refresh_derived(conn)
        _set_meta(conn, "derived", version)
    conn.commit()


def _rederive_all(conn):
    rows = conn.execute("SELECT id, artist, album, albumartist, title, genre FROM tracks").fetchall()
    conn.executemany(
        "UPDATE tracks SET f_artist=?, f_album=?, f_title=?, search=? WHERE id=?",
        [_derived(r["artist"], r["album"], r["albumartist"], r["title"], r["genre"]) + (r["id"],)
         for r in rows])


def refresh_derived(conn):
    """Tidy every song's genre (a song with no usable tag borrows its album's most common one)
    and rebuild the album table. Runs after a scan that changed something."""
    rows = conn.execute("SELECT id, album_key, genre, genre_c FROM tracks").fetchall()
    canon, votes, per = {}, {}, []
    for r in rows:
        raw = r["genre"]
        if raw not in canon:
            canon[raw] = genres.canonical(raw)
        name = canon[raw]
        per.append((r["id"], r["album_key"], name, r["genre_c"]))
        if name:
            tally = votes.setdefault(r["album_key"], {})
            tally[name] = tally.get(name, 0) + 1
    album_genre = {key: max(sorted(t), key=lambda g: t[g]) for key, t in votes.items()}
    conn.executemany("UPDATE tracks SET genre_c=? WHERE id=?",
                     [((name or album_genre.get(ak) or genres.UNSORTED), tid)
                      for tid, ak, name, old in per
                      if (name or album_genre.get(ak) or genres.UNSORTED) != old])
    conn.execute("DELETE FROM albums")
    out = []
    for r in conn.execute(
            """SELECT album_key, MIN(album) AS album,
                      MIN(CASE WHEN albumartist != '' THEN albumartist END) AS albumartist,
                      MIN(artist) AS artist, MAX(compilation) AS compilation,
                      MAX(year) AS year, COUNT(*) AS tracks,
                      SUM(duration_ms) AS duration_ms, SUM(size) AS size,
                      MAX(mtime) AS added, group_concat(search, ' ') AS search
               FROM tracks GROUP BY album_key"""):
        shown = r["albumartist"] or ("Various Artists" if r["compilation"] else r["artist"]) or ""
        album = r["album"] or ""
        out.append((r["album_key"], album, shown, r["year"], r["tracks"], r["duration_ms"] or 0,
                    r["size"] or 0, r["added"] or 0, album_genre.get(r["album_key"], genres.UNSORTED),
                    _fold(shown), _fold(album), letter_of(shown), letter_of(album), r["search"] or ""))
    conn.executemany("INSERT INTO albums VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", out)
    conn.commit()
    bump()


# ---------- scanning ----------

def _inside(root, path):
    return path == root or path.startswith(root + os.sep)


def _walk_audio(root):
    storage = config.storage_root()
    seen = {os.path.realpath(root)}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        keep = []
        for name in sorted(dirnames):
            if name.startswith("."):
                continue
            real = os.path.realpath(os.path.join(dirpath, name))
            # A shortcut to somewhere outside the storage folder cannot be read from in here,
            # and one that points back at a folder already walked would list it twice.
            if not _inside(storage, real) or real in seen:
                continue
            seen.add(real)
            keep.append(name)
        dirnames[:] = keep
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() not in audio.AUDIO_EXTENSIONS:
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                real = os.path.realpath(full)
                if not _inside(storage, real) or not os.path.isfile(real):
                    continue
            yield full


def scan():
    """Index the chosen music folders now. Returns False if a scan is already under way."""
    if not _claim_scan():
        return False
    return _scan_loop()


def _claim_scan():
    """Mark a scan as under way, so the app says "scanning" the moment it is asked to scan
    rather than a moment later when the thread gets going."""
    with _start_lock:
        if scan_state["running"]:
            return False
        scan_state.update(running=True, scanned=0, total=0, added=0, removed=0,
                          finished=None, error=None, missing_folders=[])
        return True


def _scan_loop():
    try:
        while True:
            _rescan.clear()
            _scan_once()
            # The folders were changed while this scan was reading the old ones: go again.
            if not _rescan.is_set():
                return True
    finally:
        scan_state["running"] = False


def fix_folder_case(conn):
    """Repair paths whose top folder is spelled differently on disk ('downloads/...' when the
    folder is really 'Downloads'): follow the folder instead of forgetting every song in it.
    Playlist entries follow too, so playlists survive."""
    root = config.storage_root()
    try:
        on_disk = {}
        for name in os.listdir(root):
            if os.path.isdir(os.path.join(root, name)):
                on_disk.setdefault(name.lower(), name)
    except OSError:
        return
    tops = set()
    for table in ("tracks", "playlist_items"):
        tops |= {r[0] for r in conn.execute(
            f"SELECT DISTINCT substr(relpath, 1, instr(relpath, '/') - 1) FROM {table} "
            f"WHERE instr(relpath, '/') > 0")}
    changed = False
    for top in tops:
        real = on_disk.get(top.lower()) if top else None
        if not real or real == top:
            continue
        for table in ("tracks", "playlist_items"):
            conn.execute(
                f"UPDATE OR IGNORE {table} SET relpath = ? || substr(relpath, ?) "
                f"WHERE substr(relpath, 1, ?) = ?",
                (real, len(top) + 1, len(top) + 1, top + "/"))
        changed = True
    if changed:
        conn.commit()


def _scan_once():
    try:
        scan_state.update(scanned=0, total=0, added=0, removed=0,
                          finished=None, error=None, missing_folders=[])
        storage = config.storage_root()
        if not os.path.isdir(storage):
            raise OSError(f"Music folder not found: {config.MUSIC_DIR}")
        folders, missing = config.music_folders(), []
        files = []
        for rel in folders:
            base = os.path.join(storage, rel) if rel else storage
            if os.path.isdir(base):
                files.extend(_walk_audio(base))
            else:
                missing.append(rel)
        scan_state["missing_folders"] = missing
        if missing and len(missing) == len(folders):
            raise OSError("None of your music folders can be found: " + ", ".join(missing))
        conn = connect()
        try:
            fix_folder_case(conn)
            known = {r["relpath"]: (r["mtime"], r["size"])
                     for r in conn.execute("SELECT relpath, mtime, size FROM tracks")}
            scan_state["total"] = len(files)
            seen = set()
            next_refresh = 400
            for path in files:
                rel = os.path.relpath(path, storage)
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
                f_artist, f_album, f_title, search = _derived(
                    meta["artist"], meta["album"], meta["albumartist"], meta["title"], meta["genre"])
                conn.execute(
                    """INSERT INTO tracks (relpath, mtime, size, title, artist, albumartist,
                         album, genre, composer, track, tracks, disc, discs, year, duration_ms,
                         bitrate, samplerate, bits, codec, compilation, album_key, key,
                         f_artist, f_album, f_title, search)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(relpath) DO UPDATE SET
                         mtime=excluded.mtime, size=excluded.size, title=excluded.title,
                         artist=excluded.artist, albumartist=excluded.albumartist,
                         album=excluded.album, genre=excluded.genre, composer=excluded.composer,
                         track=excluded.track, tracks=excluded.tracks, disc=excluded.disc,
                         discs=excluded.discs, year=excluded.year,
                         duration_ms=excluded.duration_ms, bitrate=excluded.bitrate,
                         samplerate=excluded.samplerate, bits=excluded.bits,
                         codec=excluded.codec, compilation=excluded.compilation,
                         album_key=excluded.album_key, key=excluded.key,
                         f_artist=excluded.f_artist, f_album=excluded.f_album,
                         f_title=excluded.f_title, search=excluded.search""",
                    (rel, st.st_mtime, st.st_size, meta["title"], meta["artist"],
                     meta["albumartist"], meta["album"], meta["genre"], meta["composer"],
                     meta["track"], meta["tracks"], meta["disc"], meta["discs"], meta["year"],
                     meta["duration_ms"], meta["bitrate"], meta["samplerate"], meta["bits"],
                     meta["codec"], meta["compilation"],
                     album_key(aa, meta["album"]),
                     track_key(meta["artist"], meta["album"], meta["title"], meta["track"]),
                     f_artist, f_album, f_title, search))
                scan_state["added"] += 1
                if scan_state["added"] % 200 == 0:
                    conn.commit()
                if scan_state["added"] >= next_refresh:
                    # Show what has been found so far (400, 1200, 3600... songs), so a first
                    # scan of a big library fills the screen as it goes.
                    refresh_derived(conn)
                    next_refresh *= 3
            live = [f for f in folders if f not in missing]
            def _in_live(rel):
                return any(f == "" or rel == f or rel.startswith(f + "/") for f in live)
            if not files and any(_in_live(rel) for rel in known):
                raise OSError("No songs were found in your music folders, so your library was left "
                              "as it was. Is the drive connected?")
            holes = tuple(m + "/" if m else "" for m in missing)
            gone = [rel for rel in known if rel not in seen
                    and not (holes and rel.startswith(holes))]
            for rel in gone:
                conn.execute("DELETE FROM tracks WHERE relpath = ?", (rel,))
            scan_state["removed"] = len(gone)
            conn.commit()
            if scan_state["added"] or gone:
                refresh_derived(conn)
        finally:
            conn.close()
        scan_state["finished"] = time.time()
        start_cover_prefetch()
    except Exception as exc:  # reported to the UI
        scan_state["error"] = str(exc)


def start_scan():
    _rescan.set()
    if not _claim_scan():
        return False      # the scan already running will go round again for the new folders
    threading.Thread(target=_scan_loop, name="library-scan", daemon=True).start()
    return True


# ---------- queries ----------

def summary():
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS tracks, COALESCE(SUM(size),0) AS bytes FROM tracks").fetchone()
        albums = conn.execute("SELECT COUNT(*) FROM albums").fetchone()[0]
        return {"tracks": row["tracks"], "albums": albums, "bytes": row["bytes"],
                "scan": dict(scan_state), "generation": _generation,
                "music_dir_exists": any(
                    os.path.isdir(os.path.join(config.storage_root(), f))
                    for f in config.music_folders())}
    finally:
        conn.close()


SORTS = ("artist", "album", "year", "size", "recent")
STATUSES = ("all", "new", "on")


def letter_of(text):
    """A-Z index letter for a name; everything else (digits, symbols) is '#'."""
    for ch in unicodedata.normalize("NFKD", text or ""):
        if ch.isalnum():
            return ch.upper() if ch.isascii() and ch.isalpha() else "#"
    return "#"


def _key_map(conn=None):
    """{track key: album key}, cached until the library changes."""
    with _cache_lock:
        if _cache["gen"] == _generation and _cache["keymap"] is not None:
            return _cache["keymap"]
        gen = _generation
    own = conn is None
    conn = conn or connect()
    try:
        keymap = {r["key"]: r["album_key"] for r in conn.execute("SELECT key, album_key FROM tracks")}
    finally:
        if own:
            conn.close()
    with _cache_lock:
        if _cache["gen"] != gen:
            _cache.update(gen=gen, keymap=keymap, genres=None)
        else:
            _cache["keymap"] = keymap
    return keymap


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
    clauses, args = [], []
    for term in _terms(query):
        clauses.append("search LIKE ? ESCAPE '\\'")
        args.append(_like(term))
    if genre:
        clauses.append("genre = ? COLLATE NOCASE")
        args.append(genre.strip())
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    conn = connect()
    try:
        rows = conn.execute(f"SELECT * FROM albums {where}", args).fetchall()
        keymap = _key_map(conn) if (rows and ipod_keys) else {}
    finally:
        conn.close()
    on_ipod = {}
    for k in ipod_keys:
        ak = keymap.get(k)
        if ak:
            on_ipod[ak] = on_ipod.get(ak, 0) + 1

    albums = []
    for r in rows:
        albums.append({
            "id": r["album_key"], "album": r["album"] or "", "artist": r["artist"] or "",
            "year": r["year"] or None, "tracks": r["tracks"],
            "duration_ms": r["duration_ms"] or 0, "size": r["size"] or 0,
            "on_ipod": on_ipod.get(r["album_key"], 0), "added": int(r["added"] or 0),
            "genre": r["genre"] or genres.UNSORTED,
            "_fa": r["f_artist"], "_fb": r["f_album"], "_la": r["l_artist"], "_lb": r["l_album"],
        })

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

    by_artist = lambda a: (a["_fa"], a["_fb"])
    by_album = lambda a: (a["_fb"], a["_fa"])
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
        field = "_lb" if sort == "album" else "_la"
        letters = sorted({a[field] for a in albums})
        if letter:
            albums = [a for a in albums if a[field] == letter]
    page = albums[offset:offset + limit]
    for a in page:
        for k in ("_fa", "_fb", "_la", "_lb"):
            a.pop(k, None)
    return {"total": len(albums), "albums": page, "counts": counts, "letters": letters}


def album_keys_for(track_keys):
    """Map track key -> album key for the tracks the library knows about."""
    if not track_keys:
        return {}
    keymap = _key_map()
    return {k: keymap[k] for k in track_keys if k in keymap}


# ---------- genres ----------

def list_genres():
    """Genre shelves with counts and covers to show, biggest first, 'Unsorted' last."""
    with _cache_lock:
        if _cache["gen"] == _generation and _cache["genres"] is not None:
            return [dict(g, covers=list(g["covers"])) for g in _cache["genres"]]
        gen = _generation
    conn = connect()
    try:
        shelves = {r["g"]: {"name": r["g"], "tracks": r["n"], "size": r["bytes"] or 0,
                            "duration_ms": r["ms"] or 0, "albums": {}}
                   for r in conn.execute(
                       "SELECT COALESCE(genre_c, ?) AS g, COUNT(*) AS n, SUM(size) AS bytes, "
                       "SUM(duration_ms) AS ms FROM tracks GROUP BY g", (genres.UNSORTED,))}
        for r in conn.execute("SELECT COALESCE(genre_c, ?) AS g, album_key, COUNT(*) AS n "
                              "FROM tracks GROUP BY g, album_key", (genres.UNSORTED,)):
            shelves[r["g"]]["albums"][r["album_key"]] = r["n"]
    finally:
        conn.close()
    out = []
    for g in shelves.values():
        albums = g.pop("albums")
        g["album_count"] = len(albums)
        g["covers"] = [k for k, _ in sorted(albums.items(), key=lambda kv: (-kv[1], kv[0]))[:4]]
        out.append(g)
    out.sort(key=lambda g: (g["name"] == genres.UNSORTED, -g["tracks"], g["name"].lower()))
    with _cache_lock:
        if _cache["gen"] != gen:
            _cache.update(gen=gen, keymap=None)
        _cache["genres"] = out
    return [dict(g, covers=list(g["covers"])) for g in out]


TRACK_SORTS = ("artist", "title", "album", "recent", "length")
_TRACK_ORDER = {
    "artist": "f_artist, f_album, disc, track, f_title, id",
    "title": "f_title, f_artist, f_album, disc, track, id",
    "album": "f_album, disc, track, f_title, id",
    "recent": "mtime DESC, f_artist, f_album, disc, track, f_title, id",
    "length": "duration_ms DESC, f_artist, f_album, disc, track, f_title, id",
}


def _track_item(r):
    return {
        "id": r["id"], "title": r["title"] or "", "artist": r["artist"] or "",
        "album": r["album"] or "", "album_key": r["album_key"],
        "genre": r["genre_c"] or genres.UNSORTED,
        "track": r["track"] or 0, "disc": r["disc"] or 1, "year": r["year"] or None,
        "duration_ms": r["duration_ms"] or 0, "codec": r["codec"], "bitrate": r["bitrate"] or 0,
        "size": r["size"] or 0, "added": int(r["mtime"] or 0),
    }


_TRACK_COLUMNS = ("id, title, artist, album, album_key, genre_c, track, disc, year, duration_ms, "
                  "codec, bitrate, size, mtime")


def list_tracks(query="", genre="", sort="artist", limit=200, offset=0):
    """Every song as a flat list (the Songs view and 'play everything'): one page, sorted and
    filtered by the database."""
    limit = max(1, min(int(limit), 5000))
    offset = max(0, int(offset))
    sort = sort if sort in TRACK_SORTS else "artist"
    clauses, args = [], []
    for term in _terms(query):
        clauses.append("search LIKE ? ESCAPE '\\'")
        args.append(_like(term))
    if genre:
        clauses.append("genre_c = ? COLLATE NOCASE")
        args.append(genre.strip())
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    conn = connect()
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM tracks {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT {_TRACK_COLUMNS} FROM tracks {where} ORDER BY {_TRACK_ORDER[sort]} "
            f"LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    finally:
        conn.close()
    return {"total": total, "tracks": [_track_item(r) for r in rows]}


def tracks_for_ids(ids):
    """Song items for the given ids, in the order asked (unknown ids are skipped)."""
    ids = [int(i) for i in ids]
    if not ids:
        return []
    conn = connect()
    try:
        found = {}
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            marks = ",".join("?" * len(chunk))
            for r in conn.execute(f"SELECT {_TRACK_COLUMNS} FROM tracks WHERE id IN ({marks})", chunk):
                found[r["id"]] = _track_item(r)
    finally:
        conn.close()
    return [found[i] for i in ids if i in found]


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


# ---------- folder browser (Settings) ----------

def browse_folders(rel=""):
    """The sub-folders of a folder inside the storage root, for the folder picker."""
    rel = config.normalize_folder(rel)
    root = config.storage_root()
    base = os.path.join(root, rel) if rel else root
    chosen = config.music_folders()

    def covered(path):
        return any(c == "" or path == c or path.startswith(c + "/") for c in chosen)

    def has_audio(folder):
        try:
            with os.scandir(folder) as it:
                return any(e.is_file() and os.path.splitext(e.name)[1].lower() in audio.AUDIO_EXTENSIONS
                           for e in it)
        except OSError:
            return False

    folders = []
    try:
        entries = sorted((e for e in os.scandir(base) if not e.name.startswith(".")),
                         key=lambda e: e.name.lower())
    except OSError as exc:
        raise ValueError(f"Can't open that folder: {exc.strerror or exc}")
    for e in entries:
        try:
            if not e.is_dir():
                continue
            real = os.path.realpath(e.path)
            if os.path.commonpath([root, real]) != root:
                continue
        except (OSError, ValueError):
            continue
        child = f"{rel}/{e.name}" if rel else e.name
        folders.append({"name": e.name, "path": child, "selected": child in chosen,
                        "covered": covered(child),
                        "music": has_audio(e.path) if len(folders) < 300 else False})
    parent = None if not rel else rel.rsplit("/", 1)[0] if "/" in rel else ""
    return {"path": rel, "name": rel.rsplit("/", 1)[-1] if rel else "Your Umbrel", "parent": parent,
            "folders": folders, "music_here": has_audio(base), "covered": covered(rel)}


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


_cover_slots = threading.BoundedSemaphore(3)   # ffmpeg jobs at once, so web threads stay free
_prefetch_lock = threading.Lock()


def _build_cover(key, cache):
    conn = connect()
    try:
        rows = conn.execute("SELECT relpath FROM tracks WHERE album_key = ? "
                            "ORDER BY disc, track LIMIT 3", (key,)).fetchall()
    finally:
        conn.close()
    tmp = f"{cache[:-4]}.{os.getpid()}.{threading.get_ident()}.part.jpg"
    try:
        for row in rows:
            try:
                src = absolute_path(row["relpath"])
            except ValueError:
                continue
            if _extract_embedded(src, tmp):
                os.replace(tmp, cache)
                return True
            folder = os.path.dirname(src)
            try:
                names = os.listdir(folder)
            except OSError:
                names = []
            for name in sorted(names):
                stem, ext = os.path.splitext(name)
                if stem.lower() in COVER_NAMES and ext.lower() in COVER_EXTS:
                    if _shrink(os.path.join(folder, name), tmp):
                        os.replace(tmp, cache)
                        return True
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return False


def cover_path(key):
    """Path to a JPEG cover (max 600 px) for the album, or None. Cached on disk."""
    if not ALBUM_KEY_RE.match(key):
        return None
    cache = os.path.join(_covers_dir(), f"{key}.jpg")
    marker = os.path.join(_covers_dir(), f"{key}.none")
    if os.path.exists(cache):
        return cache
    try:
        if time.time() - os.path.getmtime(marker) < 6 * 3600:
            return None
    except OSError:
        pass
    conn = connect()
    try:
        known = conn.execute("SELECT 1 FROM albums WHERE album_key = ?", (key,)).fetchone()
    finally:
        conn.close()
    if not known:
        return None
    with _cover_slots:
        if os.path.exists(cache):
            return cache
        if _build_cover(key, cache):
            return cache
    try:
        open(marker, "w").close()
    except OSError:
        pass
    return None


def _prefetch_covers():
    try:
        conn = connect()
        try:
            keys = [r["album_key"] for r in conn.execute("SELECT album_key FROM albums")]
        finally:
            conn.close()
        for key in keys:
            cover_path(key)
            time.sleep(0.02)
    except Exception:   # a convenience: the folder may vanish mid-way (unplugged drive)
        pass
    finally:
        _prefetch_lock.release()


def start_cover_prefetch():
    """Make every album's cover in the background so browsing never waits for ffmpeg."""
    if _prefetch_lock.acquire(blocking=False):
        threading.Thread(target=_prefetch_covers, name="cover-prefetch", daemon=True).start()
