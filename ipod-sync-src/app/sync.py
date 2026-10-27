"""Planning a sync and running it against the iPod."""
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

from . import audio, config, ipod, library

BACKUP_SUBDIRS = ("iTunes", "Device", "Artwork")
BACKUP_MAX_BYTES = 400 * 1024 * 1024
STAMP_RE = re.compile(r"^\d{8}-\d{6}$")
GUID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")


def escape(text):
    return (str(text if text is not None else "")
            .replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", ""))


# ---------- planning ----------

def _meta_from_row(row):
    return {"codec": row["codec"], "samplerate": row["samplerate"] or 0,
            "bitrate": row["bitrate"] or 0, "bits": row["bits"] or 0,
            "duration_ms": row["duration_ms"] or 0}


def build_plan(album_ids, track_ids, remove_ids, settings=None):
    settings = settings or config.load_settings()
    ipod_tracks = ipod.current_tracks()
    on_ipod = {t["key"] for t in ipod_tracks}
    by_id = {t["id"]: t for t in ipod_tracks}

    candidates, seen_ids = [], set()
    for row in library.tracks_by_albums(album_ids or []) + library.tracks_by_ids(track_ids or []):
        if row["id"] not in seen_ids:
            seen_ids.add(row["id"])
            candidates.append(row)

    to_add, skipped, already, seen_keys = [], [], 0, set()
    converting = 0
    add_bytes = 0
    for row in candidates:
        if row["key"] in on_ipod or row["key"] in seen_keys:
            already += 1
            continue
        seen_keys.add(row["key"])
        meta = _meta_from_row(row)
        action, reason = audio.plan_conversion(meta, settings)
        if action == "skip":
            skipped.append({"id": row["id"], "title": row["title"], "reason": reason})
            continue
        size = audio.estimated_size(meta, action, settings, row["size"])
        if action == "convert":
            converting += 1
        add_bytes += size
        to_add.append({"id": row["id"], "title": row["title"], "artist": row["artist"],
                       "action": action, "reason": reason, "size": size})

    remove = [i for i in (remove_ids or []) if i in by_id]
    remove_bytes = sum(by_id[i]["size"] for i in remove)

    free = 0
    try:
        free = shutil.disk_usage(ipod.mount_path()).free
    except OSError:
        pass
    net = add_bytes - remove_bytes
    return {
        "add": to_add, "skipped": skipped, "remove": remove,
        "counts": {"add": len(to_add), "convert": converting, "skipped": len(skipped),
                   "already_on_ipod": already, "remove": len(remove)},
        "bytes": {"add": add_bytes, "remove": remove_bytes, "net": net, "free": free},
        "fits": net <= free - config.FREE_SPACE_RESERVE,
    }


def fit_selection(album_ids, track_ids, settings=None):
    """Trim a selection so it fits in the iPod's free space: albums first, in the order given,
    then single songs. An album that does not fit is skipped and later, smaller ones may still
    go in. Things already on the iPod take no room, so they stay."""
    settings = settings or config.load_settings()
    free = 0
    try:
        free = shutil.disk_usage(ipod.mount_path()).free
    except OSError:
        pass
    room = max(0, free - config.FREE_SPACE_RESERVE)
    used = 0
    kept_albums, kept_tracks, dropped = [], [], 0
    for album_id in album_ids or []:
        add = build_plan([album_id], [], [], settings)["bytes"]["add"]
        if used + add <= room:
            used += add
            kept_albums.append(album_id)
        else:
            dropped += 1
    for track_id in track_ids or []:
        add = build_plan([], [track_id], [], settings)["bytes"]["add"]
        if used + add <= room:
            used += add
            kept_tracks.append(track_id)
        else:
            dropped += 1
    return {"albums": kept_albums, "tracks": kept_tracks, "dropped": dropped, "bytes": used}


# ---------- backups ----------

def _dir_size(path):
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


def _backup_root(guid):
    guid = guid if GUID_RE.match(guid or "") else "ipod"
    return os.path.join(config.DATA_DIR, "backups", guid)


def backup_ipod(guid, keep):
    """Copy the iPod's database folders aside. Returns (stamp, warnings)."""
    root = _backup_root(guid)
    moment = time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(moment))
    while os.path.exists(os.path.join(root, stamp)):  # two syncs in one second
        moment += 1
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(moment))
    dest = os.path.join(root, stamp)
    control = os.path.join(ipod.mount_path(), "iPod_Control")
    warnings = []
    os.makedirs(dest, exist_ok=True)
    for sub in BACKUP_SUBDIRS:
        src = os.path.join(control, sub)
        if not os.path.isdir(src):
            continue
        if sub == "Artwork" and _dir_size(src) > BACKUP_MAX_BYTES:
            warnings.append("Artwork was too large to include in the backup.")
            continue
        shutil.copytree(src, os.path.join(dest, sub))
    stamps = sorted(d for d in os.listdir(root) if STAMP_RE.match(d))
    for old in stamps[:-max(1, keep)]:
        shutil.rmtree(os.path.join(root, old), ignore_errors=True)
    return stamp, warnings


