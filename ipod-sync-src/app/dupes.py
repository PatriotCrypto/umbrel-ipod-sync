"""Find songs that are in the library more than once, and tidy them away.

Two files are the same song when the title and the artist are the same once case,
accents, punctuation and spacing are ignored ("Don't Stop" == "dont stop"). Different
versions ("Song (Live)", "Song (Remix)") have different titles, so they are left alone.

Nothing is deleted outright: "deleting" moves a file into a hidden `.ipod-trash`
folder inside the music folder, from where it can be put back or emptied for good.
"""
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
        rows = [dict(r) for r in conn.execute("SELECT * FROM tracks")]
    finally:
        conn.close()
    buckets = {}
    for r in rows:
        title, artist = _dkey(r["title"]), _dkey(r["artist"])
        if not title or artist in SKIP_ARTISTS:
            continue
        buckets.setdefault((title, artist), []).append(r)
    groups = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda r: (tuple(-v for v in _quality(r)), r["relpath"].lower()))
        groups.append(members)
    groups.sort(key=lambda g: (_dkey(g[0]["artist"]), _dkey(g[0]["title"])))
    return groups


def _item(row, keep):
    return {"id": row["id"], "album": row["album"] or "", "album_key": row["album_key"],
            "path": row["relpath"], "codec": row["codec"], "bitrate": row["bitrate"] or 0,
            "duration_ms": row["duration_ms"] or 0, "size": row["size"] or 0, "keep": keep}


def _trash_root():
    return os.path.join(os.path.realpath(config.MUSIC_DIR), TRASH_NAME)


def _writable():
    return os.access(config.MUSIC_DIR, os.W_OK)


def trash_info():
    files = size = 0
    for dirpath, _, names in os.walk(_trash_root()):
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
    victims = []
    for members in find_groups():
        chosen = [m for m in members if m["id"] in wanted]
        if len(chosen) == len(members):
            chosen = chosen[1:]          # members are best-first: spare the best copy
        victims.extend(chosen)
    if not victims:
        return {"moved": 0, "bytes": 0, "failed": []}

    root = os.path.realpath(config.MUSIC_DIR)
    stamp = os.path.join(_trash_root(), time.strftime("%Y%m%d-%H%M%S"))
    moved, total, failed, gone = 0, 0, [], []
    for row in victims:
        try:
            src = library.absolute_path(row["relpath"])
            dst = os.path.join(stamp, row["relpath"])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
        except (OSError, ValueError) as exc:
            failed.append(f"{row['relpath']}: {exc}")
            continue
        moved += 1
        total += row["size"] or 0
        gone.append(row["id"])
        _prune_empty(src, root)
    if gone:
        conn = library.connect()
        try:
            conn.executemany("DELETE FROM tracks WHERE id = ?", [(i,) for i in gone])
            conn.commit()
        finally:
            conn.close()
    return {"moved": moved, "bytes": total, "failed": failed}


def restore_trash():
    root = os.path.realpath(config.MUSIC_DIR)
    trash = _trash_root()
    restored, kept = 0, 0
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
    shutil.rmtree(_trash_root(), ignore_errors=True)
    return info
