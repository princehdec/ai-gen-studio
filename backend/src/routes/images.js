import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import * as or from '../openrouter.js';
import * as storage from '../storage/index.js';
import {
  HttpError,
  badRequest,
  extForMime,
  nowISO,
  parseDataUrl,
  publicRow,
} from '../util.js';
import { getGeneration, insertGeneration, updateGeneration } from '../db.js';
import { requireProvider, runHuggingFaceTask } from '../providers/index.js';

export const images = Router();

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
const RESOLUTIONS = ['512', '1K', '2K', '4K'];

images.get('/models', async (req, res, next) => {
  try {
    const providerId = req.query.provider || 'openrouter';
    if (providerId === 'openrouter') {
      return res.json({ models: await or.getModels('image'), default_model: config.defaults.imageModel });
    }
    const provider = requireProvider(providerId, 'image');
    return res.json({ models: provider.id === 'huggingface' ? [
      { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX.1 Schnell' },
      { id: 'Qwen/Qwen-Image', name: 'Qwen Image' },
      { id: 'ByteDance/Hyper-SD', name: 'ByteDance Hyper-SD' },
    ] : [], default_model: '' });
  } catch (err) { next(err); }
});

/**
 * Synchronous endpoint — OpenRouter returns base64 image(s); we save each one
 * to permanent storage and record a history row per file before responding.
 */
images.post('/', async (req, res, next) => {
  try {
    const {
      prompt,
      model,
      provider = 'openrouter',
      n = 1,
      aspect_ratio,
      resolution,
      output_format = 'png',
      input_images,
    } = req.body ?? {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw badRequest('A prompt is required.');
    }
    const count = Number(n) || 1;
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw badRequest('n must be an integer between 1 and 10.');
    }
    const refs = Array.isArray(input_images) ? input_images : [];
    if (refs.length > 4) throw badRequest('At most 4 input images are supported for editing.');
    const providerConfig = requireProvider(provider, 'image');
    if (providerConfig.id === 'huggingface' && refs.length) {
      throw badRequest('Hugging Face image generation currently supports text-to-image only; remove input images.');
    }

    const body = {
      model: (model || config.defaults.imageModel).trim(),
      prompt: prompt.trim(),
      n: count,
      output_format: ['png', 'jpeg', 'webp'].includes(output_format) ? output_format : 'png',
    };
    if (aspect_ratio) {
      if (!ASPECT_RATIOS.includes(aspect_ratio)) {
        throw badRequest(`aspect_ratio must be one of: ${ASPECT_RATIOS.join(', ')}.`);
      }
      body.aspect_ratio = aspect_ratio;
    }
    if (resolution) {
      if (!RESOLUTIONS.includes(resolution)) {
        throw badRequest(`resolution must be one of: ${RESOLUTIONS.join(', ')}.`);
      }
      body.resolution = resolution;
    }
    if (refs.length) {
      body.input_references = refs.map((r, i) => ({
        type: 'image_url',
        image_url: { url: asDataUrl(r, `Input image ${i + 1}`) },
      }));
    }

    const settings = {
      n: count,
      provider: providerConfig.id,
      aspect_ratio: aspect_ratio ?? null,
      resolution: resolution ?? null,
      inputs: refs.length,
      mode: refs.length ? 'i2i_edit' : 't2i',
    };

    // One row per returned image. The first reuses the row created up front so
    // failures still leave a traceable 'failed' entry in history.
    const id = randomUUID();
    insertGeneration({
      id,
      type: 'image',
      mode: settings.mode,
      prompt: body.prompt,
      model: body.model,
      status: 'processing',
      settings,
    });

    try {
      if (providerConfig.id === 'huggingface') {
        if (!body.model || body.model === config.defaults.imageModel) {
          throw badRequest('Enter a Hugging Face image model ID, for example black-forest-labs/FLUX.1-schnell.');
        }
        const result = await runHuggingFaceTask(providerConfig, 'text-to-image', body.model, body.prompt, {
          ...(body.aspect_ratio ? { aspect_ratio: body.aspect_ratio } : {}),
        });
        const ext = extForMime(result.contentType, body.output_format === 'jpeg' ? 'jpg' : body.output_format);
        const rel = storage.newRel(ext);
        const size = await storage.saveBuffer(result.buffer, rel);
        updateGeneration(id, {
          mime_type: result.contentType || `image/${ext}`,
          file_path: rel,
          file_size: size,
          status: 'completed',
          completed_at: nowISO(),
        });
        return res.status(201).json([publicRow(getGeneration(id))]);
      }

      const data = await or.createImages(body);
      const items = Array.isArray(data?.data) ? data.data : [];
      if (!items.length) throw new HttpError(502, 'OpenRouter returned no images.');

      const saved = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item?.b64_json) continue;
        const buffer = Buffer.from(item.b64_json, 'base64');
        const ext = extForMime(item.media_type, body.output_format === 'jpeg' ? 'jpg' : body.output_format);
        const rel = storage.newRel(ext);
        const size = await storage.saveBuffer(buffer, rel);

        let rowId = id;
        if (i > 0) {
          rowId = randomUUID();
          insertGeneration({
            id: rowId,
            type: 'image',
            mode: settings.mode,
            prompt: body.prompt,
            model: body.model,
            status: 'processing',
            settings: { ...settings, batch_of: id },
            created_at: undefined,
          });
        }
        updateGeneration(rowId, {
          mime_type: item.media_type || `image/${ext}`,
          file_path: rel,
          file_size: size,
          cost: typeof data?.usage?.cost === 'number' && i === 0
            ? Math.round((data.usage.cost / items.length) * 1e6) / 1e6
            : null,
          status: 'completed',
          completed_at: nowISO(),
        });
        saved.push(publicRow(getGeneration(rowId)));
      }

      if (!saved.length) throw new HttpError(502, 'OpenRouter returned images but none could be decoded.');
      res.status(201).json(saved);
    } catch (err) {
      updateGeneration(id, { status: 'failed', error: err.message, completed_at: nowISO() });
      throw err;
    }
  } catch (err) { next(err); }
});

function asDataUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith('data:')) {
    throw badRequest(`${label} must be a base64 data URL.`);
  }
  parseDataUrl(value, label);
  return value;
}
