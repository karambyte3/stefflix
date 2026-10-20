import { config } from './config.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startFreshScan, startScan } from './services/libraryScan.js';
import { watchMediaFolders } from './services/watcher.js';
import { getLanAddresses } from './utils/network.js';

// Exit code the desktop app (desktop/) recognises as "the port is taken" - it doesn't retry then.
const EXIT_PORT_IN_USE = 3;

// Set when the desktop app runs the server as an Electron utility process.
const desktopApp = process.parentPort;
// Where the user changes the settings.
const settingsPlace = desktopApp ? 'Stefflix -> Settings' : 'server/.env';

initDb(config.dbFile);

const app = createApp();

// No host argument: Node listens on all interfaces, IPv4 and IPv6 (dual-stack),
// so "localhost" (which resolves to ::1 first on Windows) responds instantly too.
// Express 5 also calls this on a listen error - that's handled by server.on('error') below.
const server = app.listen(config.port, (err) => {
  if (err) return;
  const addresses = getLanAddresses();
  const [primary, ...others] = addresses;

  console.log('');
  if (primary) {
    console.log(`Server running at http://${primary.address}:${config.port}`);
    console.log(`  -> on the TV enter: ${primary.address}:${config.port}`);
    for (const other of others) {
      console.log(`  (also reachable at http://${other.address}:${config.port} - ${other.name})`);
    }
  } else {
    console.log(`Server running at http://localhost:${config.port} (no LAN address found)`);
  }
  console.log('');

  const folders = [
    ['MEDIA_MOVIES', config.mediaMovies],
    ['MEDIA_SERIES', config.mediaSeries],
    ['MEDIA_VIDEOS', config.mediaVideos],
  ];
  for (const [name, paths] of folders) {
    console.log(`${name}: ${paths.length ? paths.join(' ; ') : '(not set)'}`);
  }
  if (folders.every(([, paths]) => !paths.length)) {
    console.warn(`! No media folders configured - set MEDIA_MOVIES / MEDIA_SERIES / MEDIA_VIDEOS in ${settingsPlace}`);
  }

  desktopApp?.postMessage({
    type: 'listening',
    port: config.port,
    addresses: addresses.map(({ name, address }) => ({ name, address })),
  });

  // The API is usable while the scan runs; lists fill in when it finishes.
  startScan();

  if (config.watchFolders) {
    watchMediaFolders([...config.mediaMovies, ...config.mediaSeries, ...config.mediaVideos], () => {
      console.log('Media folders changed - rescanning');
      return startFreshScan();
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Change PORT in ${settingsPlace}.`);
    process.exit(EXIT_PORT_IN_USE);
  }
  throw err;
});
