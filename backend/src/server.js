import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { videos } from './routes/videos.js';
import { images } from './routes/images.js';
import { audio } from './routes/audio.js';
import { generations } from './routes/generations.js';
import { providers } from './routes/providers.js';
import { chat } from './routes/chat.js';
import { enhance } from './routes/enhance.js';
import { HttpError } from './util.js';

const app = express();
app.disable('x-powered-by');

// Large limit so reference images / frames can travel as base64 data URLs.
app.use(express.json({ limit: '25mb' }));

app.get('/api/v1/health', (req, res) => {
  res.json({ ok: true, openrouter_key: Boolean(config.apiKey) });
});

app.use('/api/v1/providers', providers);
app.use('/api/v1/chat', chat);
app.use('/api/v1/enhance', enhance);

app.use('/api/v1/videos', videos);
app.use('/api/v1/images', images);
app.use('/api/v1/audio', audio);
app.use('/api/v1/generations', generations);

// Permanent media store — files saved here outlive refreshes and restarts.
app.use('/files', express.static(config.storageDir, { maxAge: '30d', immutable: true }));

// The SPA itself.
app.use(express.static(config.frontendDir));

app.use('/api', (req, res) => {
  res.status(404).json({ error: { message: `No such API route: ${req.method} ${req.originalUrl}` } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Upload too large (25 MB JSON body limit).' } });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { message: 'Malformed JSON body.' } });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: { message: 'Internal server error. See server logs.' } });
});

app.listen(config.port, () => {
  console.log(
    `\nAI Gen Studio\n` +
    `  UI        → http://localhost:${config.port}\n` +
    `  Storage   → ${config.storageDir} (served at /files)\n` +
    `  Database  → ${config.dbPath}\n` +
    `  API key   → ${config.apiKey ? 'configured ✓' : 'MISSING — add OPENROUTER_API_KEY to backend/.env'}\n`,
  );
});