def list_backups(guid):
    root = _backup_root(guid)
    if not os.path.isdir(root):
        return []
    out = []
    for stamp in sorted((d for d in os.listdir(root) if STAMP_RE.match(d)), reverse=True):
        path = os.path.join(root, stamp)
        out.append({"id": stamp, "size": _dir_size(path),
                    "taken": time.mktime(time.strptime(stamp, "%Y%m%d-%H%M%S"))})
    return out


def restore_backup(guid, stamp):
    if not STAMP_RE.match(stamp or ""):
        raise ValueError("invalid backup id")
    src_root = os.path.join(_backup_root(guid), stamp)
    if not os.path.isdir(src_root):
        raise ValueError("that backup no longer exists")
    if current_job() and current_job()["state"] == "running":
        raise ipod.IpodError("A sync is running. Wait for it to finish first.")
    control = os.path.join(ipod.mount_path(), "iPod_Control")
    for sub in BACKUP_SUBDIRS:
        saved = os.path.join(src_root, sub)
        if not os.path.isdir(saved):
            continue
        target = os.path.join(control, sub)
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(saved, target)
    subprocess.run(["sync"], timeout=120)
    ipod.invalidate_tracks()


# ---------- running a sync ----------

_job_lock = threading.Lock()
_job = {"current": None}


class Job:
    def __init__(self, total):
        self.id = uuid.uuid4().hex[:12]
        self.state = "running"      # running | done | failed | cancelled
        self.phase = "starting"
        self.total = total
        self.done = 0
        self.current = ""
        self.added = 0
        self.converted = 0
        self.removed = 0
        self.errors = []
        self.warnings = []
        self.message = ""
        self.started = time.time()
        self.finished = None
        self.cancel_requested = False
        self.outcome = ("failed", "The sync ended unexpectedly.")

    def public(self):
        return {"id": self.id, "state": self.state, "phase": self.phase, "total": self.total,
                "done": self.done, "current": self.current, "added": self.added,
                "converted": self.converted, "removed": self.removed,
                "errors": self.errors[-50:], "error_count": len(self.errors),
                "warnings": self.warnings[-20:], "message": self.message,
                "started": self.started, "finished": self.finished}


def current_job():
    job = _job["current"]
    return job.public() if job else None


def cancel_job():
    job = _job["current"]
    if job and job.state == "running":
        job.cancel_requested = True
        return True
    return False


def start_job(album_ids, track_ids, remove_ids):
    with _job_lock:
        job = _job["current"]
        if job and job.state == "running":
            raise ipod.IpodError("A sync is already running.")
        status = ipod.status()
        if status.get("state") != "ready":
            raise ipod.IpodError("The iPod is not ready.")
        if not status["can_sync"]:
            raise ipod.IpodError(status["problems"][0]["title"] + ".")
        settings = config.load_settings()
        plan = build_plan(album_ids, track_ids, remove_ids, settings)
        if not plan["add"] and not plan["remove"]:
            raise ipod.IpodError("There is nothing new to sync for that selection.")
        if not plan["fits"]:
            raise ipod.IpodError("The selection does not fit in the iPod's free space.")
        job = Job(total=len(plan["add"]) + len(plan["remove"]))
        _job["current"] = job
    threading.Thread(target=_run, args=(job, plan, status["device"], settings),
                     name=f"sync-{job.id}", daemon=True).start()
    return job.public()


class _Helper:
    """The libgpod helper, spoken to line by line."""

    def __init__(self, mount):
        os.makedirs(config.DATA_DIR, exist_ok=True)
        self._log = open(os.path.join(config.DATA_DIR, "last-sync-helper.log"), "w")
        self.proc = subprocess.Popen([config.HELPER, "sync", mount], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=self._log, text=True,
                                     bufsize=1)

    def send(self, line):
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise ipod.IpodError("The iPod helper stopped unexpectedly.")

    def reply(self):
        line = self.proc.stdout.readline()
        if not line:
            raise ipod.IpodError("The iPod helper stopped unexpectedly.")
        fields = ipod.parse_fields(line)
        while len(fields) < 4:
            fields.append("")
        return fields  # status, what, key, detail

    def until(self, what, warnings=None):
        """Read replies until an OK/ERR for `what` arrives."""
        while True:
            status, got, key, detail = self.reply()
            if status == "WARN":
                if warnings is not None and "Couldn't find" not in detail:
                    warnings.append(f"{got}: {detail}")
                continue
            if got == what:
                return status, key, detail

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self._log.close()


