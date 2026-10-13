CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra
PKGS    := libgpod-1.0 glib-2.0

ipodsync: ipodsync.c
	$(CC) $(CFLAGS) $(shell pkg-config --cflags $(PKGS)) -o $@ $< $(shell pkg-config --libs $(PKGS))

clean:
	rm -f ipodsync
