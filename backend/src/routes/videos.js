import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import * as or from '../openrouter.js';
import * as storage from '../storage/index.js';
import {
  HttpError,
  badRequest,
  extForMime,
  mimeForExt,
  nowISO,
  parseDataUrl,
  publicRow,
} from '../util.js';
import { getGeneration, insertGeneration, updateGeneration } from '../db.js';
import { requireProvider, runHuggingFaceTask } from '../providers/index.js';

export const videos = Router();

const RESOLUTIONS = ['480p', '720p', '768p', '1080p'];
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'];
const MODES = ['t2v', 'i2v', 'first_last', 'reference'];

// Models list must be registered before the '/:id' route so "models" is not
// treated as an id.
videos.get('/models', async (req, res, next) => {
  try {
    const providerId = req.query.provider || 'openrouter';
    if (providerId === 'openrouter') {
      return res.json({ models: await or.getModels('video'), default_model: config.defaults.videoModel });
    }
    const provider = requireProvider(providerId, 'video');
    return res.json({ models: provider.id === 'huggingface' ? [
      { id: 'Wan-AI/Wan2.2-TI2V-5B', name: 'Wan 2.2 TI2V 5B' },
      { id: 'tencent/HunyuanVideo', name: 'Tencent HunyuanVideo' },
      { id: 'Lightricks/LTX-Video-0.9.8-13B-distilled', name: 'LTX Video 0.9.8' },
    ] : [], default_model: '' });
  } catch (err) { next(err); }
});

videos.post('/', async (req, res, next) => {
  try {
    const {
      prompt,
      model,
      provider = 'openrouter',
      mode = 't2v',
      duration,
      resolution,
      aspect_ratio,
      generate_audio = true,
      first_frame,
      last_frame,
      references,
    } = req.body ?? {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw badRequest('A prompt is required.');
    }
    if (!MODES.includes(mode)) {
      throw badRequest(`mode must be one of: ${MODES.join(', ')}.`);
    }

    const providerConfig = requireProvider(provider, 'video');
    if (providerConfig.id === 'huggingface' && mode !== 't2v') {
      throw badRequest('Hugging Face video currently supports text-to-video only; use Text → Video mode.');
    }

    const body = {
      model: (model || config.defaults.videoModel).trim(),
      prompt: prompt.trim(),
      generate_audio: Boolean(generate_audio),
    };
    const settings = {
      mode,
      provider: providerConfig.id,
      duration: null,
      resolution: null,
      aspect_ratio: null,
      generate_audio: Boolean(generate_audio),
      inputs: 0,
    };

    if (duration != null && duration !== '') {
      const secs = Number(duration);
      if (!Number.isInteger(secs) || secs < 4 || secs > 15) {
        throw badRequest('duration must be a whole number of seconds between 4 and 15.');
      }
      body.duration = secs;
      settings.duration = secs;
    }
    if (resolution) {
      if (!RESOLUTIONS.includes(resolution)) {
        throw badRequest(`resolution must be one of: ${RESOLUTIONS.join(', ')}.`);
      }
      body.resolution = resolution;
      settings.resolution = resolution;
    }
    if (aspect_ratio) {
      if (!ASPECT_RATIOS.includes(aspect_ratio)) {
        throw badRequest(`aspect_ratio must be one of: ${ASPECT_RATIOS.join(', ')}.`);
      }
      body.aspect_ratio = aspect_ratio;
      settings.aspect_ratio = aspect_ratio;
    }

    if (mode === 'i2v' || mode === 'first_last') {
      if (!first_frame) throw badRequest(`${mode} requires a first frame image.`);
      const frames = [{ type: 'image_url', image_url: { url: asDataUrl(first_frame, 'First frame') }, frame_type: 'first_frame' }];
      if (mode === 'first_last') {
        if (!last_frame) throw badRequest('first_last requires both a first and a last frame image.');
        frames.push({ type: 'image_url', image_url: { url: asDataUrl(last_frame, 'Last frame') }, frame_type: 'last_frame' });
      }
      // frame_images takes precedence on the provider side and marks this as image-to-video.
      body.frame_images = frames;
      settings.inputs = frames.length;
    } else if (mode === 'reference') {
      const refs = Array.isArray(references) ? references : [];
      if (!refs.length) throw badRequest('reference mode requires at least one reference image.');
      body.input_references = refs.map((r, i) => ({
        type: 'image_url',
        image_url: { url: asDataUrl(r, `Reference image ${i + 1}`) },
      }));
      settings.inputs = refs.length;
    }

    const id = randomUUID();
    insertGeneration({
      id,
      type: 'video',
      mode,
      prompt: body.prompt,
      model: body.model,
      status: 'pending',
      settings,
    });

    try {
      if (providerConfig.id === 'huggingface') {
        const result = await runHuggingFaceTask(providerConfig, 'text-to-video', body.model, body.prompt, {
          num_frames: Math.max(1, Math.round((settings.duration || 6) * 8)),
        });
        const ext = extForMime(result.contentType, 'mp4');
        const rel = storage.newRel(ext);
        const size = await storage.saveBuffer(result.buffer, rel);
        updateGeneration(id, {
          file_path: rel,
          mime_type: result.contentType || mimeForExt(ext),
          file_size: size,
          status: 'completed',
          completed_at: nowISO(),
        });
      } else {
        const job = await or.createVideoJob(body);
        updateGeneration(id, {
          provider_job_id: job?.id ?? null,
          status: 'processing',
          provider_checked_at: nowISO(),
        });
      }
    } catch (err) {
      updateGeneration(id, { status: 'failed', error: err.message, completed_at: nowISO() });
      throw err;
    }

    res.status(201).json(publicRow(getGeneration(id)));
  } catch (err) { next(err); }
});

