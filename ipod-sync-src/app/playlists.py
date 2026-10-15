"""Playlists. A playlist is an ordered list of file paths, so it survives rescans and a
song that is briefly missing (an unplugged drive) simply waits in the list."""
import re
import time

from . import library

MAX_PLAYLISTS = 500
MAX_ITEMS = 20000


class PlaylistError(ValueError):
    pass


def _clean_name(name):
    name = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(name or ""))).strip()
    if not name:
        raise PlaylistError("Give the playlist a name.")
    return name[:80]


def _unique_name(conn, name, ignore_id=None):
    taken = {r["name"].lower() for r in conn.execute(
        "SELECT name FROM playlists WHERE id IS NOT ?", (ignore_id,))}
    if name.lower() not in taken:
        return name
    n = 2
    while f"{name} ({n})".lower() in taken:
        n += 1
    return f"{name} ({n})"


def _relpaths(conn, ids):
    """Library paths for song ids, in the order asked; unknown ids are skipped."""
    ids = [int(i) for i in ids][:MAX_ITEMS]
    found = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for r in conn.execute(f"SELECT id, relpath FROM tracks WHERE id IN ({marks})", chunk):
            found[r["id"]] = r["relpath"]
    return [found[i] for i in ids if i in found]


def _exists(conn, playlist_id):
    row = conn.execute("SELECT id FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
    if not row:
        raise LookupError("playlist not found")


def list_playlists():
    conn = library.connect()
    try:
        out = []
        rows = conn.execute(
            """SELECT p.id, p.name, p.updated, COUNT(i.relpath) AS entries, COUNT(t.id) AS found,
                      COALESCE(SUM(t.duration_ms), 0) AS ms
               FROM playlists p
               LEFT JOIN playlist_items i ON i.playlist_id = p.id
               LEFT JOIN tracks t ON t.relpath = i.relpath
               GROUP BY p.id ORDER BY p.name COLLATE NOCASE""").fetchall()
        for r in rows:
            covers = [c["album_key"] for c in conn.execute(
                """SELECT t.album_key FROM playlist_items i JOIN tracks t ON t.relpath = i.relpath
                   WHERE i.playlist_id = ? GROUP BY t.album_key ORDER BY MIN(i.pos) LIMIT 4""",
                (r["id"],))]
            out.append({"id": r["id"], "name": r["name"], "tracks": r["found"],
                        "missing": r["entries"] - r["found"], "duration_ms": r["ms"],
                        "updated": int(r["updated"] or 0), "covers": covers})
        return out
    finally:
        conn.close()


def get_playlist(playlist_id):
    conn = library.connect()
    try:
        row = conn.execute("SELECT id, name, updated FROM playlists WHERE id = ?",
                           (playlist_id,)).fetchone()
        if not row:
            raise LookupError("playlist not found")
        cols = ", ".join("t." + c.strip() for c in library._TRACK_COLUMNS.split(","))
        items, entries = [], 0
        for r in conn.execute(
                f"SELECT i.pos AS pos, i.relpath AS rel, {cols} FROM playlist_items i "
                f"LEFT JOIN tracks t ON t.relpath = i.relpath WHERE i.playlist_id = ? "
                f"ORDER BY i.pos", (playlist_id,)):
            entries += 1
            if r["id"] is None:
                continue
            item = library._track_item(r)
            item["pos"] = r["pos"]
            items.append(item)
        return {"id": row["id"], "name": row["name"], "updated": int(row["updated"] or 0),
                "tracks": items, "missing": entries - len(items),
                "duration_ms": sum(t["duration_ms"] for t in items)}
    finally:
        conn.close()


def create(name, track_ids=()):
    conn = library.connect()
    try:
        if conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] >= MAX_PLAYLISTS:
            raise PlaylistError("That is a lot of playlists. Delete some first.")
        name = _unique_name(conn, _clean_name(name))
        now = time.time()
        cur = conn.execute("INSERT INTO playlists(name, created, updated) VALUES(?,?,?)",
                           (name, now, now))
        pid = cur.lastrowid
        seen, rels = set(), []
        for rel in _relpaths(conn, track_ids):
            if rel not in seen:
                seen.add(rel)
                rels.append(rel)
        conn.executemany("INSERT INTO playlist_items VALUES (?,?,?)",
                         [(pid, n, rel) for n, rel in enumerate(rels)])
        conn.commit()
        return {"id": pid, "name": name, "added": len(rels)}
    finally:
        conn.close()


