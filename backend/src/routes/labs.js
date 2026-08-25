import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { badRequest, HttpError, nowISO } from '../util.js';
import { createOpenAIChat, requireProvider } from '../providers/index.js';
import { getProvider } from '../providers/config-store.js';
import * as storage from '../storage/index.js';
import { config } from '../config.js';

export const labs = Router();
const execFileAsync = promisify(execFile);
const labUploadDir = path.join(os.tmpdir(), 'ai-gen-studio-dev-labs');
mkdirSync(labUploadDir, { recursive: true });
const labUpload = multer({ dest: labUploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

const PERSONAS = [
  { id: 'director', name: 'Creative Director', system: 'You are a decisive creative director. Turn vague ideas into clear visual direction, shot choices, pacing, and production notes.' },
  { id: 'copywriter', name: 'Ad Copywriter', system: 'You are a conversion-focused copywriter. Write concise, credible scripts with a strong hook, benefit, proof, and call to action.' },
  { id: 'producer', name: 'Production Producer', system: 'You are a practical production producer. Think in shots, assets, durations, dependencies, and review gates.' },
  { id: 'researcher', name: 'Researcher', system: 'You are a careful researcher. Separate known facts from assumptions, cite provided context, and ask for missing evidence.' },
];
const SKILLS = [
  { id: 'instagram-reframe', name: 'Resize for Instagram', description: 'Prepare a 9:16 delivery plan with safe zones and caption guidance.' },
  { id: 'brand-voice', name: 'Brand voice check', description: 'Review copy against a saved tone and vocabulary preference.' },
  { id: 'short-ad', name: '15-second ad pipeline', description: 'Turn one goal into script, shots, voiceover, and export steps.' },
];
const ALLOWED_STEP_NAMES = ['Brief analysis', 'Script', 'Visual plan', 'Video generation', 'Voiceover', 'Lip-sync / dubbing', 'Upscale and export'];

labs.get('/config', (req, res) => res.json({ personas: PERSONAS, skills: SKILLS, workflow_steps: ALLOWED_STEP_NAMES }));

labs.get('/usage', (req, res) => {
  const usage = db.prepare(`SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(estimated_cost), 0) AS estimated_cost FROM usage_events`).get();
  const credits = db.prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_ledger').get();
  res.json({ usage, credits: { balance: Number(credits.balance || 0) } });
});

labs.post('/credits', (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw badRequest('Credit amount must be between 0 and 100000.');
    const row = { id: randomUUID(), amount, reason: String(req.body?.reason || 'Local Dev credit grant').slice(0, 160), reference: 'dev-local', created_at: nowISO() };
    db.prepare('INSERT INTO credit_ledger (id, amount, reason, reference, created_at) VALUES (?, ?, ?, ?, ?)').run(row.id, row.amount, row.reason, row.reference, row.created_at);
    res.status(201).json({ ok: true, balance: db.prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_ledger').get().balance });
  } catch (err) { next(err); }
});

labs.get('/memory', (req, res) => {
  const rows = db.prepare('SELECT id, content, tags, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT 100').all();
  res.json({ memories: rows.map((row) => ({ ...row, tags: parseJson(row.tags, []) })) });
});

labs.post('/memory', (req, res, next) => {
  try {
    const content = String(req.body?.content || '').trim();
    if (!content) throw badRequest('Memory content is required.');
    const now = nowISO();
    const row = { id: randomUUID(), content: content.slice(0, 2000), tags: JSON.stringify(Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 12) : []), created_at: now, updated_at: now };
    db.prepare('INSERT INTO memories (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(row.id, row.content, row.tags, row.created_at, row.updated_at);
    res.status(201).json({ memory: { ...row, tags: parseJson(row.tags, []) } });
  } catch (err) { next(err); }
});

labs.delete('/memory/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

labs.post('/compare', async (req, res, next) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const requested = Array.isArray(req.body?.models) ? req.body.models : [];
    if (!prompt) throw badRequest('A comparison prompt is required.');
    if (!requested.length || requested.length > 3) throw badRequest('Choose between 1 and 3 provider/model pairs.');
    const results = await Promise.all(requested.map(async (item) => {
      const providerId = String(item?.provider || 'openrouter');
      const provider = requireProvider(providerId, 'chat');
      const model = String(item?.model || provider.defaultModel || '').trim();
      if (!model) throw badRequest(`Enter a model for ${provider.name}.`);
      const started = Date.now();
      try {
        const response = await createOpenAIChat(provider, {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          ...(item?.system ? { messages: [{ role: 'system', content: String(item.system).slice(0, 2000) }, { role: 'user', content: prompt }] } : {}),
        });
        const payload = await response.json();
        const text = payload?.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('No text output returned.');
        recordUsage({ provider: provider.id, model, operation: 'compare', usage: payload.usage });
        return { provider: provider.id, provider_name: provider.name, model: payload.model || model, text, latency_ms: Date.now() - started, usage: payload.usage || null };
      } catch (err) {
        return { provider: provider.id, provider_name: provider.name, model, error: err.message, latency_ms: Date.now() - started };
      }
    }));
    res.status(201).json({ prompt, results });
  } catch (err) { next(err); }
});

labs.get('/rag/documents', (req, res) => {
  const documents = db.prepare(`SELECT d.id, d.name, d.mime_type, d.file_size, d.created_at, COUNT(c.id) AS chunks FROM lab_documents d LEFT JOIN lab_chunks c ON c.document_id = d.id GROUP BY d.id ORDER BY d.created_at DESC`).all();
  res.json({ documents });
});

labs.post('/rag/upload', labUpload.single('document'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('Choose a PDF, Markdown, or text document.');
    let text;
    if (req.file.mimetype === 'application/pdf' || path.extname(req.file.originalname).toLowerCase() === '.pdf') {
      try { ({ stdout: text } = await execFileAsync('pdftotext', [req.file.path, '-'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })); }
      catch { throw new HttpError(400, 'PDF extraction requires pdftotext. Install Poppler and ensure pdftotext is on PATH.'); }
    } else {
      text = await readFile(req.file.path, 'utf8');
    }
    const document = persistDocument({ name: req.file.originalname, mimeType: req.file.mimetype || 'text/plain', text });
    res.status(201).json({ document });
  } catch (err) { next(err); }
  finally { if (req.file?.path) await unlink(req.file.path).catch(() => {}); }
});

labs.post('/rag/index', (req, res, next) => {
  try {
    const name = String(req.body?.name || 'Untitled document').trim().slice(0, 240);
    const mimeType = String(req.body?.mime_type || 'text/plain').slice(0, 120);
    const text = String(req.body?.text || '').replace(/\u0000/g, '').trim();
    if (!text) throw badRequest('Document text is empty. For PDF files, extract the text locally before indexing.');
    if (text.length > 2_000_000) throw badRequest('Document text is too large for the Dev RAG index.');
    res.status(201).json({ document: persistDocument({ name, mimeType, text }) });
  } catch (err) { next(err); }
});

labs.delete('/rag/documents/:id', (req, res) => {
  db.prepare('DELETE FROM lab_chunks WHERE document_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lab_documents WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

labs.post('/rag/query', async (req, res, next) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) throw badRequest('A document question is required.');
    const provider = requireProvider(String(req.body?.provider || 'ollama'), 'chat');
    const model = String(req.body?.model || provider.defaultModel || '').trim();
    if (!model) throw badRequest(`Enter a model for ${provider.name}.`);
    const all = db.prepare('SELECT id, document_id, content FROM lab_chunks').all();
    const ranked = all.map((chunk) => ({ ...chunk, score: overlapScore(question, chunk.content) })).sort((a, b) => b.score - a.score).slice(0, 6);
    const context = ranked.map((chunk, index) => `[Source ${index + 1}]\n${chunk.content}`).join('\n\n');
    const response = await createOpenAIChat(provider, { model, stream: false, messages: [
      { role: 'system', content: 'Answer using the supplied document context. If the answer is not supported by the context, say that clearly. Do not invent citations.' },
      { role: 'user', content: `Document context:\n${context || '(No indexed context found.)'}\n\nQuestion: ${question}` },
    ] });
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new HttpError(502, `${provider.name} returned no answer.`);
    recordUsage({ provider: provider.id, model, operation: 'rag', usage: payload.usage });
    res.status(201).json({ provider: provider.id, model: payload.model || model, answer: text, sources: ranked.map(({ document_id, content, score }) => ({ document_id, excerpt: content.slice(0, 280), score })) });
  } catch (err) { next(err); }
});

labs.post('/dubbing', labUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res, next) => {
  const files = req.files || {};
  const video = files.video?.[0];
  const audio = files.audio?.[0];
  try {
    if (!video || !audio) throw badRequest('Choose both a source video and generated audio.');
    if (String(req.body?.rights_confirmed).toLowerCase() !== 'true') throw badRequest('Confirm that you own or have permission to edit this video and audio.');
    const mode = String(req.body?.mode || 'dubbing');
    if (mode === 'lip-sync') throw new HttpError(501, 'Lip-sync needs a configured local Wav2Lip runtime. Soundtrack dubbing is ready now.');
    const rel = storage.newRel('mp4');
    const output = path.join(config.storageDir, rel);
    mkdirSync(path.dirname(output), { recursive: true });
    await execFileAsync('ffmpeg', ['-y', '-i', video.path, '-i', audio.path, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-shortest', output], { timeout: 600000, windowsHide: true });
    const stat = await readFile(output);
    res.status(201).json({ ok: true, mode, file_url: `/files/${rel.replaceAll('\\\\', '/')}`, file_size: stat.length });
  } catch (err) { next(err); }
  finally { for (const file of [video, audio]) if (file?.path) await unlink(file.path).catch(() => {}); }
});

labs.post('/workflows/plan', (req, res, next) => {
  try {
    const goal = String(req.body?.goal || '').trim();
    if (!goal) throw badRequest('A creative workflow goal is required.');
    const now = nowISO();
    const id = randomUUID();
    const provider = String(req.body?.provider || 'ollama');
    const model = String(req.body?.model || getProvider(provider)?.defaultModel || '').trim();
    const names = ['Brief analysis', 'Script', 'Visual plan', 'Video generation', 'Voiceover', 'Lip-sync / dubbing', 'Upscale and export'];
    db.prepare('INSERT INTO workflow_runs (id, goal, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, goal.slice(0, 4000), provider, model, 'planned', now, now);
    const insert = db.prepare('INSERT INTO workflow_steps (id, run_id, step_index, name, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    names.forEach((name, stepIndex) => insert.run(randomUUID(), id, stepIndex, name, 'pending', now));
    res.status(201).json(getWorkflow(id));
  } catch (err) { next(err); }
});

labs.get('/workflows', (req, res) => res.json({ workflows: db.prepare('SELECT * FROM workflow_runs ORDER BY updated_at DESC LIMIT 30').all().map(withWorkflowSteps) }));
labs.get('/workflows/:id', (req, res, next) => { try { res.json(getWorkflow(req.params.id)); } catch (err) { next(err); } });

labs.post('/workflows/:id/run', async (req, res, next) => {
  try {
    const workflow = getWorkflow(req.params.id);
    if (!workflow?.id) throw new HttpError(404, 'Workflow not found.');
    const provider = requireProvider(workflow.provider || 'ollama', 'chat');
    const model = workflow.model || provider.defaultModel;
    db.prepare('UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?').run('running', nowISO(), workflow.id);
    const firstSteps = workflow.steps.filter((step) => ['Brief analysis', 'Script', 'Visual plan'].includes(step.name) && step.status === 'pending');
    for (const step of firstSteps) {
      db.prepare('UPDATE workflow_steps SET status = ?, updated_at = ? WHERE id = ?').run('running', nowISO(), step.id);
      try {
        const response = await createOpenAIChat(provider, { model, stream: false, messages: [{ role: 'system', content: 'You are a creative production workflow planner. Return concise, actionable output for the requested step.' }, { role: 'user', content: `Goal: ${workflow.goal}\nStep: ${step.name}` }] });
        const payload = await response.json();
        const output = payload?.choices?.[0]?.message?.content || 'No output returned.';
        recordUsage({ provider: provider.id, model, operation: 'workflow', usage: payload.usage });
        db.prepare('UPDATE workflow_steps SET status = ?, output = ?, updated_at = ? WHERE id = ?').run('completed', output.slice(0, 12000), nowISO(), step.id);
      } catch (err) {
        db.prepare('UPDATE workflow_steps SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', err.message, nowISO(), step.id);
      }
    }
    db.prepare('UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?').run('ready-for-media', nowISO(), workflow.id);
    res.json(getWorkflow(workflow.id));
  } catch (err) { next(err); }
});

function persistDocument({ name, mimeType, text }) {
  const cleanText = String(text || '').replace(/\u0000/g, '').trim();
  if (!cleanText) throw badRequest('Document text is empty.');
  if (cleanText.length > 2_000_000) throw badRequest('Document text is too large for the Dev RAG index.');
  const documentId = randomUUID();
  const now = nowISO();
  const chunks = chunkText(cleanText, 1200, 160);
  db.prepare('INSERT INTO lab_documents (id, name, mime_type, file_size, created_at) VALUES (?, ?, ?, ?, ?)').run(documentId, String(name || 'Untitled document').slice(0, 240), String(mimeType || 'text/plain').slice(0, 120), Buffer.byteLength(cleanText, 'utf8'), now);
  const insert = db.prepare('INSERT INTO lab_chunks (id, document_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?, ?)');
  chunks.forEach((content, index) => insert.run(randomUUID(), documentId, index, content, now));
  return { id: documentId, name: String(name || 'Untitled document').slice(0, 240), mime_type: String(mimeType || 'text/plain').slice(0, 120), chunks: chunks.length, created_at: now };
}
function getWorkflow(id) {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
  return run ? withWorkflowSteps(run) : null;
}
function withWorkflowSteps(run) {
  return { ...run, steps: db.prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index').all(run.id) };
}
function recordUsage({ provider, model, operation, usage }) {
  const input = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const output = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  const estimated = provider === 'ollama' ? 0 : (input * 0.000001 + output * 0.000003);
  db.prepare('INSERT INTO usage_events (id, provider, model, operation, input_tokens, output_tokens, estimated_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), provider, model, operation, input, output, estimated, nowISO());
}
function chunkText(text, size, overlap) { const chunks = []; for (let start = 0; start < text.length; start += size - overlap) chunks.push(text.slice(start, start + size)); return chunks; }
function overlapScore(question, content) { const terms = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2)); const body = content.toLowerCase(); return [...terms].reduce((score, term) => score + (body.includes(term) ? 1 : 0), 0); }
function parseJson(value, fallback) { try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; } }
