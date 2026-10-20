// Persistent app settings (localStorage).

const SERVER_KEY = 'homestream.serverUrl';

/**
 * Normalises user input like "192.168.1.10:3000" or "http://pc.local:3000/"
 * into "http://192.168.1.10:3000". Returns null if it can't be parsed.
 */
export function normalizeServerAddress(input) {
  let value = (input || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;

  const match = /^(https?):\/\/([^\/:\s]+)(?::(\d{1,5}))?\/?$/i.exec(value);
  if (!match) return null;

  const protocol = match[1].toLowerCase();
  const host = match[2];
  const port = match[3] || '3000';
  return `${protocol}://${host}:${port}`;
}

export function getServerUrl() {
  try {
    return localStorage.getItem(SERVER_KEY) || null;
  } catch (e) {
    return null;
  }
}

export function setServerUrl(url) {
  localStorage.setItem(SERVER_KEY, url);
}

/** A sensible pre-filled value: when served by the Vite dev server, the server is usually on the same PC. */
export function suggestedServerAddress() {
  if (location.protocol === 'http:' && location.hostname) {
    return `${location.hostname}:3000`;
  }
  return '';
}
