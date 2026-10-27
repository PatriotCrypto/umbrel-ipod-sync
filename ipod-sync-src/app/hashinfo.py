"""The signing file the iPod nano 5th generation needs before anything can be written to it.

Apple's software signs the music database it writes. libgpod can sign new databases the same
way, but only once it has a small file called HashInfo, which it learns from a database Apple's
software wrote. libgpod only does that for devices it believes use one particular scheme, and
it believes the wrong thing for this nano, so the file never appears. This module does that one
step itself, with the same arithmetic libgpod uses:

    signature = AES-CBC(key, sha1(database with a few fields zeroed) + 12 random bytes, iv)

The signature, the sha1 and the random bytes are all in the database, so the iv can be worked
out and kept. The result is checked by signing the same database again and comparing the whole
signature; nothing is written unless it matches exactly.
"""
import hashlib
import os
import re

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:  # pragma: no cover - the Docker image always has it
    Cipher = None

KEY = bytes([0x61, 0x8c, 0xa1, 0x0d, 0xc7, 0xf5, 0x7f, 0xd3,
             0xb4, 0x72, 0x3e, 0x08, 0x15, 0x74, 0x63, 0xd7])
DB_ID = (0x18, 8)       # (offset, length) of the fields that are blanked before hashing
HASH58 = (0x58, 20)
HASH72 = (0x72, 46)
MIN_LEN = 0x72 + 46


def available():
    return Cipher is not None


def _sha1(data):
    blank = bytearray(data)
    for offset, length in (DB_ID, HASH58, HASH72):
        blank[offset:offset + length] = bytes(length)
    return hashlib.sha1(bytes(blank)).digest()


def _aes(mode):
    return Cipher(algorithms.AES(KEY), mode)


def derive(data):
    """(iv, random_bytes) hidden in a database signed by Apple's software, or None."""
    if Cipher is None or len(data) < MIN_LEN or data[:4] != b"mhbd":
        return None
    sig = data[HASH72[0]:HASH72[0] + HASH72[1]]
    if sig[:2] != b"\x01\x00":
        return None
    plain = _sha1(data) + sig[2:14]
    first = _aes(modes.ECB()).decryptor().update(sig[14:30])
    iv = bytes(a ^ b for a, b in zip(first, plain[:16]))
    enc = _aes(modes.CBC(iv)).encryptor()
    if enc.update(plain) + enc.finalize() != sig[14:46]:
        return None          # not a signature this arithmetic can reproduce: leave it alone
    return iv, sig[2:14]


def guid_bytes(device_dir):
    """The iPod's FireWire id as 20 bytes (libgpod pads the 8 real bytes with zeros)."""
    text = ""
    for name, pattern in (("SysInfoExtended", r"<key>FireWireGUID</key>\s*<string>\s*([0-9A-Fa-f]+)"),
                          ("SysInfo", r"FirewireGuid:\s*(?:0x)?([0-9A-Fa-f]+)")):
        try:
            with open(os.path.join(device_dir, name), "r", errors="replace") as handle:
                found = re.search(pattern, handle.read(), re.I)
        except OSError:
            continue
        if found:
            text = found.group(1)
            break
    if len(text) % 2 or not 2 <= len(text) <= 40:
        return None
    return bytes.fromhex(text).ljust(20, b"\0")


def ensure(mount):
    """Create iPod_Control/Device/HashInfo when it is missing and can be worked out.
    Returns True when the file exists afterwards."""
    device_dir = os.path.join(mount, "iPod_Control", "Device")
    target = os.path.join(device_dir, "HashInfo")
    if os.path.exists(target):
        return True
    if Cipher is None or not os.path.isdir(device_dir):
        return False
    guid = guid_bytes(device_dir)
    if guid is None:
        return False
    for name in ("iTunesCDB", "iTunesDB"):
        path = os.path.join(mount, "iPod_Control", "iTunes", name)
        try:
            with open(path, "rb") as handle:
                found = derive(handle.read())
        except OSError:
            continue
        if found:
            iv, rnd = found
            try:
                with open(target, "wb") as out:
                    out.write(b"HASHv0" + guid + rnd + iv)
            except OSError:
                return False
            return True
    return False
