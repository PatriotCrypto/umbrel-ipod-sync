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
    rel = rel.replace("\\", "/").strip().strip("/")
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


def _tidy_folders(folders):
    """Drop repeats and folders that sit inside another chosen folder."""
    out = []
    for rel in sorted(set(folders), key=lambda r: (r.count("/"), r)):
        if rel == "" or not any(o == "" or rel == o or rel.startswith(o + "/") for o in out):
            out.append(rel)
    return out


def music_folders():
    folders = load_settings()["music_folders"]
    return _tidy_folders([f for f in folders if isinstance(f, str)]) or list(DEFAULT_FOLDERS)


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    settings["music_folders"] = list(DEFAULT_FOLDERS)
    try:
        with open(_settings_path(), "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        for key in DEFAULT_SETTINGS:
            if key in stored and type(stored[key]) is type(DEFAULT_SETTINGS[key]):
                settings[key] = stored[key]
        if isinstance(settings["music_folders"], list):
            settings["music_folders"] = [f for f in settings["music_folders"] if isinstance(f, str)] \
                or list(DEFAULT_FOLDERS)
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
            settings["music_folders"] = _tidy_folders([normalize_folder(f) for f in folders])
        for key in ("convert_lossless", "artwork", "hfs_force_rw"):
            if key in updates:
                settings[key] = bool(updates[key])
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _settings_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
        os.replace(tmp, _settings_path())
        return settings
