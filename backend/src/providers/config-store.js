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
  cerebras: {
    name: 'Cerebras',
    baseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    capabilities: ['chat'],
    defaultModel: 'gpt-oss-120b',
    staticModels: [{ id: 'gpt-oss-120b', name: 'GPT OSS 120B' }],
  },
  mistral: {
    name: 'Mistral AI',
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    capabilities: ['chat'],
    defaultModel: 'mistral-large-latest',
    staticModels: [{ id: 'mistral-large-latest', name: 'Mistral Large' }],
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    capabilities: ['chat'],
    defaultModel: 'gemini-3.7-flash',
    staticModels: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }, { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro' }],
  },
  xai: {
    name: 'xAI / Grok',
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    capabilities: ['chat'],
    defaultModel: 'grok-4.6',
    staticModels: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    capabilities: ['chat'],
    defaultModel: 'deepseek-v4-flash',
    staticModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
  },
  ollama: {
    name: 'Ollama (Local)',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    apiKeyEnv: '',
    requiresApiKey: false,
    capabilities: ['chat'],
    defaultModel: process.env.OLLAMA_DEFAULT_MODEL || 'gemma4:e4b',
    staticModels: [{ id: 'gemma4:e4b', name: 'Gemma 4 E4B (local)' }],
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
    requiresApiKey: defaults.requiresApiKey !== false,
    capabilities: [...defaults.capabilities],
    defaultModel: defaults.defaultModel || '',
    staticModels: defaults.staticModels || [],
    configured: defaults.requiresApiKey === false ? true : Boolean(stored.apiKey || envKey),
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
      requiresApiKey: p.requiresApiKey,
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
