import { HttpError } from '../util.js';
import { getProvider, listProviders } from './config-store.js';

export { getProvider, listProviders };

export function requireProvider(id, capability) {
  const provider = getProvider(id || 'openrouter');
  if (!provider) throw new HttpError(400, `Unknown provider "${id}".`);
  if (!provider.capabilities.includes(capability)) {
    throw new HttpError(400, `${provider.name} does not support ${capability} generation in this app yet.`);
  }
  if (provider.requiresApiKey && !provider.apiKey) throw new HttpError(401, `${provider.name} API key is not configured. Open Settings to add it.`);
  return provider;
}

export function providerPath(provider, pathname) {
  return `${provider.baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export async function providerFetch(provider, pathname, { method = 'GET', json, timeoutMs = 120000, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(providerPath(provider, pathname), {
      method,
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(timedOut ? 504 : 502, timedOut
      ? `${provider.name} request timed out.`
      : `Could not reach ${provider.name}.`, { retryable: true });
  }

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.arrayBuffer();
  const buffer = Buffer.from(raw);
  let data = null;
  if (contentType.includes('json') && buffer.length) {
    try { data = JSON.parse(buffer.toString('utf8')); } catch { data = null; }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `${provider.name} returned HTTP ${response.status}.`;
    throw new HttpError(response.status, message, { retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
  }
  return { data, buffer, contentType, headers: response.headers };
}

export async function listOpenAIModels(provider) {
  try {
    const { data } = await providerFetch(provider, '/models', { timeoutMs: 30000 });
    const raw = Array.isArray(data?.data) ? data.data : [];
    if (raw.length) return raw.map((m) => ({ id: m.id || m.name, name: m.name || m.id, capabilities: provider.capabilities }));
  } catch (err) {
    const catalogUnsupported = [404, 405, 501].includes(err?.status);
    // Keep the local model selectable while Ollama is starting or temporarily offline.
    if (provider.id === 'ollama' && provider.staticModels?.length) {
      return provider.staticModels.map((m) => ({ id: m.id, name: m.name || m.id, capabilities: provider.capabilities }));
    }
    if (!provider.staticModels?.length || !catalogUnsupported) throw err;
  }
  return (provider.staticModels || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    capabilities: provider.capabilities,
  }));
}

export async function runHuggingFaceTask(provider, task, model, inputs, parameters = {}) {
  if (provider.id !== 'huggingface' || !provider.taskBaseUrl) {
    throw new HttpError(400, 'Hugging Face task routing is not configured.');
  }
  const safeModel = String(model || '').trim();
  if (!safeModel || safeModel.includes('..')) throw new HttpError(400, 'A valid Hugging Face model ID is required.');
  const url = `${provider.taskBaseUrl}/models/${safeModel}`;
  return providerFetchUrl(provider, url, {
    method: 'POST',
    json: { inputs, parameters },
    timeoutMs: task === 'text-to-video' ? 600000 : 180000,
  });
}

export async function providerFetchUrl(provider, url, { method = 'GET', json, timeoutMs = 120000, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(timedOut ? 504 : 502, timedOut
      ? `${provider.name} request timed out.`
      : `Could not reach ${provider.name}.`, { retryable: true });
  }
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  let data = null;
  if (contentType.includes('json') && buffer.length) {
    try { data = JSON.parse(buffer.toString('utf8')); } catch { data = null; }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || buffer.toString('utf8') || `${provider.name} returned HTTP ${response.status}.`;
    throw new HttpError(response.status, message, { retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
  }
  return { data, buffer, contentType, headers: response.headers };
}

export async function createOpenAIChat(provider, body, { timeoutMs = 180000 } = {}) {
  let response;
  try {
    response = await fetch(providerPath(provider, '/chat/completions'), {
      method: 'POST',
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(timedOut ? 504 : 502, timedOut
      ? `${provider.name} request timed out. Make sure the local model is loaded and try again.`
      : `Could not reach ${provider.name}. Start Ollama and confirm it is running on 127.0.0.1:11434, then try again.`, { retryable: true });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* provider returned non-JSON */ }
    throw new HttpError(response.status, payload?.error?.message || text || `${provider.name} chat request failed.`);
  }
  return response;
}
