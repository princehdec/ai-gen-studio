import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import * as storage from '../storage/index.js';
import { badRequest, HttpError, nowISO, publicRow } from '../util.js';
import { insertGeneration, getGeneration, updateGeneration } from '../db.js';

export const enhance = Router();

const uploadRoot = path.join(config.storageDir, '.enhance-inputs');
fs.mkdirSync(uploadRoot, { recursive: true });
const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 2 },
});

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const realesrgan = process.env.REALESRGAN_PATH || '';
const propainterPython = process.env.PROPAINTER_PYTHON || 'python';
const propainterRoot = process.env.PROPAINTER_ROOT || '';

function run(command, args, { cwd, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new HttpError(504, `${path.basename(command)} timed out while processing the video.`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new HttpError(400, `Could not start ${path.basename(command)}. Configure the tool path or install it first.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' ');
      reject(new HttpError(422, `${path.basename(command)} failed${detail ? `: ${detail}` : '.'}`));
    });
  });
}

async function removeQuietly(file) {
  if (file) await fsp.rm(file, { recursive: true, force: true }).catch(() => {});
}

async function findNewestVideo(root, startedAt) {
  const found = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(mp4|mov|webm)$/i.test(entry.name)) {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs >= startedAt - 1000) found.push({ full, stat });
      }
    }
  }
  await walk(root);
  found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return found[0]?.full || null;
}

async function upscaleWithFfmpeg(input, output, scale) {
  await run(ffmpeg, [
    '-y', '-i', input,
    '-vf', `scale=iw*${scale}:ih*${scale}:flags=lanczos`,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
  ]);
}

async function probeFps(input) {
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1', input,
    ], { timeoutMs: 30000 });
    const fps = stdout.trim();
    return /^\d+(\/\d+)?$/.test(fps) ? fps : '30';
  } catch {
    return '30';
  }
}

async function upscaleWithRealEsrgan(input, output, scale) {
  if (!realesrgan) throw new HttpError(400, 'Real-ESRGAN is not configured. Set REALESRGAN_PATH, or choose FFmpeg HQ fallback.');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-gen-studio-upscale-'));
  const framesIn = path.join(work, 'in');
  const framesOut = path.join(work, 'out');
  await fsp.mkdir(framesIn);
  await fsp.mkdir(framesOut);
  try {
    const fps = await probeFps(input);
    await run(ffmpeg, ['-y', '-i', input, '-vsync', '0', path.join(framesIn, '%08d.png')]);
    await run(realesrgan, ['-i', framesIn, '-o', framesOut, '-s', String(scale), '-n', 'realesr-animevideov3']);
    await run(ffmpeg, [
      '-y', '-framerate', fps, '-i', path.join(framesOut, '%08d.png'), '-i', input,
      '-map', '0:v:0', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
    ]);
  } finally {
    await removeQuietly(work);
  }
}

async function cleanupWithProPainter(input, mask, output) {
  if (!propainterRoot) throw new HttpError(400, 'ProPainter is not configured. Set PROPAINTER_ROOT, then retry.');
  const script = path.join(propainterRoot, 'inference_propainter.py');
  if (!fs.existsSync(script)) throw new HttpError(400, 'ProPainter root is configured but inference_propainter.py was not found.');
  const startedAt = Date.now();
  await run(propainterPython, [script, '--video', input, '--mask', mask, '--fp16'], {
    cwd: propainterRoot,
    timeoutMs: 2 * 60 * 60 * 1000,
  });
  const result = await findNewestVideo(path.join(propainterRoot, 'results'), startedAt);
  if (!result) throw new HttpError(422, 'ProPainter completed without producing a video. Check the mask format and model weights.');
  await fsp.copyFile(result, output);
}

function assertVideo(file) {
  if (!file) throw badRequest('Choose a video file first.');
  if (!/^video\/(mp4|quicktime|webm)|\.(mp4|mov|webm)$/i.test(`${file.mimetype || ''}${file.originalname || ''}`)) {
    throw badRequest('Supported video formats are MP4, MOV and WebM.');
  }
}

function assertMask(file) {
  if (!file) throw badRequest('Cleanup mode needs a PNG/JPG mask image.');
  if (!/^image\/(png|jpeg|webp)$/i.test(file.mimetype || '')) throw badRequest('Mask must be a PNG, JPG or WebP image.');
}

enhance.get('/capabilities', (req, res) => {
  res.json({
    ffmpeg: Boolean(ffmpeg),
    realesrgan: Boolean(realesrgan),
    propainter: Boolean(propainterRoot),
  });
});

enhance.post('/', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'mask', maxCount: 1 }]), async (req, res, next) => {
  let input;
  let mask;
  let id = null;
  try {
    const video = req.files?.video?.[0];
    const maskFile = req.files?.mask?.[0];
    assertVideo(video);
    input = video.path;
    const mode = String(req.body?.mode || 'upscale');
    const scale = Number(req.body?.scale || 2);
    const method = String(req.body?.method || (mode === 'cleanup' ? 'propainter' : 'ffmpeg'));
    if (!['upscale', 'cleanup'].includes(mode)) throw badRequest('mode must be upscale or cleanup.');
    if (mode === 'upscale' && ![2, 4].includes(scale)) throw badRequest('Upscale must be 2x or 4x.');
    if (mode === 'cleanup') {
      if (req.body?.rightsConfirmed !== 'true') throw badRequest('Confirm that you own or are authorized to edit this video.');
      assertMask(maskFile);
      mask = maskFile.path;
    }

    id = randomUUID();
    const rel = storage.newRel('mp4');
    const output = path.join(config.storageDir, rel);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    insertGeneration({
      id, type: 'video', mode: mode === 'cleanup' ? 'cleanup' : 'upscale',
      prompt: mode === 'cleanup' ? 'Authorized video cleanup' : `${scale}x HQ upscale`,
      model: method, status: 'processing', settings: { local: true, method, scale: mode === 'upscale' ? scale : null },
    });

    if (mode === 'cleanup') await cleanupWithProPainter(input, mask, output);
    else if (method === 'realesrgan') await upscaleWithRealEsrgan(input, output, scale);
    else await upscaleWithFfmpeg(input, output, scale);

    const stat = await fsp.stat(output);
    updateGeneration(id, { file_path: rel, mime_type: 'video/mp4', file_size: stat.size, status: 'completed', completed_at: nowISO() });
    res.status(201).json(publicRow(getGeneration(id)));
  } catch (err) {
    if (err?.message && id) updateGeneration(id, { status: 'failed', error: err.message, completed_at: nowISO() });
    next(err);
  } finally {
    await removeQuietly(input);
    await removeQuietly(mask);
  }
});
