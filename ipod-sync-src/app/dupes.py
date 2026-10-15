"""Find songs that are in the library more than once, and tidy them away.

Two files are the same song when the title and the artist are the same once case,
accents, punctuation and spacing are ignored ("Don't Stop" == "dont stop"). Different
versions ("Song (Live)", "Song (Remix)") have different titles, so they are left alone.

Nothing is deleted outright: "deleting" moves a file into a hidden `.ipod-trash`
folder inside the music folder the file came from, from where it can be put back or emptied
for good.
"""
import json
import os
import re
import shutil
import time
import unicodedata

from . import config, library

TRASH_NAME = ".ipod-trash"
LOSSLESS = {"flac", "alac", "wav", "aiff"}
SKIP_ARTISTS = {"", "unknownartist", "variousartists"}


class DupeError(Exception):
    pass


def _dkey(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9]+", "", text.replace("&", "and"))


def _quality(row):
    return (1 if row["codec"] in LOSSLESS else 0, row["bitrate"] or 0, row["bits"] or 0,
            row["samplerate"] or 0, row["size"] or 0)


def find_groups():
    conn = library.connect()
    try:
        rows = conn.execute(
            "SELECT id, relpath, title, artist, album, album_key, codec, bitrate, bits, "
            "samplerate, size, duration_ms FROM tracks").fetchall()
    finally:
        conn.close()
    buckets = {}
    for r in rows:
        title, artist = _dkey(r["title"]), _dkey(r["artist"])
        if not title or artist in SKIP_ARTISTS:
            continue
        buckets.setdefault((title, artist), []).append(r)
    # Same title and artist AND about the same length: a 30 s "Intro" on one album and a 2 s
    # "Intro" on another are different songs.
    clusters = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        members = sorted(members, key=lambda r: r["duration_ms"] or 0)
        run = [members[0]]
        for m in members[1:]:
            if (m["duration_ms"] or 0) - (run[-1]["duration_ms"] or 0) <= 3000:
                run.append(m)
            else:
                clusters.append(run)
                run = [m]
        clusters.append(run)
    groups = []
    for members in clusters:
        if len(members) < 2:
            continue
        members = [dict(m) for m in members]
        members.sort(key=lambda r: (tuple(-v for v in _quality(r)), r["relpath"].lower()))
        groups.append(members)
    groups.sort(key=lambda g: (_dkey(g[0]["artist"]), _dkey(g[0]["title"])))
    return groups


def _item(row, keep):
    return {"id": row["id"], "album": row["album"] or "", "album_key": row["album_key"],
            "path": row["relpath"], "codec": row["codec"], "bitrate": row["bitrate"] or 0,
            "duration_ms": row["duration_ms"] or 0, "size": row["size"] or 0, "keep": keep}


def _abs(folder):
    root = config.storage_root()
    return os.path.join(root, folder) if folder else root


def _trash_root(folder):
    return os.path.join(_abs(folder), TRASH_NAME)


def _folder_of(rel):
    """The chosen music folder a library path lives in (the deepest match), or None."""
    best = None
    for f in config.music_folders():
        if f == "" or rel == f or rel.startswith(f + "/"):
            if best is None or len(f) > len(best):
                best = f
    return best


def _remembered_path():
    return os.path.join(config.DATA_DIR, "trash_folders.json")


def _trash_folders():
    """Chosen folders plus any folder that once received trash (so it can still be restored
    after the folder list changes)."""
    out = list(config.music_folders())
    try:
        with open(_remembered_path(), "r", encoding="utf-8") as fh:
            for f in json.load(fh):
                if isinstance(f, str) and f not in out and os.path.isdir(_trash_root(f)):
                    out.append(f)
    except (OSError, ValueError):
        pass
    return out


def _remember(folder):
    try:
        have = []
        try:
            with open(_remembered_path(), "r", encoding="utf-8") as fh:
                have = [f for f in json.load(fh) if isinstance(f, str)]
        except (OSError, ValueError):
            pass
        if folder not in have:
            os.makedirs(config.DATA_DIR, exist_ok=True)
            with open(_remembered_path(), "w", encoding="utf-8") as fh:
                json.dump(have + [folder], fh)
    except OSError:
        pass


