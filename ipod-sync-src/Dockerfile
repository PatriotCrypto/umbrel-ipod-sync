# uPod for Umbrel. Built for linux/amd64 and linux/arm64 by the GitHub workflow.
#
# The libgpod version in Debian bookworm (0.8.3) is the one this app was
# developed and tested against.

FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc make pkg-config libc6-dev libgpod-dev libglib2.0-dev \
 && rm -rf /var/lib/apt/lists/*
COPY helper /src/helper
RUN make -C /src/helper

FROM debian:bookworm-slim
# libgpod-common provides ipod-read-sysinfo-extended, which the iPod nano 5th
# generation needs (it describes itself over raw USB). "mount" is its own
# package on bookworm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-flask python3-mutagen python3-waitress \
      ffmpeg libgpod4 libgpod-common mount util-linux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/helper/ipodsync /usr/local/bin/ipodsync
WORKDIR /srv
COPY app /srv/app
COPY static /srv/static

# Fail the build early if anything the app depends on is missing.
RUN python3 -c "import flask, mutagen, waitress" \
 && ipodsync 2>&1 | grep -q usage \
 && command -v ipod-read-sysinfo-extended \
 && ldd "$(command -v ipod-read-sysinfo-extended)" | grep -q libusb \
 && command -v ffmpeg && command -v mount && command -v blkid

ENV PORT=8080 MUSIC_DIR=/music DATA_DIR=/data IPOD_MOUNT=/ipod PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python3 -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"
CMD ["python3", "-m", "app.server"]
