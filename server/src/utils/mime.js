import path from 'node:path';

const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

export const VIDEO_EXTENSIONS = Object.keys(VIDEO_MIME_TYPES);

export function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function videoMimeType(filePath) {
  return VIDEO_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}
