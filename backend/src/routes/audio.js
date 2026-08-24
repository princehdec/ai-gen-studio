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
  parseDataUrl,
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

// Preview audio is intentionally not persisted to the Library.
audio.post('/preview', async (req, res, next) => {
  try {
    const { prompt, model, provider = 'openrouter', voice, reference_audio, reference_transcript, rights_confirmed } = req.body ?? {};
    const input = String(prompt || '').trim();
    if (!input) throw badRequest('Enter preview text first.');
    const providerConfig = requireProvider(provider, 'audio');
    if (providerConfig.id !== 'openrouter') throw badRequest('Voice preview currently requires OpenRouter.');
    const selectedModel = String(model || config.defaults.speechModel).trim();
    const inputReferences = buildReferenceParts({ referenceAudio: reference_audio, referenceTranscript: reference_transcript, rightsConfirmed: rights_confirmed, model: selectedModel });
    const result = await or.createSpeech({
      model: selectedModel,
      input: input.slice(0, 240),
      voice: /^fish-audio\//i.test(selectedModel) ? undefined : String(voice || 'alloy').toLowerCase(),
      responseFormat: 'mp3',
      inputReferences,
    });
    res.set({
      'Content-Type': result.contentType || 'audio/mpeg',
      'Content-Length': String(result.audioBuffer.length),
      'Cache-Control': 'no-store',
    });
    res.send(result.audioBuffer);
  } catch (err) { next(err); }
});

audio.get('/models', async (req, res, next) => {
  try {
    const mode = String(req.query.mode || 'speech').toLowerCase() === 'music' ? 'music' : 'speech';
    const modality = mode === 'speech' ? 'speech' : 'audio';
    res.json({
      models: await or.getModels('audio', { modality }),
      default_model: mode === 'speech' ? config.defaults.speechModel : config.defaults.audioModel,
      mode,
    });
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
      reference_audio,
      reference_transcript,
      rights_confirmed,
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
    const selectedModel = (model || (mode === 'speech' ? config.defaults.speechModel : config.defaults.audioModel)).trim();
    const dedicatedSpeech = mode === 'speech' && providerConfig.id === 'openrouter';
    const fishSpeechModel = /^fish-audio\//i.test(selectedModel);
    const inputReferences = buildReferenceParts({ referenceAudio: reference_audio, referenceTranscript: reference_transcript, rightsConfirmed: rights_confirmed, model: selectedModel });
    const outputFormat = dedicatedSpeech && fmt === 'wav' ? 'mp3' : fmt;
    const id = randomUUID();
    insertGeneration({
      id,
      type: 'audio',
      mode,
      prompt: prompt.trim(),
      model: selectedModel,
      status: 'processing',
      settings: { provider: providerConfig.id, voice: chosenVoice, format: fmt, voice_reference: Boolean(inputReferences?.length) },
    });

    try {
      const result = dedicatedSpeech
        ? await or.createSpeech({
          model: selectedModel,
          input: prompt.trim(),
          // Fish Audio uses its provider-side default voice on OpenRouter.
          voice: fishSpeechModel ? undefined : chosenVoice,
          responseFormat: outputFormat,
          inputReferences,
        })
        : await or.streamAudioCompletion({
          model: selectedModel,
          messages: [{ role: 'user', content: prompt.trim() }],
          modalities: ['text', 'audio'],
          audio: { voice: chosenVoice, format: fmt },
          stream: true,
        });

      const rel = storage.newRel(outputFormat);
      const size = await storage.saveBuffer(result.audioBuffer, rel);
      const row = getGeneration(id);
      updateGeneration(id, {
        file_path: rel,
        mime_type: result.contentType || FORMATS[outputFormat],
        file_size: size,
        cost: null,
        status: 'completed',
        completed_at: nowISO(),
        settings: JSON.stringify({ ...JSON.parse(row.settings), format: outputFormat, transcript: result.transcript }),
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

const REFERENCE_MIME_TYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac',
]);
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

function buildReferenceParts({ referenceAudio, referenceTranscript, rightsConfirmed, model }) {
  if (!referenceAudio) return undefined;
  if (!/^fish-audio\//i.test(String(model || ''))) {
    throw badRequest('Reference voice cloning is currently available for Fish Audio speech models only.');
  }
  if (rightsConfirmed !== true && String(rightsConfirmed).toLowerCase() !== 'true') {
    throw badRequest('Confirm that you own this voice or have permission to use the reference recording.');
  }
  const parsed = parseDataUrl(referenceAudio, 'Reference audio');
  const mime = String(parsed.mime || '').split(';')[0].toLowerCase();
  if (!REFERENCE_MIME_TYPES.has(mime)) {
    throw badRequest('Reference audio must be WAV, MP3, M4A, OGG/Opus or FLAC.');
  }
  if (parsed.buffer.length > MAX_REFERENCE_BYTES) {
    throw badRequest('Reference audio must be 15 MB or smaller.');
  }
  const transcript = String(referenceTranscript || '').trim().slice(0, 2000);
  return [
    { type: 'input_audio', input_audio: { data: referenceAudio } },
    ...(transcript ? [{ type: 'text', text: transcript }] : []),
  ];
}
