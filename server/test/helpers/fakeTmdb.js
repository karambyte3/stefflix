// A tiny stand-in for the TMDB API and image CDN, used by the tests (and handy for
// trying the UI without an API key - see README). Canned data covers the cases the
// matcher has to handle: Bulgarian text with English fallback, ambiguous titles,
// generic episode names and not-found titles.
import http from 'node:http';
import { deflateSync } from 'node:zlib';

export const FAKE_API_KEY = 'test-key';

function cast(names) {
  return names.map((name, i) => ({ name, character: `Роля ${i + 1}`, profile_path: `/person${i + 1}.jpg` }));
}

function english(title, overview) {
  return { translations: [{ iso_639_1: 'en', iso_3166_1: 'US', data: { title, name: title, overview } }] };
}

const MOVIES = {
  603: {
    id: 603,
    title: 'Матрицата',
    original_title: 'The Matrix',
    overview: '', // no Bulgarian overview -> English fallback
    release_date: '1999-03-30',
    runtime: 136,
    vote_average: 8.2,
    vote_count: 25000,
    genres: [{ id: 28, name: 'Екшън' }, { id: 878, name: 'Научна фантастика' }],
    poster_path: '/matrix.jpg',
    backdrop_path: '/matrix-bd.jpg',
    credits: { cast: cast(['Киану Рийвс', 'Лорънс Фишбърн', 'Кари-Ан Мос', 'Хюго Уийвинг', 'Джо Пантолиано', 'Маркъс Чонг', 'Глория Фостър', 'Мат Доран', 'Белинда Макклори', 'Антъни Рей Паркър', 'Пол Годар', 'Робърт Тейлър']) },
    translations: english('The Matrix', 'A hacker learns the truth about his reality.'),
  },
  1001: {
    id: 1001,
    title: 'Heat',
    original_title: 'Heat',
    overview: 'Друг филм със същото име.',
    release_date: '1986-01-01',
    genres: [],
    poster_path: null,
    backdrop_path: null,
    credits: { cast: [] },
    translations: english('Heat', ''),
  },
  949: {
    id: 949,
    title: 'Жега',
    original_title: 'Heat',
    overview: 'Обирджия и детектив в Лос Анджелис.',
    release_date: '1995-12-15',
    runtime: 170,
    vote_average: 7.9,
    vote_count: 7000,
    genres: [{ id: 80, name: 'Криминален' }, { id: 18, name: 'Драма' }],
    poster_path: '/heat.jpg',
    backdrop_path: '/heat-bd.jpg',
    credits: { cast: cast(['Ал Пачино', 'Робърт Де Ниро', 'Вал Килмър']) },
    translations: english('Heat', 'A group of professional bank robbers...'),
  },
  550: {
    id: 550,
    title: 'Боен клуб',
    original_title: 'Fight Club',
    overview: 'Безсънен служител и сапунен търговец.',
    release_date: '1999-10-15',
    runtime: 139,
    vote_average: 8.4,
    vote_count: 30000,
    genres: [{ id: 18, name: 'Драма' }],
    poster_path: '/fightclub.jpg',
    backdrop_path: '/fightclub-bd.jpg',
    credits: { cast: cast(['Едуард Нортън', 'Брад Пит']) },
    translations: english('Fight Club', 'An insomniac office worker...'),
  },
};

const SHOWS = {
  1396: {
    id: 1396,
    name: 'Breaking Bad',
    original_name: 'Breaking Bad',
    overview: 'Учител по химия започва да произвежда метамфетамин.',
    first_air_date: '2008-01-20',
    vote_average: 8.9,
    vote_count: 15000,
    genres: [{ id: 18, name: 'Драма' }, { id: 80, name: 'Криминален' }],
    poster_path: '/bb.jpg',
    backdrop_path: '/bb-bd.jpg',
    credits: { cast: cast(['Брайън Кранстън', 'Арън Пол', 'Анна Гън']) },
    translations: english('Breaking Bad', 'A chemistry teacher turns to crime.'),
  },
  70523: {
    id: 70523,
    name: 'Тъмно',
    original_name: 'Dark',
    overview: 'Изчезването на две деца в германско градче.',
    first_air_date: '2017-12-01',
    vote_average: 8.4,
    vote_count: 6000,
    genres: [{ id: 18, name: 'Драма' }, { id: 9648, name: 'Мистерия' }],
    poster_path: '/dark.jpg',
    backdrop_path: '/dark-bd.jpg',
    credits: { cast: cast(['Луис Хофман', 'Оливер Мазучи']) },
    translations: english('Dark', 'A missing child sets four families on a frantic hunt.'),
  },
};

