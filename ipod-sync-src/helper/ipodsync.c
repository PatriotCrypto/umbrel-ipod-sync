/*
 * ipodsync - small libgpod front-end used by the iPod Sync Umbrel app.
 *
 *   ipodsync info <mountpoint>   device and database summary (key<TAB>value)
 *   ipodsync list <mountpoint>   one T<TAB>... line per track in the database
 *   ipodsync sync <mountpoint>   read ADD / DEL / COMMIT / ABORT commands on
 *                                stdin, answer with OK / ERR / WARN lines
 *
 * All text fields are escaped: backslash -> \\, tab -> \t, newline -> \n.
 *
 * Safety rules the sync command follows:
 *   - nothing in the iPod database changes until COMMIT succeeds;
 *   - files copied to the iPod are removed again if COMMIT fails or the
 *     session ends without COMMIT;
 *   - files of deleted tracks are only removed after the database was
 *     written successfully.
 */
#include <glib.h>
#include <glib/gstdio.h>
#include <gpod/itdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>

/* ---------- escaping ---------- */

static void put_escaped(const char *s)
{
    if (!s)
        return;
    for (; *s; s++) {
        switch (*s) {
        case '\\': fputs("\\\\", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': break;
        default: fputc(*s, stdout);
        }
    }
}

static void put_field(const char *s)
{
    fputc('\t', stdout);
    put_escaped(s);
}

static void put_num(gint64 n)
{
    printf("\t%" G_GINT64_FORMAT, n);
}

static char *unescape(const char *s)
{
    GString *out = g_string_new(NULL);
    for (; *s; s++) {
        if (*s == '\\' && s[1]) {
            s++;
            switch (*s) {
            case 't': g_string_append_c(out, '\t'); break;
            case 'n': g_string_append_c(out, '\n'); break;
            default: g_string_append_c(out, *s);
            }
        } else {
            g_string_append_c(out, *s);
        }
    }
    return g_string_free(out, FALSE);
}

static void kv(const char *key, const char *value)
{
    fputs(key, stdout);
    put_field(value ? value : "");
    fputc('\n', stdout);
}

static void kv_num(const char *key, gint64 value)
{
    fputs(key, stdout);
    put_num(value);
    fputc('\n', stdout);
}

/* ---------- opening the database ---------- */

/* Parse the iPod database. If there is none (or it can't be read) return an
 * empty in-memory database bound to the mountpoint so device details can still
 * be reported. *parse_error receives the reason when parsing failed. */
static Itdb_iTunesDB *open_db(const char *mp, gboolean *have_db, char **parse_error)
{
    GError *err = NULL;
    Itdb_iTunesDB *itdb = itdb_parse(mp, &err);

    if (itdb) {
        *have_db = TRUE;
        return itdb;
    }
    *have_db = FALSE;
    *parse_error = g_strdup(err ? err->message : "unknown error");
    if (err)
        g_error_free(err);

    itdb = itdb_new();
    itdb_set_mountpoint(itdb, mp);
    return itdb;
}

/* TRUE when the device already has a database file of either kind. */
static gboolean db_files_exist(const char *mp)
{
    char *a = itdb_get_itunesdb_path(mp);
    char *b = itdb_get_itunescdb_path(mp);
    gboolean found = (a != NULL) || (b != NULL);
    g_free(a);
    g_free(b);
    return found;
}

static void ensure_master_playlist(Itdb_iTunesDB *itdb)
{
    if (itdb->playlists == NULL) {
        Itdb_Playlist *mpl = itdb_playlist_new("iPod", FALSE);
        itdb_playlist_set_mpl(mpl);
        itdb_playlist_add(itdb, mpl, -1);
    }
}

/* ---------- info ---------- */

static int cmd_info(const char *mp)
{
    gboolean have_db;
    char *parse_error = NULL;
    Itdb_iTunesDB *itdb = open_db(mp, &have_db, &parse_error);
    const Itdb_IpodInfo *info = itdb_device_get_ipod_info(itdb->device);
    struct statvfs sv;
    char *device_dir = itdb_get_device_dir(mp);
    char *tmp;

    kv("db_present", have_db ? "1" : "0");
    if (parse_error)
        kv("db_error", parse_error);

    if (info) {
        kv("generation", itdb_info_get_ipod_generation_string(info->ipod_generation));
        kv("model", itdb_info_get_ipod_model_name_string(info->ipod_model));
        kv_num("generation_id", info->ipod_generation);
        kv_num("capacity_gb", (gint64)info->capacity);
        kv("model_number", info->model_number);
    } else {
        kv("generation", "Unknown");
        kv("model", "Unknown iPod");
        kv_num("generation_id", ITDB_IPOD_GENERATION_UNKNOWN);
    }

    kv("artwork_supported", itdb_device_supports_artwork(itdb->device) ? "1" : "0");

    tmp = itdb_device_get_sysinfo(itdb->device, "FirewireGuid");
    kv("firewire_guid", tmp);
    g_free(tmp);
    tmp = itdb_device_get_sysinfo(itdb->device, "SerialNumber");
    kv("serial", tmp);
    g_free(tmp);

    {
        char *sx = device_dir ? g_build_filename(device_dir, "SysInfoExtended", NULL) : NULL;
        char *hi = device_dir ? g_build_filename(device_dir, "HashInfo", NULL) : NULL;
        kv("has_sysinfo_extended", sx && g_file_test(sx, G_FILE_TEST_EXISTS) ? "1" : "0");
        kv("has_hashinfo", hi && g_file_test(hi, G_FILE_TEST_EXISTS) ? "1" : "0");
        g_free(sx);
        g_free(hi);
    }

    kv_num("tracks", g_list_length(itdb->tracks));

    if (statvfs(mp, &sv) == 0) {
        kv_num("total_bytes", (gint64)sv.f_blocks * (gint64)sv.f_frsize);
        kv_num("free_bytes", (gint64)sv.f_bavail * (gint64)sv.f_frsize);
    }

    g_free(device_dir);
    g_free(parse_error);
    itdb_free(itdb);
    return 0;
}

/* ---------- list ---------- */

static int cmd_list(const char *mp)
{
    gboolean have_db;
    char *parse_error = NULL;
    Itdb_iTunesDB *itdb = open_db(mp, &have_db, &parse_error);
    GList *l;

    if (!have_db) {
        fprintf(stderr, "no readable database: %s\n", parse_error);
        g_free(parse_error);
        itdb_free(itdb);
        return 2;
    }

    for (l = itdb->tracks; l; l = l->next) {
        Itdb_Track *t = l->data;
        fputs("T", stdout);
        put_num(t->id);
        put_field(t->ipod_path);
        put_field(t->title);
        put_field(t->artist);
        put_field(t->album);
        put_field(t->albumartist);
        put_field(t->genre);
        put_num(t->track_nr);
        put_num(t->cd_nr);
        put_num(t->year);
        put_num(t->size);
        put_num(t->tracklen);
        put_num(t->bitrate);
        put_num((gint64)t->time_added);
        put_num(t->mediatype);
        fputc('\n', stdout);
    }
    g_free(parse_error);
    itdb_free(itdb);
    return 0;
}

/* ---------- sync ---------- */

static void reply(const char *status, const char *what, const char *key, const char *detail)
{
    fputs(status, stdout);
    put_field(what);
    put_field(key);
    put_field(detail);
    fputc('\n', stdout);
    fflush(stdout);
}

static const char *filetype_for(const char *codec)
{
    if (!g_strcmp0(codec, "mp3"))  return "MPEG audio file";
    if (!g_strcmp0(codec, "alac")) return "Apple Lossless audio file";
    if (!g_strcmp0(codec, "wav"))  return "WAV audio file";
    if (!g_strcmp0(codec, "aiff")) return "AIFF audio file";
    return "AAC audio file";
}

static void remove_from_all_playlists(Itdb_iTunesDB *itdb, Itdb_Track *track)
{
    GList *l;
    for (l = itdb->playlists; l; l = l->next)
        itdb_playlist_remove_track(l->data, track);
}

static void discard_copied(GPtrArray *copied)
{
    guint i;
    for (i = 0; i < copied->len; i++) {
        const char *path = g_ptr_array_index(copied, i);
        if (path)
            g_unlink(path);
    }
}

static int cmd_sync(const char *mp)
{
    gboolean have_db;
    char *parse_error = NULL;
    Itdb_iTunesDB *itdb = open_db(mp, &have_db, &parse_error);
    GPtrArray *copied = g_ptr_array_new_with_free_func(g_free);
    GPtrArray *to_unlink = g_ptr_array_new_with_free_func(g_free);
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int rc = 3;
    gboolean committed = FALSE;

    if (!have_db && db_files_exist(mp)) {
        /* A database is there but could not be read. Starting a new one
         * would wipe the music list on the device, so stop here. */
        reply("ERR", "OPEN", "", parse_error ? parse_error : "database unreadable");
        g_free(parse_error);
        g_ptr_array_free(copied, TRUE);
        g_ptr_array_free(to_unlink, TRUE);
        itdb_free(itdb);
        return 5;
    }
    if (!have_db)
        reply("WARN", "OPEN", "", parse_error);
    ensure_master_playlist(itdb);
    reply("OK", "OPEN", "", have_db ? "database loaded" : "new database");

    while ((n = getline(&line, &cap, stdin)) != -1) {
        gchar **f;
        guint nf;

        while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
            line[--n] = '\0';
        if (!*line)
            continue;

        f = g_strsplit(line, "\t", -1);
        nf = g_strv_length(f);

        if (!strcmp(f[0], "ADD") && nf >= 20) {
            /* ADD key src title artist album albumartist genre composer
             *     track tracks cd cds year duration_ms bitrate samplerate
             *     codec compilation art */
            const char *key = f[1];
            char *src = unescape(f[2]);
            GError *err = NULL;
            Itdb_Track *t = itdb_track_new();
            Itdb_Playlist *mpl = itdb_playlist_mpl(itdb);
            GStatBuf st;

            if (g_stat(src, &st) != 0) {
                reply("ERR", "ADD", key, "source file not readable");
                itdb_track_free(t);
                g_free(src);
                g_strfreev(f);
                continue;
            }

            t->title       = unescape(f[3]);
            t->artist      = unescape(f[4]);
            t->album       = unescape(f[5]);
            t->albumartist = unescape(f[6]);
            t->genre       = unescape(f[7]);
            t->composer    = unescape(f[8]);
            t->track_nr    = atoi(f[9]);
            t->tracks      = atoi(f[10]);
            t->cd_nr       = atoi(f[11]);
            t->cds         = atoi(f[12]);
            t->year        = atoi(f[13]);
            t->tracklen    = atoi(f[14]);
            t->bitrate     = atoi(f[15]);
            t->samplerate  = atoi(f[16]);
            t->filetype    = g_strdup(filetype_for(f[17]));
            t->compilation = atoi(f[18]) ? 1 : 0;
            t->size        = (guint32)st.st_size;
            t->mediatype   = ITDB_MEDIATYPE_AUDIO;
            t->time_added  = time(NULL); /* host time; libgpod converts on write */
            t->time_modified = t->time_added;

            /* the track must belong to the database before it is copied */
            itdb_track_add(itdb, t, -1);
            itdb_playlist_add_track(mpl, t, -1);

            if (!itdb_cp_track_to_ipod(t, src, &err)) {
                reply("ERR", "ADD", key, err ? err->message : "copy failed");
                if (err)
                    g_error_free(err);
                remove_from_all_playlists(itdb, t);
                itdb_track_remove(t);
            } else {
                char idbuf[32];
                char *dest = itdb_filename_on_ipod(t);
                if (dest)
                    g_ptr_array_add(copied, dest);

                if (itdb_device_supports_artwork(itdb->device) && *f[19]) {
                    char *art = unescape(f[19]);
                    if (!itdb_track_set_thumbnails(t, art))
                        reply("WARN", "ART", key, "artwork could not be added");
                    g_free(art);
                }
                g_snprintf(idbuf, sizeof idbuf, "%u", t->id);
                reply("OK", "ADD", key, idbuf);
            }
            g_free(src);
        } else if (!strcmp(f[0], "DEL") && nf >= 2) {
            guint32 id = (guint32)strtoul(f[1], NULL, 10);
            Itdb_Track *t = itdb_track_by_id(itdb, id);
            if (!t) {
                reply("ERR", "DEL", f[1], "track not found");
            } else {
                char *path = itdb_filename_on_ipod(t);
                if (path)
                    g_ptr_array_add(to_unlink, path);
                itdb_track_remove_thumbnails(t);
                remove_from_all_playlists(itdb, t);
                itdb_track_remove(t);
                reply("OK", "DEL", f[1], "");
            }
        } else if (!strcmp(f[0], "COMMIT")) {
            GError *err = NULL;
            if (itdb_write(itdb, &err)) {
                guint i;
                for (i = 0; i < to_unlink->len; i++)
                    g_unlink(g_ptr_array_index(to_unlink, i));
                sync();
                committed = TRUE;
                rc = 0;
                reply("OK", "COMMIT", "", "database written");
            } else {
                reply("ERR", "COMMIT", "", err ? err->message : "database write failed");
                if (err)
                    g_error_free(err);
                rc = 4;
            }
            g_strfreev(f);
            break;
        } else if (!strcmp(f[0], "ABORT")) {
            g_strfreev(f);
            break;
        } else {
            reply("ERR", "CMD", "", "unrecognised command");
        }
        g_strfreev(f);
    }

    if (!committed) {
        discard_copied(copied);
        reply("OK", "ROLLBACK", "", "copied files removed");
    }

    free(line);
    g_free(parse_error);
    g_ptr_array_free(copied, TRUE);
    g_ptr_array_free(to_unlink, TRUE);
    itdb_free(itdb);
    return rc;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc < 3) {
        fprintf(stderr, "usage: %s info|list|sync <mountpoint>\n", argv[0]);
        return 1;
    }
    if (!strcmp(argv[1], "info")) return cmd_info(argv[2]);
    if (!strcmp(argv[1], "list")) return cmd_list(argv[2]);
    if (!strcmp(argv[1], "sync")) return cmd_sync(argv[2]);
    fprintf(stderr, "unknown command %s\n", argv[1]);
    return 1;
}
