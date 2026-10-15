"""Tidy up genre tags so a library sorts into a handful of shelves.

Tags in the wild are a mess: "hip hop", "Hip-Hop/Rap", "(17)", "Alt. Rock", empty.
`canonical` folds them into broad, familiar genres; anything it doesn't recognise
keeps its own name (tidied), and an empty tag gives None so the caller can borrow
the genre from the other songs on the album.
"""
import re
import unicodedata

# The 80 original ID3v1 genres, which old tags still refer to by number, e.g. "(17)".
ID3_GENRES = [
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz",
    "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno",
    "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno",
    "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental",
    "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alternative Rock", "Bass", "Soul",
    "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
    "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
    "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
    "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer",
    "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll",
    "Hard Rock",
]

UNSORTED = "Unsorted"

# First match wins, so the more specific shelves come first.
RULES = [
    ("Christian & Gospel", ["christian", "gospel", "worship", "ccm", "praise", "hymn", "hymns",
                            "inspirational", "contemporary christian"]),
    ("Hip-Hop/Rap", ["hip hop", "hiphop", "hip-hop", "rap", "trap", "grime", "boom bap", "drill"]),
    ("R&B/Soul", ["r&b", "rnb", "r and b", "r b", "rhythm and blues", "soul", "motown", "funk",
                  "neo soul", "quiet storm"]),
    ("Metal", ["metal", "grindcore", "metalcore", "thrash"]),
    ("Punk", ["punk", "emo", "ska", "hardcore"]),
    ("Alternative", ["alternative", "alt rock", "alt", "indie", "grunge", "shoegaze", "new wave",
                     "post rock", "post punk", "britpop"]),
    ("Rock", ["rock", "classic rock", "hard rock", "psychedelic", "prog", "progressive",
              "roots rock", "southern rock", "blues rock"]),
    ("Pop", ["pop", "synthpop", "k pop", "j pop", "teen pop", "easy listening", "adult contemporary",
             "top 40", "disco"]),
    ("Country", ["country", "bluegrass", "americana", "honky tonk", "outlaw"]),
    ("Folk", ["folk", "singer songwriter", "acoustic", "singer/songwriter"]),
    ("Jazz", ["jazz", "swing", "bebop", "big band", "smooth jazz", "bossa nova"]),
    ("Blues", ["blues"]),
    ("Classical", ["classical", "symphony", "opera", "baroque", "orchestral", "chamber", "concerto"]),
    ("Electronic", ["electronic", "electronica", "edm", "house", "techno", "trance", "dubstep",
                    "dance", "ambient", "drum and bass", "dnb", "downtempo", "chillout",
                    "synthwave", "idm", "electro", "lo fi", "lofi", "chillwave"]),
    ("Reggae", ["reggae", "dub", "dancehall"]),
    ("Latin", ["latin", "salsa", "reggaeton", "bachata", "cumbia", "merengue", "tango", "latino"]),
    ("World", ["world", "afrobeat", "celtic", "african", "indian", "bollywood", "international"]),
    ("Soundtrack", ["soundtrack", "score", "ost", "movie", "film", "musical", "cast recording",
                    "video game", "game"]),
    ("Holiday", ["christmas", "holiday", "xmas", "seasonal"]),
    ("Children's", ["children", "childrens", "kids", "lullaby", "nursery"]),
    ("Spoken Word", ["spoken", "audiobook", "podcast", "comedy", "speech", "sermon", "audio book"]),
]


def _fold(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return text.replace("&", " & ").replace("-", " ").replace("_", " ").replace("/", " ")


def _compile():
    compiled = []
    for name, words in RULES:
        parts = []
        for word in words:
            w = _fold(word).strip()
            w = re.escape(w).replace(r"\ ", r"\s+")
            parts.append(w)
        compiled.append((name, re.compile(r"(?<![a-z0-9&])(?:" + "|".join(parts) + r")s?(?![a-z0-9])")))
    return compiled


_COMPILED = _compile()


def _strip_codes(raw):
    """'(17)Rock' -> 'Rock'; '(17)' -> 'Rock' (ID3v1 numbers)."""
    raw = (raw or "").strip()
    match = re.match(r"^\((\d{1,3})\)\s*(.*)$", raw) or re.match(r"^(\d{1,3})$", raw)
    if match:
        rest = match.group(2).strip() if match.lastindex and match.lastindex >= 2 else ""
        if rest:
            return rest
        number = int(match.group(1))
        return ID3_GENRES[number] if number < len(ID3_GENRES) else ""
    return raw


def canonical(raw):
    """Broad genre name for a raw tag, or None when the tag is empty."""
    cleaned = _strip_codes(raw)
    if not cleaned or cleaned.lower() in ("unknown", "other", "none", "genre", "misc", "n/a", "<unknown>"):
        return None
    folded = _fold(cleaned)
    for name, pattern in _COMPILED:
        if pattern.search(folded):
            return name
    tidy = re.sub(r"\s+", " ", cleaned).strip()
    return (tidy.title() if tidy.islower() or tidy.isupper() else tidy)[:32]
RULES_VERSION = "1"
