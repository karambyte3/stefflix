// A stand-in for the OpenSubtitles.com REST API, used by the tests.
// Knows one movie (TMDB 603) and one episode (series TMDB 1399, S01E02).
import http from 'node:http';

export const FAKE_OS_KEY = 'os-key';
export const FAKE_OS_USER = { username: 'stefan', password: 'secret' };

const BG_SRT = '1\n00:00:01,000 --> 00:00:02,500\nЗдравей, Нео.\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Следвай белия заек.</i>\n';
const EN_SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello, Neo.\n';

function item(fileId, attributes) {
  return {
    id: String(fileId),
    type: 'subtitle',
    attributes: {
      language: 'bg',
      download_count: 0,
      hearing_impaired: false,
      foreign_parts_only: false,
      ai_translated: false,
      machine_translated: false,
      moviehash_match: false,
      release: `Release ${fileId}`,
      files: [{ file_id: fileId, cd_number: 1, file_name: `${fileId}.srt` }],
      ...attributes,
    },
  };
}

const FILES = { 101: BG_SRT, 102: BG_SRT, 103: EN_SRT, 104: BG_SRT, 201: BG_SRT, 999: 'no cues here' };

/**
 * Starts the fake API. `state.hash` is the movie hash that counts as a match.
 * Returns { url, requests, state, close }.
 */
export function startFakeOpenSubtitles() {
  const requests = [];
  const state = { hash: null, anonymousDownloads: 1, userDownloads: 5 };
  let base;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, base);
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: json });
      const send = (status, data, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(type === 'application/json' ? JSON.stringify(data) : data);
      };

      if (url.pathname.startsWith('/files/')) {
        const id = url.pathname.slice('/files/'.length).replace('.srt', '');
        send(200, FILES[id], 'text/plain; charset=utf-8');
        return;
      }
      if (req.headers['api-key'] !== FAKE_OS_KEY) return send(401, { message: 'Invalid API key' });
      if (!/^HomeStream v/.test(req.headers['user-agent'] || '')) return send(403, { message: 'Missing User-Agent' });

      if (req.method === 'POST' && url.pathname === '/api/v1/login') {
        if (json.username !== FAKE_OS_USER.username || json.password !== FAKE_OS_USER.password) {
          return send(401, { message: 'Invalid username/password' });
        }
        return send(200, { token: 'user-token', base_url: '127.0.0.1', user: { allowed_downloads: 20 }, status: 200 });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/subtitles') {
        const q = Object.fromEntries(url.searchParams);
        const keys = Object.keys(q);
        if (keys.join() !== [...keys].sort().join()) return send(400, { message: 'parameters must be sorted' });
        const langs = (q.languages || '').split(',');
        let data = [];
        if (q.tmdb_id === '603') {
          data = [
            item(101, { download_count: 500 }),
            item(102, { download_count: 50, moviehash_match: q.moviehash === state.hash }),
            item(103, { language: 'en', download_count: 9000 }),
            item(104, { download_count: 900, machine_translated: true }),
            item(105, { files: [{ file_id: 105, cd_number: 1 }, { file_id: 106, cd_number: 2 }] }), // 2 CDs
            item(107, { language: 'pt-BR', download_count: 1 }),
          ];
          // A moviehash search returns only the hash matches here (the service also searches without it).
          if (q.moviehash && q.moviehash !== state.hash) data = [];
          else if (q.moviehash) data = data.filter((d) => d.attributes.moviehash_match);
        } else if (q.parent_tmdb_id === '1399' && q.season_number === '1' && q.episode_number === '2') {
          data = [item(201, { hearing_impaired: true, download_count: 10 })];
        }
        data = data.filter((d) => langs.includes(d.attributes.language.toLowerCase()));
        return send(200, { total_count: data.length, total_pages: 1, page: 1, data });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/download') {
        const user = req.headers.authorization === 'Bearer user-token';
        const left = user ? state.userDownloads : state.anonymousDownloads;
        if (left <= 0) return send(406, { message: 'You have downloaded your allowed subtitles for 24h', remaining: 0, reset_time_utc: '2026-10-20T00:00:00Z' });
        if (user) state.userDownloads--;
        else state.anonymousDownloads--;
        return send(200, { link: `${base}/files/${json.file_id}.srt`, file_name: `${json.file_id}.srt`, remaining: left - 1, reset_time_utc: '2026-10-20T00:00:00Z' });
      }
      send(404, { message: 'Not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: `${base}/api/v1`, requests, state, close: () => server.close() });
    });
  });
}
