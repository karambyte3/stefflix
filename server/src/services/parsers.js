// Turns file and folder names into titles, years, season and episode numbers.
// Pure functions - see test/parsers.test.js for the supported naming styles.

// Release-name junk that ends the title part of a name like "Title.2010.1080p.BluRay.x264".
const JUNK_TOKEN =
  /^(?:480p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr|hdr10|dv|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web-dl|webdl|web|hdtv|hdrip|remux|x264|x265|h264|h265|hevc|avc|xvid|divx|aac|ac3|dts|ddp?5\.1|10bit|proper|repack|extended|unrated|remastered|multi|subbed|dubbed)$/i;

const YEAR = '(?:19|20)\\d{2}';

/** "The.Movie_Name  -" -> "The Movie Name" */
export function cleanName(name) {
  return name
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
    .trim();
}

/** Cuts the name at the first release-junk token ("Title 1080p BluRay" -> "Title"). */
function stripJunk(name) {
  const words = name.split(' ');
  const end = words.findIndex((word) => JUNK_TOKEN.test(word.replace(/[[\]()]/g, '')));
  return (end === -1 ? words : words.slice(0, end)).join(' ').trim();
}

/**
 * Lower-cased key for ORDER BY. Leading English articles are ignored and numbers are
 * zero-padded, so "Part 2" sorts before "Part 10".
 */
export function sortTitle(title) {
  return (title || '')
    .toLocaleLowerCase('bg')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\d+/g, (digits) => digits.padStart(6, '0'))
    .trim();
}

/**
 * "Title (2010)", "Title [2010]", "Title.2010.1080p.BluRay" -> { title, year }.
 * Returns year: null if the name contains no year.
 */
export function parseTitleYear(rawName) {
  const name = cleanName(rawName);

  // Year in brackets wins: "Blade Runner 2049 (2017)".
  let match = new RegExp(`^(.+?)\\s*[(\\[](${YEAR})[)\\]]`).exec(name);
  if (!match) {
    // Bare year: take the last one, so "Blade Runner 2049 2017 1080p" keeps 2049 in the title.
    match = new RegExp(`^(.+)\\s(${YEAR})(?=\\s|$)`).exec(name);
  }
  if (match && match[1].trim()) {
    return { title: stripJunk(cleanName(match[1])) || cleanName(match[1]), year: Number(match[2]) };
  }
  return { title: stripJunk(name) || name, year: null };
}

/**
 * Movie from its file name, falling back to the parent folder for the year:
 * "Movies/Title (2010)/movie.mkv" -> { title: "Title", year: 2010 }.
 */
export function parseMovie(fileBaseName, parentFolderName) {
  const fromFile = parseTitleYear(fileBaseName);
  if (fromFile.year || !parentFolderName) return fromFile;

  const fromFolder = parseTitleYear(parentFolderName);
  return fromFolder.year ? fromFolder : fromFile;
}

const SEASON_FOLDER = /^(?:season|сезон|series|s)\s*(\d{1,3})$/i;
const SPECIALS_FOLDER = /^(?:specials?|extras?|специални)$/i;

/** "Season 01" -> 1, "Specials" -> 0, anything else -> null */
export function parseSeasonFolder(folderName) {
  const name = cleanName(folderName);
  const match = SEASON_FOLDER.exec(name);
  if (match) return Number(match[1]);
  if (SPECIALS_FOLDER.test(name)) return 0;
  return null;
}

const EPISODE_PATTERNS = [
  /(?:^|[\s._\-\[(])[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})(?:[-]?[Ee]\d{1,4})*/, // S01E02, s1e2, S01E01E02
  /(?:^|[\s._\-\[(])(\d{1,2})x(\d{1,3})(?=$|[\s._\-\])])/, // 1x02
];

/**
 * Episode numbers and title from a file name.
 * "Show Name S01E02 - Pilot" -> { season: 1, episode: 2, showPart: "Show Name", title: "Pilot" }.
 * `folderSeason` (from "Season 01") is used for names like "Show - E05" or "05 - Title".
 * Returns null if no episode number can be found.
 */
export function parseEpisode(fileBaseName, folderSeason) {
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(fileBaseName);
    if (match) {
      const before = fileBaseName.slice(0, match.index);
      const after = fileBaseName.slice(match.index + match[0].length);
      return {
        season: Number(match[1]),
        episode: Number(match[2]),
        showPart: stripJunk(cleanName(before)) || null,
        title: stripJunk(cleanName(after)) || null,
      };
    }
  }

  if (folderSeason != null) {
    // "Show - E05 - Title", "Episode 5", or a leading number "05 - Title".
    const match =
      /(?:^|[\s._\-])(?:e|ep|episode|епизод)\s*(\d{1,4})(?=$|[\s._\-])/i.exec(fileBaseName) ||
      /^(\d{1,3})(?=$|[\s._\-])/.exec(fileBaseName);
    if (match) {
      const after = fileBaseName.slice(match.index + match[0].length);
      return {
        season: folderSeason,
        episode: Number(match[1]),
        showPart: null,
        title: stripJunk(cleanName(after)) || null,
      };
    }
  }

  return null;
}
