// Generates the app's brand images:
// - the transparent navbar logo from assets/stefflix-logo.webp (red wordmark on a transparent background)
// - the webOS launcher icons from assets/stefflix-icon.webp (shaded red "S" on a white background),
//   with the white keyed out and the "S" placed on a dark background.
// Needs ffmpeg/ffprobe on PATH to decode the sources. Run with `npm run icons`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(appDir, 'public');
const SOURCE = path.join(appDir, 'assets', 'stefflix-logo.webp');
const ICON_SOURCE = path.join(appDir, 'assets', 'stefflix-icon.webp');

const ICON_BG = '0x141414';
const ICON_SCALE = 0.875; // share of the icon taken by the (square) source image
const LOGO_HEIGHT = 112; // shown at 56px in the navbar, 2x for sharper scaling

// --- PNG encoding -------------------------------------------------------------

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

/** Encodes RGBA pixels (Uint8Array, width*height*4) as a PNG. */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => (raw[row + 1 + i] = v));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- reading the source logo ----------------------------------------------------

function readSource() {
  const [width, height] = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', SOURCE,
  ]).toString().trim().split(',').map(Number);
  const rgba = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', SOURCE, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  return { width, height, rgba };
}

/** The logo is a single colour, so keep its coverage and sample that colour once. */
function extractAlpha({ width, height, rgba }) {
  const alpha = new Float32Array(width * height);
  const sum = [0, 0, 0];
  let solid = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    alpha[i] = a < 0.04 ? 0 : a;
    if (a > 0.98) {
      for (let c = 0; c < 3; c++) sum[c] += rgba[i * 4 + c];
      solid++;
    }
  }
  const color = sum.map((s) => Math.round(s / solid));
  return { width, height, alpha, color };
}

/** Bounding box of the non-transparent pixels. */
function boundingBox({ width, height, alpha }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Box-filter downscale of a region of the alpha map to outW x outH. */
function resample(logo, box, outW, outH) {
  const out = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = box.y + Math.floor((oy * box.h) / outH);
    const sy1 = Math.max(sy0 + 1, box.y + Math.floor(((oy + 1) * box.h) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = box.x + Math.floor((ox * box.w) / outW);
      const sx1 = Math.max(sx0 + 1, box.x + Math.floor(((ox + 1) * box.w) / outW));
      let total = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) total += logo.alpha[y * logo.width + x];
      }
      out[oy * outW + ox] = total / ((sy1 - sy0) * (sx1 - sx0));
    }
  }
  return out;
}

// --- outputs ------------------------------------------------------------------------

function navbarLogo(logo) {
  const box = boundingBox(logo);
  const outH = LOGO_HEIGHT;
  const outW = Math.round((box.w * outH) / box.h);
  const alpha = resample(logo, box, outW, outH);
  const rgba = new Uint8Array(outW * outH * 4);
  alpha.forEach((a, i) => {
    rgba.set(logo.color, i * 4);
    rgba[i * 4 + 3] = Math.round(a * 255);
  });
  return png(outW, outH, rgba);
}

/** Keys out the white background of the icon source and centres it on a dark size x size square. */
function launcherIcon(size, file) {
  const inner = Math.round(size * ICON_SCALE);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-i', ICON_SOURCE,
    '-f', 'lavfi', '-i', `color=c=${ICON_BG}:s=${size}x${size}`,
    '-filter_complex',
    `[0]format=rgba,colorkey=0xFFFFFF:0.3:0.2,scale=${inner}:${inner}:flags=lanczos[fg];` +
      '[1][fg]overlay=(W-w)/2:(H-h)/2,format=rgba',
    '-frames:v', '1', path.join(publicDir, file),
  ]);
}

const logo = extractAlpha(readSource());
writeFileSync(path.join(publicDir, 'logo.png'), navbarLogo(logo));
launcherIcon(80, 'icon.png');
launcherIcon(130, 'largeIcon.png');
console.log('Logo and icons written to tv-app/public/ (logo colour rgb(' + logo.color.join(', ') + '))');
