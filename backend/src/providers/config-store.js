import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const PROVIDER_DEFAULTS = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: config.baseUrl,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    capabilities: ['video', 'image', 'audio', 'chat'],
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    capabilities: ['chat'],
  },
  huggingface: {
    name: 'Hugging Face',
    baseUrl: process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/v1',
    taskBaseUrl: process.env.HUGGINGFACE_TASK_BASE_URL || 'https://router.huggingface.co/hf-inference',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    capabilities: ['chat', 'image', 'video'],
  },
};

function readStored() {
  try {
    return JSON.parse(readFileSync(config.providerConfigPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeStored(data) {
  mkdirSync(path.dirname(config.providerConfigPath), { recursive: true });
  writeFileSync(config.providerConfigPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(config.providerConfigPath, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
}

function normalizeBaseUrl(value, fallback) {
  const baseUrl = String(value || fallback).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Provider base URL must start with http:// or https://.');
  return baseUrl;
}

export function providerIds() {
  return Object.keys(PROVIDER_DEFAULTS);
}

export function getProvider(id) {
  const defaults = PROVIDER_DEFAULTS[id];
  if (!defaults) return null;
  const stored = readStored()[id] || {};
  const envKey = process.env[defaults.apiKeyEnv] || (id === 'openrouter' ? config.apiKey : '');
  return {
    id,
    name: defaults.name,
    baseUrl: normalizeBaseUrl(stored.baseUrl || defaults.baseUrl, defaults.baseUrl),
    taskBaseUrl: defaults.taskBaseUrl
      ? normalizeBaseUrl(stored.taskBaseUrl || defaults.taskBaseUrl, defaults.taskBaseUrl)
      : null,
    apiKey: String(stored.apiKey || envKey || '').trim(),
    capabilities: [...defaults.capabilities],
    configured: Boolean(stored.apiKey || envKey),
  };
}

export function listProviders() {
  return providerIds().map((id) => {
    const p = getProvider(id);
    return {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      capabilities: p.capabilities,
      configured: p.configured,
      keyHint: p.apiKey ? `${p.apiKey.slice(0, 4)}••••${p.apiKey.slice(-4)}` : null,
    };
  });
}

export function saveProvider(id, patch = {}) {
  if (!PROVIDER_DEFAULTS[id]) throw new Error(`Unknown provider: ${id}`);
  const all = readStored();
  const current = all[id] || {};
  const next = { ...current };
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl, PROVIDER_DEFAULTS[id].baseUrl);
  if (patch.apiKey !== undefined) {
    const key = String(patch.apiKey || '').trim();
    if (key) next.apiKey = key;
    // A blank field preserves the existing key; clearing can be added as an explicit action.
  }
  all[id] = next;
  writeStored(all);
  return getProvider(id);
}
