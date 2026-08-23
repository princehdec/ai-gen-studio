import { config } from './config.js';
import { HttpError, sleep } from './util.js';
import { getProvider } from './providers/config-store.js';

const NO_KEY_MSG =
  'OPENROUTER_API_KEY is not configured. Add it to backend/.env and restart the server.';

// Only idempotent GETs are retried automatically — never retry a paid
// generation POST, that could double-bill.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function friendlyMessage(status, payload) {
  const detail = payload?.error?.message || payload?.message || '';
  const suffix = detail ? ` (${detail})` : '';
  switch (status) {
    case 400:
      return `OpenRouter rejected the request as invalid.${suffix}`;
    case 401:
      return 'Invalid OpenRouter API key. Check OPENROUTER_API_KEY in backend/.env.';
    case 402:
      return 'Insufficient OpenRouter credits — top up at https://openrouter.ai/credits and retry.';
    case 403:
      return `Request forbidden by the provider.${suffix}`;
    case 404:
      return `Unknown model or resource on OpenRouter — check the model ID.${suffix}`;
    case 408:
    case 504:
      return `OpenRouter timed out while generating.${suffix} Please retry.`;
    case 429:
      return `Rate limited by OpenRouter. Wait a moment and retry.${suffix}`;
    case 502:
      return `The upstream model provider failed (you are not charged for failed image generations).${suffix} Please retry.`;
    default:
      return `OpenRouter request failed (HTTP ${status}).${suffix}`;
  }
}

function openRouter() {
  const provider = getProvider('openrouter');
  if (!provider?.apiKey) throw new HttpError(401, NO_KEY_MSG);
  return provider;
}

function headers(extra = {}) {
  const provider = openRouter();
  return {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': `http://localhost:${config.port}`,
    'X-Title': 'AI Gen Studio',
    ...extra,
  };
}

async function attemptOnce(pathname, { method, json, timeoutMs }) {
  let res;
  try {
    const provider = openRouter();
    res = await fetch(`${provider.baseUrl}${pathname}`, {
      method,
      headers: headers(),
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut
        ? 'Request to OpenRouter timed out. Please retry.'
        : `Could not reach OpenRouter (${err?.cause?.code || err?.message || 'network error'}).`,
      { retryable: true },
    );
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    throw new HttpError(res.status, friendlyMessage(res.status, payload), {
      retryable: RETRY_STATUS.has(res.status),
      retryAfterSec: Number.parseFloat(res.headers.get('retry-after') ?? '') || null,
    });
  }
  return payload;
}

/**
 * JSON request against OpenRouter with automatic retry/backoff on
 * transient failures (GETs only). Throws HttpError with a friendly message.
 */
export async function orFetch(pathname, { method = 'GET', json, timeoutMs = 60000 } = {}) {
  const retries = method === 'GET' ? 2 : 0;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (lastError) {
      const backoff = lastError.retryAfterSec
        ? lastError.retryAfterSec * 1000
        : Math.min(800 * 2 ** attempt, 5000) + Math.random() * 250;
      await sleep(backoff);
    }
    try {
      return await attemptOnce(pathname, { method, json, timeoutMs });
    } catch (err) {
      if (!(err instanceof HttpError) || !err.retryable || attempt === retries) throw err;
      lastError = err;
    }
  }
}

// ---------------------------------------------------------------------------
// Video jobs (async)
// ---------------------------------------------------------------------------

export function createVideoJob(body) {
  return orFetch('/videos', { method: 'POST', json: body, timeoutMs: 60000 });
}

export function getVideoJob(jobId) {
  return orFetch(`/videos/${encodeURIComponent(jobId)}`, { timeoutMs: 30000 });
}

/** Fetch the finished video as a stream. Retries only before the stream starts. */
export async function fetchVideoContent(jobId) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const provider = openRouter();
      res = await fetch(
        `${provider.baseUrl}/videos/${encodeURIComponent(jobId)}/content?index=0`,
        { headers: headers(), signal: AbortSignal.timeout(300000) },
      );
    } catch (err) {
      if (attempt >= 2) throw new HttpError(504, 'Timed out downloading the finished video.');
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* ignore */ }
      const err = new HttpError(res.status || 502, friendlyMessage(res.status || 502, payload), {
        retryable: RETRY_STATUS.has(res.status),
      });
      if (!err.retryable || attempt >= 2) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return { stream: res.body, contentType: res.headers.get('content-type') || 'video/mp4' };
  }
}