def _writable(folder=None):
    folders = config.music_folders() if folder is None else [folder]
    return any(os.access(_abs(f), os.W_OK) for f in folders)


def trash_info():
    files = size = 0
    for folder in _trash_folders():
        for dirpath, _, names in os.walk(_trash_root(folder)):
            for name in names:
                files += 1
                try:
                    size += os.path.getsize(os.path.join(dirpath, name))
                except OSError:
                    pass
    return {"files": files, "bytes": size}


def scan_duplicates():
    groups = find_groups()
    out, extra_files, extra_bytes = [], 0, 0
    for members in groups:
        first = members[0]
        out.append({"title": first["title"], "artist": first["artist"],
                    "items": [_item(m, i == 0) for i, m in enumerate(members)]})
        for m in members[1:]:
            extra_files += 1
            extra_bytes += m["size"] or 0
    return {"groups": out, "files": extra_files, "bytes": extra_bytes,
            "can_delete": _writable(), "trash": trash_info()}


def _prune_empty(path, stop):
    path = os.path.dirname(path)
    stop = os.path.realpath(stop)
    while os.path.realpath(path).startswith(stop + os.sep):
        try:
            os.rmdir(path)
        except OSError:
            break
        path = os.path.dirname(path)


def trash_duplicates(ids):
    """Move the chosen copies to the trash. At least one copy of every song always stays:
    if every copy of a song is chosen, the best-quality one is kept."""
    if not _writable():
        raise DupeError("The music folder is read-only, so duplicates can't be removed. "
                        "Update the app to its latest version and try again.")
    wanted = {int(i) for i in ids}
    victims, replacement = [], {}
    for members in find_groups():
        chosen = [m for m in members if m["id"] in wanted]
        if len(chosen) == len(members):
            chosen = chosen[1:]          # members are best-first: spare the best copy
        survivor = next((m for m in members if m not in chosen), members[0])
        for m in chosen:
            replacement[m["relpath"]] = survivor["relpath"]
        victims.extend(chosen)
    if not victims:
        return {"moved": 0, "bytes": 0, "failed": []}

    stamp_name = time.strftime("%Y%m%d-%H%M%S")
    moved, total, failed, gone, done = 0, 0, [], [], {}
    for row in victims:
        rel = row["relpath"]
        folder = _folder_of(rel)
        try:
            if folder is None:
                raise OSError("not inside a chosen music folder")
            if not _writable(folder):
                raise OSError("that folder is read-only")
            inside = rel[len(folder) + 1:] if folder else rel
            src = os.path.join(_abs(folder), inside)
            if os.path.islink(src) or not os.path.isfile(src):
                raise OSError("not a regular file")
            dst = os.path.join(_trash_root(folder), stamp_name, inside)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            _remember(folder)
        except (OSError, ValueError) as exc:
            failed.append(f"{rel}: {exc}")
            continue
        moved += 1
        total += row["size"] or 0
        gone.append(row["id"])
        done[rel] = replacement[rel]
        _prune_empty(src, _abs(folder))
    if gone:
        conn = library.connect()
        try:
            conn.executemany("DELETE FROM tracks WHERE id = ?", [(i,) for i in gone])
            library.refresh_derived(conn)
        finally:
            conn.close()
        try:
            from . import playlists
            playlists.remap(done)
        except Exception:   # playlists are a convenience; never block tidying
            pass
    return {"moved": moved, "bytes": total, "failed": failed}


def restore_trash():
    restored, kept = 0, 0
    for folder in _trash_folders():
        trash, root = _trash_root(folder), _abs(folder)
        for stamp in sorted(os.listdir(trash)) if os.path.isdir(trash) else []:
            base = os.path.join(trash, stamp)
            for dirpath, _, names in os.walk(base):
                for name in names:
                    src = os.path.join(dirpath, name)
                    dst = os.path.join(root, os.path.relpath(src, base))
                    if os.path.exists(dst):
                        kept += 1
                        continue
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(src, dst)
                    restored += 1
                    _prune_empty(src, trash)
    return {"restored": restored, "left_in_trash": kept}


def empty_trash():
    info = trash_info()
    for folder in _trash_folders():
        shutil.rmtree(_trash_root(folder), ignore_errors=True)
    return info