def _run(job, plan, device, settings):
    work_dir = os.path.join(config.WORK_DIR, job.id)
    helper = None
    try:
        job.phase = "backing up"
        _stamp, backup_warnings = backup_ipod(device["guid"], settings["backups_keep"])
        job.warnings.extend(backup_warnings)

        job.phase = "opening the iPod"
        helper = _Helper(ipod.mount_path())
        status, _key, detail = helper.until("OPEN", job.warnings)
        if status != "OK":
            raise ipod.IpodError(f"The iPod's database could not be opened: {detail}")

        for track_id in plan["remove"]:
            if job.cancel_requested:
                break
            job.phase = "removing"
            job.current = f"Track {track_id}"
            helper.send(f"DEL\t{track_id}")
            status, _k, detail = helper.until("DEL")
            if status == "OK":
                job.removed += 1
            else:
                job.errors.append(f"Could not remove track {track_id}: {detail}")
            job.done += 1

        rows = {r["id"]: r for r in library.tracks_by_ids([a["id"] for a in plan["add"]])}
        for item in plan["add"]:
            if job.cancel_requested:
                break
            row = rows.get(item["id"])
            if row is None:
                job.done += 1
                continue
            label = f"{row['artist']} \u2013 {row['title']}"
            job.phase, job.current = "copying", label
            try:
                free = shutil.disk_usage(ipod.mount_path()).free
            except OSError:
                free = 0
            if free < item["size"] + config.FREE_SPACE_RESERVE:
                job.errors.append("The iPod is full; the remaining tracks were not copied.")
                break
            converted = None
            try:
                src = library.absolute_path(row["relpath"])
                if item["action"] == "convert":
                    job.phase = "converting"
                    converted = audio.convert_to_aac(src, work_dir, settings["bitrate"],
                                                     row["samplerate"] or 0)
                    send_path, codec = converted, "aac"
                    bitrate = settings["bitrate"]
                    rate = 44100 if (row["samplerate"] or 0) > audio.MAX_NATIVE_SAMPLE_RATE \
                        else (row["samplerate"] or 44100)
                    job.converted += 1
                else:
                    send_path = src
                    codec = audio.codec_for_output("copy", _meta_from_row(row))
                    bitrate, rate = row["bitrate"] or 0, row["samplerate"] or 44100
                art = ""
                if settings["artwork"] and device["artwork"]:
                    cover = library.cover_path(row["album_key"])
                    art = cover or ""
                album_artist = row["albumartist"] or ("Various Artists" if row["compilation"] else "")
                job.phase = "copying"
                helper.send("\t".join([
                    "ADD", row["key"], escape(send_path), escape(row["title"]),
                    escape(row["artist"]), escape(row["album"]), escape(album_artist),
                    escape(row["genre"]), escape(row["composer"]), str(row["track"] or 0),
                    str(row["tracks"] or 0), str(row["disc"] or 1), str(row["discs"] or 1),
                    str(row["year"] or 0), str(row["duration_ms"] or 0), str(bitrate),
                    str(rate), codec, str(row["compilation"] or 0), escape(art)]))
                status, _k, detail = helper.until("ADD", job.warnings)
                if status == "OK":
                    job.added += 1
                else:
                    job.errors.append(f"{label}: {detail}")
            except (RuntimeError, ValueError, OSError) as exc:
                job.errors.append(f"{label}: {exc}")
            finally:
                if converted and os.path.exists(converted):
                    os.remove(converted)
            job.done += 1

        if job.cancel_requested:
            helper.send("ABORT")
            helper.until("ROLLBACK")
            job.outcome = ("cancelled", "Cancelled. Nothing was changed on the iPod.")
        elif job.added == 0 and job.removed == 0:
            helper.send("ABORT")
            helper.until("ROLLBACK")
            job.outcome = ("failed", "No tracks could be added. Nothing was changed on the iPod.")
        else:
            job.phase, job.current = "saving the iPod's database", ""
            helper.send("COMMIT")
            status, _k, detail = helper.until("COMMIT", job.warnings)
            if status == "OK":
                job.outcome = ("done", _summary(job))
            else:
                job.outcome = ("failed", _commit_failure(detail))
    except ipod.IpodError as exc:
        job.outcome = ("failed", str(exc))
    except Exception as exc:  # never leave the UI waiting
        job.outcome = ("failed", f"Unexpected error: {exc}")
    finally:
        if helper:
            helper.close()
        shutil.rmtree(work_dir, ignore_errors=True)
        ipod.invalidate_tracks()
        # Only now is the sync really over: the helper has exited and caches are clear.
        job.phase, job.current, job.finished = "finished", "", time.time()
        job.state, job.message = job.outcome


def _summary(job):
    parts = []
    if job.added:
        parts.append(f"{job.added} track{'s' if job.added != 1 else ''} added")
    if job.converted:
        parts.append(f"{job.converted} converted to AAC")
    if job.removed:
        parts.append(f"{job.removed} removed")
    text = ", ".join(parts) or "Done"
    if job.errors:
        text += f". {len(job.errors)} could not be copied"
    return text + ". Eject the iPod before unplugging it."


def _commit_failure(detail):
    if "HashInfo" in detail:
        return ("The iPod would not accept the new database because its signing information is "
                "missing. Sync this iPod once with iTunes, then try again. Nothing was changed.")
    return f"The iPod's database could not be written: {detail}. Nothing was changed."
