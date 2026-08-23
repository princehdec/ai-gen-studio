import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import * as or from '../openrouter.js';
import * as storage from '../storage/index.js';
import {
  HttpError,
  badRequest,
  mimeForExt,
  nowISO,
  publicRow,
} from '../util.js';
import { getGeneration, insertGeneration, updateGeneration } from '../db.js';
import { requireProvider } from '../providers/index.js';

export const audio = Router();

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const FORMATS = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  opus: 'audio/opus',
};

// '/models' is registered before any '/:id'-style route on purpose.
audio.get('/models', async (req, res, next) => {
  try {
    res.json({ models: await or.getModels('audio'), default_model: config.defaults.audioModel });
  } catch (err) { next(err); }
});

audio.post('/', async (req, res, next) => {
  try {
    const {
      prompt,
      model,
      provider = 'openrouter',
      mode = 'speech', // 'speech' (narration/TTS) | 'music' (soundtrack/SFX)
      voice,
      format = 'wav',
    } = req.body ?? {};

    if (!['speech', 'music'].includes(mode)) {
      throw badRequest(`mode must be "speech" or "music" (got "${mode}").`);
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw badRequest(mode === 'music'
        ? 'Describe the music or sound effect to generate.'
        : 'Enter the script text to narrate.');
    }
    const fmt = String(format).toLowerCase();
    if (!FORMATS[fmt]) throw badRequest(`format must be one of: ${Object.keys(FORMATS).join(', ')}.`);
    const chosenVoice = voice ? String(voice).toLowerCase() : 'alloy';
    if (!VOICES.includes(chosenVoice)) {
      throw badRequest(`voice must be one of: ${VOICES.join(', ')}.`);
    }

    const providerConfig = requireProvider(provider, 'audio');
    const id = randomUUID();
    insertGeneration({
      id,
      type: 'audio',
      mode,
      prompt: prompt.trim(),
      model: (model || config.defaults.audioModel).trim(),
      status: 'processing',
      settings: { provider: providerConfig.id, voice: chosenVoice, format: fmt },
    });

    try {
      // OpenRouter exposes audio output through the chat-completions endpoint:
      // modalities ["text","audio"] + audio:{voice,format}, streaming required.
      const result = await or.streamAudioCompletion({
        model: (model || config.defaults.audioModel).trim(),
        messages: [{ role: 'user', content: prompt.trim() }],
        modalities: ['text', 'audio'],
        audio: { voice: chosenVoice, format: fmt },
        stream: true,
      });

      const rel = storage.newRel(fmt);
      const size = await storage.saveBuffer(result.audioBuffer, rel);
      const row = getGeneration(id);
      updateGeneration(id, {
        file_path: rel,
        mime_type: FORMATS[fmt],
        file_size: size,
        cost: null,
        status: 'completed',
        completed_at: nowISO(),
        settings: JSON.stringify({ ...JSON.parse(row.settings), transcript: result.transcript }),
      });
      res.status(201).json(publicRow(getGeneration(id)));
    } catch (err) {
      updateGeneration(id, { status: 'failed', error: err.message, completed_at: nowISO() });
      if (!(err instanceof HttpError)) {
        console.error('[audio] unexpected failure:', err);
        throw new HttpError(500, 'Audio generation failed unexpectedly. See server logs.');
      }
      throw err;
    }
  } catch (err) { next(err); }
});