// Bulgarian episode names: real for a few, TMDB's generic "Епизод N" for the rest.
const BG_EPISODE_NAMES = { '1396/1/1': 'Пилотен епизод', '70523/1/1': 'Тайни' };

function season(showId, number, language) {
  const bg = language === 'bg-BG';
  const episodes = [];
  for (let n = 1; n <= 10; n++) {
    const key = `${showId}/${number}/${n}`;
    episodes.push({
      id: Number(`${showId}${number}${n}`),
      episode_number: n,
      name: bg ? BG_EPISODE_NAMES[key] || `Епизод ${n}` : `Chapter ${n}`,
      overview: bg ? (n === 1 ? 'Описание на първия епизод.' : '') : `English overview of episode ${n}.`,
      still_path: `/still-${showId}-${number}-${n}.jpg`,
      runtime: 47,
      air_date: '2008-01-20',
      vote_average: 8,
      vote_count: 10,
    });
  }
  return {
    name: bg ? `Сезон ${number}` : `Season ${number}`,
    overview: bg ? '' : `English overview of season ${number}.`,
    poster_path: `/season-${showId}-${number}.jpg`,
    episodes,
  };
}

function search(list, query, titleKeys, dateKey, year) {
  const q = query.toLowerCase();
  return Object.values(list)
    .filter((item) => titleKeys.some((key) => item[key].toLowerCase().includes(q)))
    .filter((item) => !year || item[dateKey].startsWith(String(year)))
    .map((item) => ({ id: item.id, [titleKeys[0]]: item[titleKeys[0]], [titleKeys[1]]: item[titleKeys[1]], [dateKey]: item[dateKey] }));
}

// --- images -------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A diagonal two-colour PNG, coloured by the file name, so each "image" looks different. */
function png(width, height, seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const a = [(hash & 0xff) | 0x40, ((hash >> 8) & 0xff) | 0x20, (hash >> 16) & 0xff];
  const b = a.map((v) => v >> 2);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const color = x / width + y / height < 1 ? a : b;
      raw[row + 1 + x * 3] = color[0];
      raw[row + 2 + x * 3] = color[1];
      raw[row + 3 + x * 3] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMAGE_SHAPES = { w342: [342, 513], w185: [185, 278], w300: [300, 169], w1280: [1280, 720] };

// --- server -------------------------------------------------------------------------

/** Starts the fake on a free port. Returns { apiUrl, imageUrl, requests, close }. */
export function startFakeTmdb(port) {
  const requests = []; // "path?query" of every API call (without the key)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    const image = /^\/t\/p\/(w\d+)\/(.+)$/.exec(url.pathname);
    if (image) {
      const shape = IMAGE_SHAPES[image[1]];
      if (!shape) return send(404, {});
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png(shape[0], shape[1], image[2]));
    }

    const authorised =
      url.searchParams.get('api_key') === FAKE_API_KEY || req.headers.authorization === `Bearer ${FAKE_API_KEY}`;
    if (!authorised) return send(401, { status_message: 'Invalid API key' });

    url.searchParams.delete('api_key');
    const path = url.pathname.replace(/^\/3/, '');
    requests.push(`${path}?${url.searchParams}`);
    const q = url.searchParams;
    let match;

    if (path === '/search/movie') {
      return send(200, { results: search(MOVIES, q.get('query'), ['title', 'original_title'], 'release_date', q.get('year')) });
    }
    if (path === '/search/tv') {
      return send(200, {
        results: search(SHOWS, q.get('query'), ['name', 'original_name'], 'first_air_date', q.get('first_air_date_year')),
      });
    }
    if ((match = /^\/movie\/(\d+)$/.exec(path))) {
      return MOVIES[match[1]] ? send(200, MOVIES[match[1]]) : send(404, {});
    }
    if ((match = /^\/tv\/(\d+)$/.exec(path))) {
      return SHOWS[match[1]] ? send(200, SHOWS[match[1]]) : send(404, {});
    }
    if ((match = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(path))) {
      return SHOWS[match[1]] ? send(200, season(match[1], Number(match[2]), q.get('language'))) : send(404, {});
    }
    send(404, {});
  });

  return new Promise((resolve) => {
    server.listen(port || 0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        apiUrl: `${base}/3`,
        imageUrl: `${base}/t/p`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
