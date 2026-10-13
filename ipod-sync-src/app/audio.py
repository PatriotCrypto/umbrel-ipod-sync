"""Reading tags, deciding what the iPod can play as-is, and converting the rest.

The iPod nano (5th generation) plays AAC, MP3, Apple Lossless, WAV and AIFF.
It cannot play FLAC, Ogg Vorbis, Opus, WMA and similar, so those are converted
to AAC. Copy-protected files cannot be played and are skipped.
"""
import os
import re
import subprocess

import mutagen
from mutagen.mp4 import MP4

AUDIO_EXTENSIONS = {
    ".mp3", ".m4a", ".flac", ".ogg", ".oga", ".opus",
    ".wav", ".aif", ".aiff", ".wma", ".ape", ".wv",
}
MAX_NATIVE_SAMPLE_RATE = 48000
MAX_NATIVE_BITRATE = 320


def _first(tags, key):
    if not tags:
        return ""
    value = tags.get(key)
    if not value:
        return ""
    if isinstance(value, (list, tuple)):
        value = value[0]
    return str(value).strip()


def _pair(text):
    """'3/12' -> (3, 12); '3' -> (3, 0); '' -> (0, 0)."""
    match = re.match(r"\s*(\d+)(?:\s*/\s*(\d+))?", text or "")
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2) or 0)


def _year(text):
    match = re.match(r"\s*(\d{4})", text or "")
    return int(match.group(1)) if match else 0


def _is_compilation(path):
    try:
        raw = mutagen.File(path)
    except Exception:
        return False
    tags = getattr(raw, "tags", None)
    if not tags:
        return False
    try:
        if isinstance(raw, MP4):
            return bool(tags.get("cpil"))
        for key in ("TCMP", "COMPILATION", "compilation"):
            value = tags.get(key)
            if value:
                text = str(value[0] if isinstance(value, list) else value)
                return text.strip() in ("1", "true", "True")
    except Exception:
        pass
    return False


def codec_name(audio):
    """Short codec label: mp3, aac, alac, wav, aiff, flac, vorbis, opus, other."""
    info = getattr(audio, "info", None)
    cls = type(audio).__name__
    if cls in ("MP3", "EasyMP3"):
        return "mp3"
    if cls in ("MP4", "EasyMP4"):
        codec = getattr(info, "codec", "") or ""
        if codec.startswith("alac"):
            return "alac"
        if codec.startswith("mp4a"):
            return "aac"
        if codec.startswith("drm"):
            return "protected"
        return "other"
    if cls == "WAVE":
        return "wav"
    if cls == "AIFF":
        return "aiff"
    if cls == "FLAC":
        return "flac"
    if cls == "OggVorbis":
        return "vorbis"
    if cls == "OggOpus":
        return "opus"
    return "other"


def read_metadata(path):
    """Return a dict of tags and stream properties, or None if unreadable."""
    try:
        audio = mutagen.File(path, easy=True)
    except Exception:
        return None
    if audio is None or getattr(audio, "info", None) is None:
        return None
    tags = audio.tags
    info = audio.info
    track, tracks = _pair(_first(tags, "tracknumber"))
    disc, discs = _pair(_first(tags, "discnumber"))
    title = _first(tags, "title") or os.path.splitext(os.path.basename(path))[0]
    artist = _first(tags, "artist")
    albumartist = _first(tags, "albumartist")
    album = _first(tags, "album")
    compilation = _is_compilation(path)
    return {
        "title": title,
        "artist": artist or albumartist or "Unknown Artist",
        "albumartist": albumartist,
        "album": album or "Unknown Album",
        "genre": _first(tags, "genre"),
        "composer": _first(tags, "composer"),
        "track": track,
        "tracks": tracks,
        "disc": disc or 1,
        "discs": discs or 1,
        "year": _year(_first(tags, "date")),
        "duration_ms": int(round((getattr(info, "length", 0) or 0) * 1000)),
        "bitrate": int((getattr(info, "bitrate", 0) or 0) / 1000),
        "samplerate": int(getattr(info, "sample_rate", 0) or 0),
        "bits": int(getattr(info, "bits_per_sample", 0) or 0),
        "codec": codec_name(audio),
        "compilation": 1 if compilation else 0,
    }


def plan_conversion(meta, settings):
    """Decide how a track reaches the iPod.

    Returns (action, reason) where action is "copy", "convert" or "skip".
    """
    codec = meta["codec"]
    if codec == "protected":
        return "skip", "copy-protected file the iPod cannot play from here"
    if codec in ("flac", "vorbis", "opus", "other"):
        return "convert", "format is not playable on the iPod"
    if meta["samplerate"] > MAX_NATIVE_SAMPLE_RATE:
        return "convert", "sample rate above 48 kHz"
    if codec in ("alac", "wav", "aiff"):
        if codec in ("wav", "aiff") and meta.get("bits", 16) not in (0, 16):
            return "convert", "only 16-bit PCM plays on the iPod"
        if settings.get("convert_lossless"):
            return "convert", "lossless converted to save space"
        return "copy", ""
    if meta["bitrate"] > MAX_NATIVE_BITRATE:
        return "convert", "bitrate above 320 kbit/s"
    return "copy", ""


def estimated_size(meta, action, settings, file_size):
    if action == "convert":
        seconds = meta["duration_ms"] / 1000.0
        return int(seconds * settings["bitrate"] * 1000 / 8) + 4096
    return file_size


def convert_to_aac(src, work_dir, bitrate, samplerate):
    """Convert src to an AAC .m4a in work_dir and return the new path."""
    os.makedirs(work_dir, exist_ok=True)
    dst = os.path.join(work_dir, "converted.m4a")
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src, "-vn", "-map_metadata", "-1",
        "-c:a", "aac", "-b:a", f"{int(bitrate)}k", "-ac", "2",
    ]
    if samplerate > MAX_NATIVE_SAMPLE_RATE:
        cmd += ["-ar", "44100"]
    cmd.append(dst)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if result.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError((result.stderr or "ffmpeg failed").strip().splitlines()[-1])
    return dst


def codec_for_output(action, meta):
    """Codec label handed to the helper for the file that is actually copied."""
    if action == "convert":
        return "aac"
    return meta["codec"] if meta["codec"] in ("mp3", "aac", "alac", "wav", "aiff") else "aac"
