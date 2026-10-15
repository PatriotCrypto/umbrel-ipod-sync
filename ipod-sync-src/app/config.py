"""Paths and defaults. Everything can be overridden with environment variables."""
import json
import os
import threading

# MUSIC_DIR is the top of everything uPod may read: on an Umbrel it is the whole storage
# folder (Downloads, Media, ...). Which folders inside it count as "the library" is a setting.
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
# Folders (relative to MUSIC_DIR) used until the user chooses; "" means MUSIC_DIR itself.
DEFAULT_FOLDERS = [f.strip().strip("/") for f in os.environ.get("DEFAULT_MUSIC_FOLDERS", "").split(",")
                   if f.strip()] or [""]
# Older installs indexed paths relative to the Downloads folder; this prefix upgrades them.
LEGACY_PREFIX = os.environ.get("LEGACY_MUSIC_PREFIX", "").strip("/")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
IPOD_MOUNT = os.environ.get("IPOD_MOUNT", "/ipod")
HELPER = os.environ.get("IPODSYNC_BIN", "/usr/local/bin/ipodsync")
WORK_DIR = os.environ.get("WORK_DIR", "/tmp/ipodsync")

# Development and tests only: treat this folder as an already-mounted iPod and
# skip all USB and mount handling.
FAKE_MOUNT = os.environ.get("IPOD_FAKE_MOUNT") or None

# Space always left free on the iPod so it can still write its own files.
FREE_SPACE_RESERVE = 64 * 1024 * 1024

DEFAULT_SETTINGS = {
    "bitrate": 256,            # kbit/s for converted tracks
    "convert_lossless": True,  # also convert ALAC / WAV / AIFF to AAC (saves space)
    "artwork": True,           # copy album covers to the iPod
    "hfs_force_rw": False,     # mount journaled HFS+ read-write anyway (risky)
    "backups_keep": 3,
    "music_folders": list(DEFAULT_FOLDERS),   # folders (inside MUSIC_DIR) that make up the library
}

_settings_lock = threading.Lock()


def _settings_path():
    return os.path.join(DATA_DIR, "settings.json")


def storage_root():
    return os.path.realpath(MUSIC_DIR)


def normalize_folder(rel):
    """A folder inside MUSIC_DIR as a clean relative path ('' is the top). Raises ValueError
    for anything that is outside it, hidden, or not a folder."""
    if not isinstance(rel, str):
        raise ValueError("folder must be text")
    rel = rel.replace("\\", "/").strip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." or p.startswith(".") for p in parts):
        raise ValueError("that folder is not allowed")
    rel = "/".join(parts)
    root = storage_root()
    path = os.path.realpath(os.path.join(root, rel))
    if os.path.commonpath([root, path]) != root:
        raise ValueError("that folder is outside your storage")
    if not os.path.isdir(path):
        raise ValueError(f"folder not found: {rel or '/'}")
    return rel


def real_case(rel):
    """`rel` with each part spelled the way it is on disk ('downloads' -> 'Downloads'), so a
    folder saved or defaulted in the wrong capitals is still found. Unchanged if not found."""
    if not isinstance(rel, str) or not rel:
        return rel
    cur, out = storage_root(), []
    for part in [p for p in rel.replace("\\", "/").split("/") if p]:
        if os.path.isdir(os.path.join(cur, part)):
            name = part
        else:
            try:
                names = [n for n in os.listdir(cur) if n.lower() == part.lower()
                         and os.path.isdir(os.path.join(cur, n))]
            except OSError:
                return rel
            if not names:
                return rel
            name = sorted(names)[0]
        out.append(name)
        cur = os.path.join(cur, name)
    return "/".join(out)


# Looked for, in order, when the folder named by DEFAULT_MUSIC_FOLDERS is not on this Umbrel.
FALLBACK_NAMES = ("downloads", "music", "media")


def _has_music(folder, budget=4000):
    """True if there is a song somewhere in `folder`. Gives up after `budget` entries so a
    huge folder of something else can't hold up the first start."""
    from . import audio
    if not os.path.isdir(folder):
        return False
    stack, seen = [folder], set()
    while stack and budget > 0:
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for e in entries:
            budget -= 1
            if budget <= 0 or e.name.startswith("."):
                break
            try:
                if e.is_dir():
                    real = os.path.realpath(e.path)
                    if real not in seen:
                        seen.add(real)
                        stack.append(e.path)
                elif os.path.splitext(e.name)[1].lower() in audio.AUDIO_EXTENSIONS:
                    return True
            except OSError:
                continue
    return False


def usable_defaults():
    """The default folders, spelled as they are on disk. If none of them is there -- another
    Umbrel keeps its music somewhere else entirely -- use the whole storage folder, which is
    right on every layout."""
    root = storage_root()
    out = [real_case(f) for f in DEFAULT_FOLDERS]
    if any(f == "" or os.path.isdir(os.path.join(root, f)) for f in out):
        return out
    for name in FALLBACK_NAMES:
        real = real_case(name)
        if _has_music(os.path.join(root, real)):
            return [real]
    # Nothing recognisable: the whole storage folder, which is right on any layout.
    return [""]


def _tidy_folders(folders):
    """Drop repeats and folders that sit inside another chosen folder."""
    out = []
    for rel in sorted(set(folders), key=lambda r: (r.count("/"), r)):
        if rel == "" or not any(o == "" or rel == o or rel.startswith(o + "/") for o in out):
            out.append(rel)
    return out


def music_folders():
    folders = load_settings()["music_folders"]
    return _tidy_folders([f for f in folders if isinstance(f, str)]) or usable_defaults()


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    settings["music_folders"] = usable_defaults()
    try:
        with open(_settings_path(), "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        for key in DEFAULT_SETTINGS:
            if key in stored and type(stored[key]) is type(DEFAULT_SETTINGS[key]):
                settings[key] = stored[key]
        if isinstance(settings["music_folders"], list):
            settings["music_folders"] = [f for f in settings["music_folders"] if isinstance(f, str)] \
                or usable_defaults()
    except (OSError, ValueError):
        pass
    try:
        settings["music_folders"] = [real_case(f) for f in settings["music_folders"]]
    except (OSError, ValueError):
        pass
    return settings


def save_settings(updates):
    """Validate and persist the settings the user is allowed to change."""
    with _settings_lock:
        settings = load_settings()
        if "bitrate" in updates:
            bitrate = int(updates["bitrate"])
            if bitrate not in (128, 160, 192, 224, 256, 320):
                raise ValueError("bitrate must be one of 128, 160, 192, 224, 256, 320")
            settings["bitrate"] = bitrate
        if "music_folders" in updates:
            folders = updates["music_folders"]
            if not isinstance(folders, list) or not folders:
                raise ValueError("choose at least one music folder")
            # A folder that is already in the list stays even when it can't be found right now
            # (an unplugged drive); only newly added folders must exist.
            have = set(settings["music_folders"])
            keep = []
            for f in folders:
                if isinstance(f, str) and f.strip().strip("/") in have:
                    keep.append(f.strip().strip("/"))
                else:
                    keep.append(normalize_folder(f))
            settings["music_folders"] = _tidy_folders(keep)
        for key in ("convert_lossless", "artwork", "hfs_force_rw"):
            if key in updates:
                settings[key] = bool(updates[key])
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _settings_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
        os.replace(tmp, _settings_path())
        return settings