// ---------------------------------------------------------------------------
// Images (sync)
// ---------------------------------------------------------------------------

export function createImages(body) {
  return orFetch('/images', { method: 'POST', json: body, timeoutMs: 120000 });
}

// ---------------------------------------------------------------------------
// Audio via streaming chat completions (modalities: ["text","audio"])
// ---------------------------------------------------------------------------

/**
 * Streams an SSE chat completion and concatenates the base64 audio chunks.
 * Returns { audioBuffer, transcript, model }.
 */
export async function streamAudioCompletion(body, { timeoutMs = 180000 } = {}) {
  let res;
  try {
    const provider = openRouter();
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(timedOut ? 504 : 502, timedOut
      ? 'Audio generation timed out. Try a shorter script or a faster model.'
      : `Could not reach OpenRouter during audio generation.`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    throw new HttpError(res.status, friendlyMessage(res.status, payload));
  }

  const chunks = [];
  const transcriptParts = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawAudio = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new HttpError(502, friendlyMessage(502, parsed));
      }
      const delta = parsed.choices?.[0]?.delta;
      const b64 = delta?.audio?.data;
      if (b64) {
        sawAudio = true;
        chunks.push(Buffer.from(b64, 'base64'));
      }
      if (delta?.audio?.transcript) transcriptParts.push(delta.audio.transcript);
      else if (delta?.content) transcriptParts.push(delta.content);
    }
  }

  if (!sawAudio || chunks.length === 0) {
    throw new HttpError(
      502,
      'The model returned no audio. It may not support audio output — pick another audio-capable model.',
    );
  }
  return {
    audioBuffer: Buffer.concat(chunks),
    transcript: transcriptParts.join('').trim(),
    model: body.model,
  };
}

// ---------------------------------------------------------------------------
// Model discovery (cached 5 min, curated fallback if OpenRouter is unreachable)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = {
  video: [
    { id: config.defaults.videoModel, name: 'Seedance 2.0 Mini (default)' },
    { id: 'google/veo-3.1', name: 'Google Veo 3.1' },
    { id: 'openai/sora-2', name: 'OpenAI Sora 2' },
    { id: 'alibaba/wan-2.7', name: 'Alibaba Wan 2.7' },
    { id: 'minimax/hailuo-3', name: 'MiniMax Hailuo 3' },
    { id: 'bytedance/seedance-1-pro', name: 'Seedance 1 Pro' },
  ],
  image: [
    { id: config.defaults.imageModel, name: 'Gemini Flash Image / Nano Banana (default)' },
    { id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5' },
    { id: 'openai/gpt-image-1', name: 'GPT Image 1' },
    { id: 'black-forest-labs/flux.2-pro', name: 'FLUX.2 Pro' },
    { id: 'google/gemini-2.5-flash-image-preview', name: 'Gemini 2.5 Flash Image Preview' },
  ],
  audio: [
    { id: config.defaults.audioModel, name: 'GPT-4o Audio Preview (default)' },
    { id: 'openai/gpt-4o-mini-tts', name: 'GPT-4o Mini TTS' },
    { id: 'google/gemini-2.5-flash-preview-tts', name: 'Gemini 2.5 Flash TTS' },
  ],
};

const MODEL_PATHS = {
  video: '/videos/models',
  image: '/images/models',
  audio: '/models?output_modalities=audio',
};

const modelCache = new Map(); // kind -> { at, items }
const MODEL_TTL_MS = 5 * 60 * 1000;

export async function getModels(kind) {
  const cached = modelCache.get(kind);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.items;

  try {
    const data = await orFetch(MODEL_PATHS[kind], { timeoutMs: 15000 });
    const raw = Array.isArray(data?.data) ? data.data : [];
    const items = raw
      .map((m) => ({ id: m.id || m.slug, name: m.name || m.id || m.slug }))
      .filter((m) => !!m.id);
    if (!items.length) throw new Error('empty model list');
    modelCache.set(kind, { at: Date.now(), items });
    return items;
  } catch {
    // Never block the UI on model-list failures — show curated defaults.
    return FALLBACK_MODELS[kind];
  }
}
