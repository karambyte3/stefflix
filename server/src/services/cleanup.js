// Removes library entries whose files are gone. Scans only mark missing files
// unavailable (so a file that comes back keeps its id and progress); this is the
// explicit "forget them" step, started from the TV's Settings screen.

/** Number of media files that are currently missing. */
export function countUnavailable(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM media WHERE available = 0').get().n;
}

/**
 * Deletes missing media files (their progress, subtitle offsets and subtitles go with them),
 * missing external subtitle files, and the seasons and series left without any file.
 * Returns how many rows of each kind were removed.
 */
export function removeUnavailable(db) {
  return db.transaction(() => {
    const media = db.prepare('DELETE FROM media WHERE available = 0').run().changes;
    const subtitles = db.prepare('DELETE FROM subtitles WHERE available = 0').run().changes;
    const seasons = db
      .prepare(
        `DELETE FROM seasons WHERE NOT EXISTS (
           SELECT 1 FROM media WHERE media.series_id = seasons.series_id AND media.season_number = seasons.season_number)`
      )
      .run().changes;
    const series = db
      .prepare('DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM media WHERE media.series_id = series.id)')
      .run().changes;
    return { media, subtitles, seasons, series };
  })();
}
