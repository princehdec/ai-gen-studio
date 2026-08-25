import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const abs = (rel) => path.join(config.storageDir, rel);

/**
 * Relative storage path like `2026-08/<uuid>.mp4` — grouped by month,
 * stored with forward slashes so it doubles as a URL fragment.
 */
export function newRel(ext) {
  const d = new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${month}/${randomUUID()}.${ext}`;
}

export async function saveBuffer(buffer, rel) {
  const target = abs(rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return buffer.length;
}

export async function saveWebStream(webStream, rel) {
  const target = abs(rel);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(webStream), createWriteStream(target));
  } catch (err) {
    await unlink(target).catch(() => {});
    throw err;
  }
  const { size } = await stat(target);
  return size;
}

export async function remove(rel) {
  await unlink(abs(rel)).catch((err) => {
    if (err?.code !== 'ENOENT') throw err;
  });
}
