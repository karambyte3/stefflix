// Schema migrations. Each entry runs once, in order; the index of the last applied
// migration is stored in SQLite's `user_version`. Never edit a migration that has
// shipped - append a new one instead.
//
// Conventions:
// - Timestamps are integer milliseconds since the epoch.
// - `genres` columns hold a JSON array of strings.
// - Tables holding per-user data (progress, settings, subtitle offsets - later phases)
//   get a `profile_id INTEGER NOT NULL DEFAULT 1` column.

export const migrations = [
  // 1: library
  `
  CREATE TABLE series (
    id               INTEGER PRIMARY KEY,
    folder_key       TEXT    NOT NULL UNIQUE,  -- show folder path (identifies the show across scans)
    title            TEXT    NOT NULL,
    original_title   TEXT,
    sort_title       TEXT    NOT NULL,
    year             INTEGER,
    overview         TEXT,
    rating           REAL,
    genres           TEXT    NOT NULL DEFAULT '[]',
    poster           TEXT,
    backdrop         TEXT,
    tmdb_id          INTEGER,
    metadata_source  TEXT    NOT NULL DEFAULT 'filename',  -- filename | tmdb | manual
    available        INTEGER NOT NULL DEFAULT 1,
    added_at         INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL           -- when the newest episode was added
  );

  CREATE TABLE seasons (
    id             INTEGER PRIMARY KEY,
    series_id      INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    season_number  INTEGER NOT NULL,
    title          TEXT,
    overview       TEXT,
    poster         TEXT,
    UNIQUE (series_id, season_number)
  );

  -- Every playable file: movies, episodes and videos share one id space,
  -- which is the "mediaId" used by streaming, progress and subtitle offsets.
  CREATE TABLE media (
    id               INTEGER PRIMARY KEY,
    type             TEXT    NOT NULL CHECK (type IN ('movie', 'episode', 'video')),
    path             TEXT    NOT NULL UNIQUE,
    size             INTEGER NOT NULL,
    mtime_ms         INTEGER NOT NULL,
    available        INTEGER NOT NULL DEFAULT 1,
    added_at         INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,

    title            TEXT,                      -- may be NULL for episodes without a title
    original_title   TEXT,
    sort_title       TEXT,
    year             INTEGER,
    overview         TEXT,
    rating           REAL,
    runtime          INTEGER,                   -- minutes (metadata)
    genres           TEXT    NOT NULL DEFAULT '[]',
    poster           TEXT,
    backdrop         TEXT,
    still            TEXT,
    tmdb_id          INTEGER,
    metadata_source  TEXT    NOT NULL DEFAULT 'filename',

    series_id        INTEGER REFERENCES series(id),
    season_number    INTEGER,
    episode_number   INTEGER,
    category         TEXT,                      -- videos: first sub folder

    duration         REAL,                      -- seconds (ffprobe)
    probe            TEXT,                      -- JSON stream info (ffprobe)
    probed_mtime     INTEGER                    -- mtime_ms of the file when it was probed
  );

  CREATE INDEX media_type_available ON media (type, available);
  CREATE INDEX media_series ON media (series_id, season_number, episode_number);
  CREATE INDEX media_added ON media (added_at);
  `,

  // 2: TMDB metadata
  `
  -- Top 10 cast as JSON: [{ name, character, profile }]
  ALTER TABLE media  ADD COLUMN credits TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE series ADD COLUMN credits TEXT NOT NULL DEFAULT '[]';

  -- When TMDB was last asked about this item (NULL = never). Items that weren't
  -- found are retried after a while; matched items are not asked again.
  ALTER TABLE media  ADD COLUMN tmdb_checked_at INTEGER;
  ALTER TABLE series ADD COLUMN tmdb_checked_at INTEGER;

  -- Raw TMDB API responses, so re-scans don't hit the API again.
  CREATE TABLE tmdb_cache (
    key         TEXT    PRIMARY KEY,   -- request path + sorted query (without the API key)
    body        TEXT    NOT NULL,      -- JSON, or 'null' for a 404
    fetched_at  INTEGER NOT NULL
  );
  `,

  // 3: subtitles and user settings
  `
  -- External subtitle files found next to videos.
  CREATE TABLE subtitles (
    id          INTEGER PRIMARY KEY,
    media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    path        TEXT    NOT NULL UNIQUE,
    format      TEXT    NOT NULL,          -- srt | vtt
    language    TEXT,                      -- ISO 639-1 ("bg", "en"), NULL if unknown
    tags        TEXT    NOT NULL DEFAULT '[]', -- JSON, e.g. ["forced"], ["sdh"]
    size        INTEGER NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    available   INTEGER NOT NULL DEFAULT 1,
    added_at    INTEGER NOT NULL
  );
  CREATE INDEX subtitles_media ON subtitles (media_id);

  -- Per-profile settings as JSON values, e.g. key "subtitles".
  CREATE TABLE settings (
    profile_id  INTEGER NOT NULL DEFAULT 1,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    PRIMARY KEY (profile_id, key)
  );

  -- Subtitle sync fixes, per profile and media file.
  CREATE TABLE subtitle_offsets (
    profile_id      INTEGER NOT NULL DEFAULT 1,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    offset_seconds  REAL    NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (profile_id, media_id)
  );
  `,

  // 4: watch progress
  `
  CREATE TABLE progress (
    profile_id  INTEGER NOT NULL DEFAULT 1,
    media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    position    REAL    NOT NULL DEFAULT 0,  -- seconds; reset to 0 when the item is finished
    duration    REAL,                        -- as reported by the player
    watched     INTEGER NOT NULL DEFAULT 0,  -- finished at least once (stays 1 while re-watching)
    watched_at  INTEGER,
    play_count  INTEGER NOT NULL DEFAULT 0,  -- how many times it was finished
    updated_at  INTEGER NOT NULL,            -- last watched
    PRIMARY KEY (profile_id, media_id)
  );
  CREATE INDEX progress_recent ON progress (profile_id, updated_at);

  -- Where the end credits start (seconds). Unused until credits detection exists;
  -- when set, it counts as "finished" and triggers the next-episode card.
  ALTER TABLE media ADD COLUMN credits_at REAL;
  `,

  // 5: embedded subtitle streams (MKV/MP4) are listed next to the external files,
  // so the TV picks either kind by the same id. SQLite can't relax "path NOT NULL"
  // in place, hence the table rebuild.
  `
  CREATE TABLE subtitles_v5 (
    id            INTEGER PRIMARY KEY,
    media_id      INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    path          TEXT    UNIQUE,            -- external file; NULL for an embedded stream
    stream_index  INTEGER,                   -- embedded: the stream's index in the video file
    title         TEXT,                      -- embedded: track title from the container
    format        TEXT    NOT NULL,          -- files: srt | vtt; embedded: codec (subrip, ass, mov_text...)
    language      TEXT,                      -- ISO 639-1 ("bg", "en"), NULL if unknown
    tags          TEXT    NOT NULL DEFAULT '[]',
    size          INTEGER NOT NULL,          -- embedded: size/mtime of the video file
    mtime_ms      INTEGER NOT NULL,
    available     INTEGER NOT NULL DEFAULT 1,
    added_at      INTEGER NOT NULL,
    UNIQUE (media_id, stream_index)
  );
  INSERT INTO subtitles_v5 (id, media_id, path, format, language, tags, size, mtime_ms, available, added_at)
    SELECT id, media_id, path, format, language, tags, size, mtime_ms, available, added_at FROM subtitles;
  DROP TABLE subtitles;
  ALTER TABLE subtitles_v5 RENAME TO subtitles;
  CREATE INDEX subtitles_media ON subtitles (media_id);

  -- Probe every file again, so its embedded subtitle streams get listed.
  UPDATE media SET probed_mtime = NULL;
  `,
];
