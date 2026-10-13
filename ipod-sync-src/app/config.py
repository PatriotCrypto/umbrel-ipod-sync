"""Paths and defaults. Everything can be overridden with environment variables."""
import json
import os
import threading

MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
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
}

_settings_lock = threading.Lock()


def _settings_path():
    return os.path.join(DATA_DIR, "settings.json")


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(_settings_path(), "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        for key in DEFAULT_SETTINGS:
            if key in stored and type(stored[key]) is type(DEFAULT_SETTINGS[key]):
                settings[key] = stored[key]
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
        for key in ("convert_lossless", "artwork", "hfs_force_rw"):
            if key in updates:
                settings[key] = bool(updates[key])
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _settings_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
        os.replace(tmp, _settings_path())
        return settings
