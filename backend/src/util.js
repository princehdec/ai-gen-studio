import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, { retryable = false, retryAfterSec = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSec = retryAfterSec;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);

export const nowISO = () => new Date().toISOString();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `data:<mime>;base64,<payload>` URL into its parts; throws HttpError 400 if malformed. */
export function parseDataUrl(dataUrl, label = 'image') {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw badRequest(`${label} must be a base64 data URL (got something else).`);
  }
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw badRequest(`${label} is not a valid base64 data URL.`);
  const [, mime, b64] = match;
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw badRequest(`${label} is empty.`);
  return { mime, buffer };
}

export const EXT_FOR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
};

export const MIME_FOR_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
};

export function extForMime(mime, fallback = 'bin') {
  return EXT_FOR_MIME[(mime || '').split(';')[0].trim().toLowerCase()] ?? fallback;
}

export function mimeForExt(ext) {
  return MIME_FOR_EXT[(ext || '').toLowerCase()] ?? 'application/octet-stream';
}

/** Shape a raw DB row for the frontend (parses settings JSON, adds file_url). */
export function publicRow(row) {
  if (!row) return null;
  let settings = null;
  try {
    settings = row.settings ? JSON.parse(row.settings) : null;
  } catch {
    settings = null;
  }
  return {
    id: row.id,
    type: row.type,
    mode: row.mode,
    prompt: row.prompt,
    model: row.model,
    status: row.status,
    error: row.error,
    cost: row.cost,
    file_url: row.file_path ? `/files/${row.file_path}` : null,
    mime_type: row.mime_type,
    file_size: row.file_size,
    settings,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}