def rename(playlist_id, name):
    conn = library.connect()
    try:
        _exists(conn, playlist_id)
        name = _unique_name(conn, _clean_name(name), ignore_id=playlist_id)
        conn.execute("UPDATE playlists SET name = ?, updated = ? WHERE id = ?",
                     (name, time.time(), playlist_id))
        conn.commit()
        return {"id": playlist_id, "name": name}
    finally:
        conn.close()


def delete(playlist_id):
    conn = library.connect()
    try:
        _exists(conn, playlist_id)
        conn.execute("DELETE FROM playlist_items WHERE playlist_id = ?", (playlist_id,))
        conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        conn.commit()
    finally:
        conn.close()


def add_tracks(playlist_id, track_ids):
    """Append songs; ones already in the playlist are skipped."""
    conn = library.connect()
    try:
        _exists(conn, playlist_id)
        have = {r["relpath"] for r in conn.execute(
            "SELECT relpath FROM playlist_items WHERE playlist_id = ?", (playlist_id,))}
        last = conn.execute("SELECT COALESCE(MAX(pos), -1) FROM playlist_items WHERE playlist_id = ?",
                            (playlist_id,)).fetchone()[0]
        if len(have) >= MAX_ITEMS:
            raise PlaylistError("This playlist is full.")
        fresh, skipped = [], 0
        for rel in _relpaths(conn, track_ids):
            if rel in have:
                skipped += 1
                continue
            have.add(rel)
            fresh.append(rel)
        conn.executemany("INSERT INTO playlist_items VALUES (?,?,?)",
                         [(playlist_id, last + 1 + n, rel) for n, rel in enumerate(fresh)])
        conn.execute("UPDATE playlists SET updated = ? WHERE id = ?", (time.time(), playlist_id))
        conn.commit()
        return {"added": len(fresh), "skipped": skipped}
    finally:
        conn.close()


def arrange(playlist_id, order):
    """Reorder and remove: `order` lists the `pos` values to keep, in their new order."""
    conn = library.connect()
    try:
        _exists(conn, playlist_id)
        rels = {r["pos"]: r["relpath"] for r in conn.execute(
            "SELECT pos, relpath FROM playlist_items WHERE playlist_id = ?", (playlist_id,))}
        keep, used = [], set()
        for pos in order:
            pos = int(pos)
            if pos in rels and pos not in used:
                used.add(pos)
                keep.append(rels[pos])
        # Songs whose files aren't in the library right now (unplugged drive, folder not
        # chosen) are not shown by the screen, so they can't be in `order`: keep them, at the end.
        present = {r[0] for r in conn.execute(
            "SELECT relpath FROM tracks WHERE relpath IN (%s)" % ",".join("?" * len(rels)),
            list(rels.values()))} if rels else set()
        absent = [rel for pos, rel in sorted(rels.items()) if rel not in present and rel not in keep]
        keep.extend(absent)
        conn.execute("DELETE FROM playlist_items WHERE playlist_id = ?", (playlist_id,))
        conn.executemany("INSERT INTO playlist_items VALUES (?,?,?)",
                         [(playlist_id, n, rel) for n, rel in enumerate(keep)])
        conn.execute("UPDATE playlists SET updated = ? WHERE id = ?", (time.time(), playlist_id))
        conn.commit()
        return {"tracks": len(keep) - len(absent)}
    finally:
        conn.close()


def remap(mapping):
    """Songs were tidied away as duplicates: point playlist entries at the copy that stayed
    (or drop the entry when that copy is already in the playlist)."""
    if not mapping:
        return
    conn = library.connect()
    try:
        for old, new in mapping.items():
            for r in conn.execute("SELECT playlist_id, pos FROM playlist_items WHERE relpath = ?",
                                  (old,)).fetchall():
                has_new = conn.execute(
                    "SELECT 1 FROM playlist_items WHERE playlist_id = ? AND relpath = ?",
                    (r["playlist_id"], new)).fetchone()
                if has_new:
                    conn.execute("DELETE FROM playlist_items WHERE playlist_id = ? AND pos = ?",
                                 (r["playlist_id"], r["pos"]))
                else:
                    conn.execute("UPDATE playlist_items SET relpath = ? "
                                 "WHERE playlist_id = ? AND pos = ?", (new, r["playlist_id"], r["pos"]))
        conn.commit()
    finally:
        conn.close()
