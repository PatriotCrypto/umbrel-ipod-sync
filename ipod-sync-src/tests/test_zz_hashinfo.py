"""The signing file for the nano 5th generation, and the Eject button staying ejected."""
import hashlib
import os
import subprocess

import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app import hashinfo, ipod
from tests.conftest import HELPER, tone

GUID = "000A27001EA01FF5"
IV = bytes(range(16, 32))
RND = bytes(range(100, 112))


def signed_database(body=b"\x07" * 400):
    """What Apple's software writes: a header with a hash72 signature over the whole file."""
    data = bytearray(b"mhbd" + bytes(0xBC - 4) + body)
    data[4:8] = (0xBC).to_bytes(4, "little")
    data[8:12] = len(data).to_bytes(4, "little")
    data[0x18:0x20] = b"\x11" * 8          # db id: blanked before hashing
    data[0x58:0x6C] = b"\x22" * 20         # hash58: blanked too
    plain = hashinfo._sha1(bytes(data)) + RND
    enc = Cipher(algorithms.AES(hashinfo.KEY), modes.CBC(IV)).encryptor()
    data[0x72:0x72 + 46] = b"\x01\x00" + RND + enc.update(plain) + enc.finalize()
    return bytes(data)


def test_derive_recovers_the_iv_and_refuses_anything_else():
    data = signed_database()
    assert hashinfo.derive(data) == (IV, RND)
    broken = bytearray(data)
    broken[0xBC + 5] ^= 1                   # the file changed after it was signed
    assert hashinfo.derive(bytes(broken)) is None
    assert hashinfo.derive(b"mhbd" + bytes(300)) is None   # no signature at all
    assert hashinfo.derive(b"nope") is None


def make_nano(path, sysinfo_extended=True):
    from tests.conftest import make_pod
    make_pod(path, model="C066", guid=GUID)
    if sysinfo_extended:
        with open(os.path.join(path, "iPod_Control", "Device", "SysInfoExtended"), "w") as fh:
            fh.write("<plist><dict><key>FireWireGUID</key>\n<string>%s</string>\n</dict></plist>" % GUID)


def test_ensure_writes_a_file_libgpod_accepts(tmp_path):
    pod = str(tmp_path / "pod")
    make_nano(pod)
    with open(os.path.join(pod, "iPod_Control", "iTunes", "iTunesCDB"), "wb") as fh:
        fh.write(signed_database())
    assert hashinfo.ensure(pod) is True
    raw = open(os.path.join(pod, "iPod_Control", "Device", "HashInfo"), "rb").read()
    assert raw == b"HASHv0" + bytes.fromhex(GUID).ljust(20, b"\0") + RND + IV
    assert hashinfo.ensure(pod) is True     # second call changes nothing


def test_ensure_does_nothing_without_a_signed_database(tmp_path):
    pod = str(tmp_path / "pod")
    make_nano(pod)
    assert hashinfo.ensure(pod) is False    # no database yet
    with open(os.path.join(pod, "iPod_Control", "iTunes", "iTunesCDB"), "wb") as fh:
        fh.write(b"mhbd" + bytes(300))
    assert hashinfo.ensure(pod) is False
    assert not os.path.exists(os.path.join(pod, "iPod_Control", "Device", "HashInfo"))


def test_guid_comes_from_sysinfo_when_there_is_no_extended_file(tmp_path):
    pod = str(tmp_path / "pod")
    make_nano(pod, sysinfo_extended=False)
    assert hashinfo.guid_bytes(os.path.join(pod, "iPod_Control", "Device")) == \
        bytes.fromhex(GUID).ljust(20, b"\0")


def test_eject_is_remembered_until_the_iPod_is_unplugged(monkeypatch):
    plugged = [{"sysdir": "/x", "product": "iPod", "bus": 1, "device": 7, "serial": ""}]
    monkeypatch.setattr(ipod.config, "FAKE_MOUNT", "")
    monkeypatch.setattr(ipod, "find_usb_ipods", lambda *a, **k: list(plugged))
    monkeypatch.setattr(ipod, "mount_info", lambda *a, **k: None)
    ipod._ejected.clear()
    assert ipod.status()["state"] == "needs_mount"
    ipod._ejected.add((1, 7))
    assert ipod.status()["state"] == "ejected"       # not opened again behind the user's back
    plugged[:] = []
    assert ipod.status()["state"] == "disconnected"  # unplugged ...
    plugged.append(dict(sysdir="/x", product="iPod", bus=1, device=8, serial=""))
    assert ipod.status()["state"] == "needs_mount"   # ... and plugged in again