videos.get('/:id', async (req, res, next) => {
  try {
    let row = getGeneration(req.params.id);
    if (!row) throw new HttpError(404, 'Generation not found.');
    if (row.type === 'video' && ['pending', 'processing'].includes(row.status)) {
      row = (await advanceVideoJob(row).catch((err) => {
        // Transient poll/download failures must not kill the job — the next
        // poll retries. The timeout policy eventually fails stuck jobs.
        console.warn(`[video ${row.id}] poll error:`, err.message);
        return getGeneration(row.id);
      })) ?? row;
    }
    res.json(publicRow(row));
  } catch (err) { next(err); }
});

/**
 * Poll OpenRouter once for this job; if it just completed, download the
 * content immediately to permanent storage.
 */
async function advanceVideoJob(row) {
  const ageMin = (Date.now() - Date.parse(row.created_at)) / 60000;
  if (ageMin > config.videoTimeoutMin) {
    return updateGeneration(row.id, {
      status: 'failed',
      error: `Generation timed out after ${config.videoTimeoutMin} minutes.`,
      completed_at: nowISO(),
    }) ?? row;
  }

  if (
    !row.provider_job_id ||
    (row.provider_checked_at && Date.now() - Date.parse(row.provider_checked_at) < 4000)
  ) {
    return row;
  }

  const job = await or.getVideoJob(row.provider_job_id);
  const status = job?.status;

  if (status === 'failed') {
    return updateGeneration(row.id, {
      status: 'failed',
      error: job?.error || 'The video provider reported a failure.',
      completed_at: nowISO(),
    }) ?? row;
  }

  if (status === 'completed' && !row.file_path) {
    const { stream, contentType } = await or.fetchVideoContent(row.provider_job_id);
    const ext = extForMime(contentType, 'mp4');
    const rel = storage.newRel(ext);
    const size = await storage.saveWebStream(stream, rel);
    return updateGeneration(row.id, {
      file_path: rel,
      mime_type: mimeForExt(ext),
      file_size: size,
      cost: typeof job?.usage?.cost === 'number' ? job.usage.cost : row.cost,
      status: 'completed',
      completed_at: nowISO(),
      provider_checked_at: nowISO(),
    }) ?? row;
  }

  return updateGeneration(row.id, {
    status: 'processing',
    provider_checked_at: nowISO(),
  }) ?? row;
}

function asDataUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith('data:')) {
    throw badRequest(`${label} must be a base64 data URL.`);
  }
  parseDataUrl(value, label); // validates shape and non-empty payload
  return value;
}
