import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  apiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  storageDriver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(),
  storageDir: process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.join(ROOT, 'storage', 'files'),
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(ROOT, 'storage', 'app.db'),
  providerConfigPath: process.env.PROVIDER_CONFIG_PATH
    ? path.resolve(process.env.PROVIDER_CONFIG_PATH)
    : path.join(ROOT, 'storage', 'providers.json'),
  frontendDir: path.join(ROOT, 'frontend'),
  videoTimeoutMin: parseInt(process.env.VIDEO_TIMEOUT_MIN || '15', 10),
  defaults: {
    // Swap any of these freely — every form also accepts arbitrary model IDs.
    videoModel: process.env.DEFAULT_VIDEO_MODEL || 'bytedance/seedance-2.0-mini',
    imageModel: process.env.DEFAULT_IMAGE_MODEL || 'google/gemini-2.5-flash-image',
    audioModel: process.env.DEFAULT_AUDIO_MODEL || 'openai/gpt-4o-audio-preview',
    chatModel: process.env.DEFAULT_CHAT_MODEL || 'openai/gpt-4o-mini',
  },
};

if (!config.apiKey) {
  console.warn(
    '\n' +
    '┌──────────────────────────────────────────────────────────────┐\n' +
    '│  OPENROUTER_API_KEY is not set.                              │\n' +
    '│  The UI will load, but all generation calls will fail until  │\n' +
    '│  you add your key to backend/.env and restart the server.    │\n' +
    '└──────────────────────────────────────────────────────────────┘\n',
  );
}
