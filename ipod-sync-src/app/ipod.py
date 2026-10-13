"""Finding, mounting and reading the iPod."""
import glob
import hashlib
import os
import re
import shutil
import stat
import subprocess
import threading

from . import config, library

APPLE_VENDOR = "05ac"
NANO_5G_ID = 27  # ITDB_IPOD_GENERATION_NANO_5 in libgpod
SYSFS_USB = "/sys/bus/usb/devices"
SYSFS_BLOCK = "/sys/block"
DATA_FS_TYPES = ("vfat", "hfsplus", "hfs")

_lock = threading.RLock()
_tracks_cache = {"tracks": None}


class IpodError(Exception):
    pass


# ---------- helper output ----------

def unescape(text):
    def repl(m):
        c = m.group(1)
        return {"t": "\t", "n": "\n"}.get(c, c)
    return re.sub(r"\\(.)", repl, text)


def parse_fields(line):
    return [unescape(part) for part in line.rstrip("\n").split("\t")]


def run_helper(args, timeout=180):
    try:
        return subprocess.run([config.HELPER, *args], capture_output=True, text=True,
                              timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise IpodError(f"The iPod helper could not run: {exc}")


def helper_info(mount):
    result = run_helper(["info", mount])
    if result.returncode != 0:
        raise IpodError((result.stderr or "could not read the iPod").strip())
    info = {}
    for line in result.stdout.splitlines():
        fields = parse_fields(line)
        if len(fields) >= 2:
            info[fields[0]] = fields[1]
    return info


def helper_list(mount):
    result = run_helper(["list", mount])
    if result.returncode != 0:
        raise IpodError((result.stderr or "could not read the iPod's music list").strip())
    tracks = []
    for line in result.stdout.splitlines():
        f = parse_fields(line)
        if f[0] != "T" or len(f) < 16:
            continue
        tracks.append({
            "id": int(f[1]), "path": f[2], "title": f[3], "artist": f[4], "album": f[5],
            "albumartist": f[6], "genre": f[7], "track": int(f[8]), "disc": int(f[9]),
            "year": int(f[10]), "size": int(f[11]), "duration_ms": int(f[12]),
            "bitrate": int(f[13]), "added": int(f[14]), "mediatype": int(f[15]),
            "key": library.track_key(f[4], f[5], f[3], int(f[8])),
        })
    return tracks


# ---------- USB / block devices ----------

def _read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def find_usb_ipods(sysfs=SYSFS_USB):
    found = []
    for path in sorted(glob.glob(os.path.join(sysfs, "*"))):
        name = os.path.basename(path)
        if ":" in name:  # interface entries
            continue
        if _read(os.path.join(path, "idVendor")).lower() != APPLE_VENDOR:
            continue
        product = _read(os.path.join(path, "product"))
        product_id = _read(os.path.join(path, "idProduct")).lower()
        if "ipod" not in product.lower() and not product_id.startswith("12"):
            continue
        try:
            bus = int(_read(os.path.join(path, "busnum")))
            dev = int(_read(os.path.join(path, "devnum")))
        except ValueError:
            continue
        found.append({"sysdir": path, "product": product or "iPod", "bus": bus, "device": dev,
                      "serial": _read(os.path.join(path, "serial"))})
    return found


def disk_for_usb(usb_sysdir):
    """Name of the block device (e.g. 'sdb') behind a USB device, or None."""
    for pattern in ("*/host*/target*/*/block/*", "*/*/host*/target*/*/block/*"):
        hits = glob.glob(os.path.join(usb_sysdir, pattern))
        if hits:
            return os.path.basename(sorted(hits)[0])
    return None


def _ensure_node(name, sys_path):
    node = os.path.join("/dev", name)
    if os.path.exists(node):
        return node
    major_minor = _read(os.path.join(sys_path, "dev"))
    if re.match(r"^\d+:\d+$", major_minor):
        major, minor = (int(x) for x in major_minor.split(":"))
        try:
            os.mknod(node, stat.S_IFBLK | 0o600, os.makedev(major, minor))
        except OSError as exc:
            raise IpodError(f"Cannot create device node {node}: {exc}")
    return node


def _fs_type(node):
    try:
        result = subprocess.run(["blkid", "-p", "-o", "value", "-s", "TYPE", node],
                                capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def data_partition(disk, sysblock=SYSFS_BLOCK):
    """Return (device node, filesystem type) of the iPod's music partition."""
    disk_sys = os.path.join(sysblock, disk)
    candidates = []
    for part in sorted(glob.glob(os.path.join(disk_sys, disk + "*"))):
        if not os.path.exists(os.path.join(part, "partition")):
            continue
        try:
            size = int(_read(os.path.join(part, "size")) or 0)
        except ValueError:
            size = 0
        node = _ensure_node(os.path.basename(part), part)
        fstype = _fs_type(node)
        if fstype in DATA_FS_TYPES:
            candidates.append((size, node, fstype))
    if not candidates:  # an unpartitioned iPod
        node = _ensure_node(disk, disk_sys)
        fstype = _fs_type(node)
        if fstype in DATA_FS_TYPES:
            return node, fstype
        raise IpodError("No FAT32 or Mac (HFS+) partition was found on the iPod.")
    candidates.sort(reverse=True)
    return candidates[0][1], candidates[0][2]


# ---------- mounting ----------

def mount_info(mountpoint=None):
    """(device, fstype, options) when something is mounted at the mountpoint."""
    mountpoint = mountpoint or config.IPOD_MOUNT
    for line in _read("/proc/mounts").splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1] == mountpoint:
            return parts[0], parts[2], parts[3].split(",")
    return None


def is_mounted():
    if config.FAKE_MOUNT:
        return True
    return mount_info() is not None


def mount_path():
    return config.FAKE_MOUNT or config.IPOD_MOUNT


def mount_ipod(settings=None):
    settings = settings or config.load_settings()
    if config.FAKE_MOUNT:
        return
    with _lock:
        if mount_info():
            return
        usb = find_usb_ipods()
        if not usb:
            raise IpodError("No iPod is connected to the Umbrel.")
        disk = disk_for_usb(usb[0]["sysdir"])
        if not disk:
            raise IpodError("The iPod is connected but its storage is not showing up. "
                            "Check that it is in disk mode and try another USB port.")
        node, fstype = data_partition(disk)
        os.makedirs(config.IPOD_MOUNT, exist_ok=True)
        if fstype == "vfat":
            cmd = ["mount", "-t", "vfat", "-o",
                   "rw,noatime,nosuid,nodev,utf8,shortname=mixed,flush", node, config.IPOD_MOUNT]
        else:
            opts = "rw,noatime,nosuid,nodev"
            if settings.get("hfs_force_rw") and fstype == "hfsplus":
                opts += ",force"
            cmd = ["mount", "-t", fstype, "-o", opts, node, config.IPOD_MOUNT]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode != 0:
            raise IpodError("Mounting the iPod failed: "
                            + (result.stderr.strip() or result.stdout.strip() or "unknown error"))
        if not os.path.isdir(os.path.join(config.IPOD_MOUNT, "iPod_Control")):
            subprocess.run(["umount", config.IPOD_MOUNT], capture_output=True)
            raise IpodError("This does not look like an iPod: there is no iPod_Control folder.")
        _read_sysinfo_extended(usb[0])
        _tracks_cache["tracks"] = None


def _read_sysinfo_extended(usb):
    """The Nano 5G describes itself over USB; libgpod needs that description."""
    target = os.path.join(config.IPOD_MOUNT, "iPod_Control", "Device", "SysInfoExtended")
    tool = shutil.which("ipod-read-sysinfo-extended")
    if os.path.exists(target) or not tool:
        return
    try:
        subprocess.run([tool, str(usb["bus"]), str(usb["device"]), config.IPOD_MOUNT],
                       capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass


def unmount_ipod():
    if config.FAKE_MOUNT:
        return
    with _lock:
        if not mount_info():
            return
        subprocess.run(["sync"], timeout=120)
        result = subprocess.run(["umount", config.IPOD_MOUNT], capture_output=True, text=True)
        if result.returncode != 0:
            raise IpodError("The iPod is still in use. Wait for the current sync to finish, "
                            "then try again.")
        _tracks_cache["tracks"] = None


# ---------- status ----------

def _color_from_model(model):
    match = re.search(r"\(([^)]+)\)", model or "")
    return match.group(1).lower() if match else ""


def describe_device(info):
    gen_id = int(info.get("generation_id", 0) or 0)
    model = info.get("model", "iPod")
    capacity = int(info.get("capacity_gb", 0) or 0)
    return {
        "generation": info.get("generation", "iPod"),
        "generation_id": gen_id,
        "model": model,
        "color": _color_from_model(model),
        "capacity_gb": capacity,
        "serial": info.get("serial", ""),
        "guid": info.get("firewire_guid", ""),
        "tracks": int(info.get("tracks", 0) or 0),
        "total_bytes": int(info.get("total_bytes", 0) or 0),
        "free_bytes": int(info.get("free_bytes", 0) or 0),
        "artwork": info.get("artwork_supported") == "1",
    }


def find_problems(info, options):
    """Turn what libgpod reported into things the user can act on."""
    problems = []
    gen_id = int(info.get("generation_id", 0) or 0)
    has_hash = info.get("has_hashinfo") == "1"
    db_error = info.get("db_error", "")
    if "ro" in options:
        problems.append({
            "code": "read_only",
            "title": "The iPod is mounted read-only",
            "detail": "Mac-formatted iPods with journaling on can only be read from Linux. "
                      "Either turn journaling off on a Mac (Disk Utility, or "
                      "'diskutil disableJournal') or restore the iPod as a Windows iPod "
                      "with iTunes, which formats it as FAT32. "
                      "Forcing read-write is available in settings but risks corrupting the iPod.",
            "blocking": True})
    elif db_error and "Couldn't find" not in db_error:
        problems.append({
            "code": "database_unreadable",
            "title": "The iPod's music database can't be read",
            "detail": f"{db_error}. Nothing will be written until this is resolved. "
                      "If you have a saved backup you can restore it below.",
            "blocking": True})
    elif gen_id == NANO_5G_ID and not has_hash:
        problems.append({
            "code": "needs_itunes_setup",
            "title": "This iPod needs one sync with iTunes first",
            "detail": "The nano 5th generation signs its music database, and the signing key "
                      "can only be learned from a database iTunes (or Apple Devices / Finder) "
                      "has written. Sync any song to this iPod from iTunes once, eject it, "
                      "plug it back into the Umbrel and this will clear.",
            "blocking": True})
    elif db_error:
        problems.append({
            "code": "no_database",
            "title": "No music database on this iPod yet",
            "detail": "A new one will be created the first time you sync.",
            "blocking": False})
    return problems


def current_tracks(force=False):
    with _lock:
        if force or _tracks_cache["tracks"] is None:
            try:
                tracks = helper_list(mount_path())
            except IpodError:
                tracks = []
            _tracks_cache["tracks"] = [t for t in tracks if t["mediatype"] & 1]
        return _tracks_cache["tracks"]


def revision(tracks=None):
    """Fingerprint of the iPod's music list. Track ids are reassigned whenever the
    database is rewritten, so removal requests must carry the revision they saw."""
    tracks = current_tracks() if tracks is None else tracks
    raw = ",".join(f"{t['id']}:{t['key']}" for t in sorted(tracks, key=lambda t: t["id"]))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def invalidate_tracks():
    _tracks_cache["tracks"] = None


def status():
    """Everything the UI needs to draw the iPod panel."""
    usb = [] if config.FAKE_MOUNT else find_usb_ipods()
    if not config.FAKE_MOUNT and not usb and not mount_info():
        return {"state": "disconnected"}
    if not is_mounted():
        return {"state": "needs_mount", "usb": {"product": usb[0]["product"]}}
    mount = mount_info()
    options = mount[2] if mount else []
    try:
        info = helper_info(mount_path())
    except IpodError as exc:
        return {"state": "error", "message": str(exc)}
    problems = find_problems(info, options)
    device = describe_device(info)
    device["music_bytes"] = sum(t["size"] for t in current_tracks())
    device["revision"] = revision()
    return {
        "state": "ready",
        "device": device,
        "problems": problems,
        "can_sync": not any(p["blocking"] for p in problems),
        "filesystem": mount[1] if mount else "test",
    }
