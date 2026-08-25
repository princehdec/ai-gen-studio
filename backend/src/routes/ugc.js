import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { db } from '../db.js';
import { createOpenAIChat, requireProvider } from '../providers/index.js';
import { badRequest, HttpError, nowISO, publicRow } from '../util.js';
import * as storage from '../storage/index.js';
import { getGeneration, insertGeneration, updateGeneration } from '../db.js';

export const ugc = Router();

const PLATFORM_LIMITS = {
  tiktok: { label: 'TikTok', aspect_ratio: '9:16', maxSeconds: 60 },
  instagram_reels: { label: 'Instagram Reels', aspect_ratio: '9:16', maxSeconds: 90 },
  youtube_shorts: { label: 'YouTube Shorts', aspect_ratio: '9:16', maxSeconds: 60 },
  instagram_feed: { label: 'Instagram Feed', aspect_ratio: '4:5', maxSeconds: 60 },
  youtube: { label: 'YouTube', aspect_ratio: '16:9', maxSeconds: 180 },
};

function projectRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    brief: parseJson(row.brief, {}),
    plan: parseJson(row.plan, null),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function cleanText(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function validateBrief(input = {}) {
  const brief = {
    product: cleanText(input.product, 240),
    audience: cleanText(input.audience, 240),
    goal: cleanText(input.goal, 240),
    offer: cleanText(input.offer, 240),
    tone: cleanText(input.tone, 120) || 'authentic, energetic and trustworthy',
    language: cleanText(input.language, 80) || 'English',
    platform: String(input.platform || 'tiktok'),
    duration: Math.max(8, Math.min(60, Number(input.duration) || 25)),
  };
  if (!brief.product) throw badRequest('Tell us what product or service the UGC ad is for.');
  if (!brief.audience) throw badRequest('Tell us who the target audience is.');
  if (!PLATFORM_LIMITS[brief.platform]) throw badRequest('Choose a supported social platform.');
  brief.duration = Math.min(brief.duration, PLATFORM_LIMITS[brief.platform].maxSeconds);
  return brief;
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return '';
}

function parseModelJson(text, fallback) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(raw); } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fallback */ } }
    return fallback;
  }
}

function fallbackAngles(brief) {
  const product = brief.product;
  return [
    { id: 'testimonial', title: 'Authentic testimonial', hook: `I did not expect ${product} to make this much difference.`, description: 'A natural, creator-led before/after story with believable details.', why_it_works: 'Feels personal and builds trust quickly.' },
    { id: 'problem-solution', title: 'Problem → solution', hook: `If you still struggle with this, watch what happened when I tried ${product}.`, description: 'Start with a relatable pain point, then demonstrate the product solving it.', why_it_works: 'Makes the value obvious in the first seconds.' },
    { id: 'unboxing', title: 'Unboxing and first impression', hook: `Come unbox ${product} with me and see if it is worth it.`, description: 'Casual unboxing, tactile details, first reaction and a clear CTA.', why_it_works: 'Creates curiosity and showcases product experience.' },
  ];
}

function fallbackScript(brief, angle) {
  const total = Math.max(12, brief.duration);
  const d = Math.max(3, Math.round(total / 5));
  const scenes = [
    { id: 'scene-1', order: 1, duration: d, label: 'Hook', visual_prompt: `Vertical UGC selfie video, creator speaking directly to camera about ${brief.product}, authentic home setting, natural daylight, handheld smartphone framing`, voiceover: angle.hook, on_screen_text: angle.hook, transition: 'hard cut' },
    { id: 'scene-2', order: 2, duration: d, label: 'Problem', visual_prompt: `Vertical UGC close-up of a relatable customer problem connected to ${brief.product}, realistic creator performance, natural imperfect phone video`, voiceover: `I was dealing with this problem and wanted something simple that actually fit into my routine.`, on_screen_text: 'The problem', transition: 'quick cut' },
    { id: 'scene-3', order: 3, duration: d, label: 'Demo', visual_prompt: `Vertical UGC product demonstration of ${brief.product}, hands and product detail, believable creator review, soft natural lighting`, voiceover: `Here is how I use it: simple, clear and easy to repeat every day.`, on_screen_text: 'How it works', transition: 'match cut' },
    { id: 'scene-4', order: 4, duration: d, label: 'Proof', visual_prompt: `Vertical UGC before and after reaction, happy creator showing the result of ${brief.product}, candid social ad style`, voiceover: `The part I noticed most was how much easier this made the whole process.`, on_screen_text: 'The result', transition: 'quick cut' },
    { id: 'scene-5', order: 5, duration: total - d * 4, label: 'CTA', visual_prompt: `Vertical UGC creator holding ${brief.product} and giving a friendly direct recommendation, clean background, confident but not overproduced`, voiceover: brief.offer || `Try ${brief.product} and see whether it fits your routine.`, on_screen_text: 'Try it for yourself', transition: 'end card' },
  ];
  return { title: `${brief.product} UGC Ad`, angle: angle.title, creator_direction: `Speak like a real customer: ${brief.tone}. Keep delivery ${brief.language}.`, script: scenes.map((scene) => scene.voiceover).join(' '), scenes };
}

async function askPlanner({ provider = 'openrouter', model, system, prompt }) {
  const providerConfig = requireProvider(provider, 'chat');
  const selectedModel = cleanText(model, 240) || (providerConfig.id === 'openrouter' ? config.defaults.chatModel : '');
  if (!selectedModel) throw badRequest(`Enter a ${providerConfig.name} chat model ID.`);
  const response = await createOpenAIChat(providerConfig, {
    model: selectedModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    stream: false,
    temperature: 0.7,
    max_tokens: 5000,
  });
  const payload = await response.json();
  const text = extractText(payload);
  if (!text) throw new HttpError(502, `${providerConfig.name} returned no planning text.`);
  return { text, model: payload?.model || selectedModel, provider: providerConfig.id };
}

ugc.post('/plan', async (req, res, next) => {
  try {
    const brief = validateBrief(req.body?.brief);
    const { provider = 'openrouter', model } = req.body ?? {};
    const fallback = { angles: fallbackAngles(brief) };
    let plan;
    let planner = null;
    try {
      planner = await askPlanner({
        provider,
        model,
        system: 'You are a performance UGC advertising strategist. Return only valid JSON. Never invent unsupported product claims, prices, medical outcomes or guarantees.',
        prompt: `Create exactly 3 distinct UGC ad angles for this brief:\n${JSON.stringify(brief)}\nReturn JSON with an angles array. Each angle must have id, title, hook, description, and why_it_works. Keep hooks short and natural.`,
      });
      plan = parseModelJson(planner.text, fallback);
    } catch (err) {
      console.warn('[ugc] planner fallback:', err.message);
      plan = fallback;
    }
    if (!Array.isArray(plan.angles) || !plan.angles.length) plan = fallback;
    plan.angles = plan.angles.slice(0, 3).map((angle, index) => ({
      id: cleanText(angle.id, 80) || `angle-${index + 1}`,
      title: cleanText(angle.title, 120) || `UGC angle ${index + 1}`,
      hook: cleanText(angle.hook, 300),
      description: cleanText(angle.description, 500),
      why_it_works: cleanText(angle.why_it_works, 300),
    }));
    const id = randomUUID();
    const now = nowISO();
    db.prepare('INSERT INTO ugc_projects (id, title, brief, plan, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, `${brief.product} UGC Ad`, JSON.stringify(brief), JSON.stringify(plan), 'planned', now, now,
    );
    res.status(201).json({ project: projectRow(db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(id)), planner });
  } catch (err) { next(err); }
});

ugc.post('/script', async (req, res, next) => {
  try {
    const projectId = cleanText(req.body?.project_id, 80);
    const row = db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(projectId);
    if (!row) throw new HttpError(404, 'UGC project not found.');
    const brief = parseJson(row.brief, {});
    const angle = req.body?.angle || parseJson(row.plan, {})?.angles?.[0];
    if (!angle) throw badRequest('Choose a UGC angle first.');
    const fallback = fallbackScript(brief, angle);
    const { provider = 'openrouter', model } = req.body ?? {};
    let result = fallback;
    let planner = null;
    try {
      planner = await askPlanner({
        provider,
        model,
        system: 'You are a UGC ad scriptwriter and storyboard director. Return only valid JSON. Avoid unsupported claims. Make scenes easy to generate with text-to-video models.',
        prompt: `Create a ${brief.duration}-second ${PLATFORM_LIMITS[brief.platform].label} UGC ad from this brief and selected angle.\nBrief: ${JSON.stringify(brief)}\nAngle: ${JSON.stringify(angle)}\nReturn JSON with title, creator_direction, script, and scenes. Use 4–6 scenes. Each scene needs id, order, duration, label, visual_prompt, voiceover, on_screen_text, transition. The sum of durations should be close to the requested duration.`,
      });
      result = parseModelJson(planner.text, fallback);
    } catch (err) {
      console.warn('[ugc] script fallback:', err.message);
    }
    if (!Array.isArray(result.scenes) || result.scenes.length < 2) result = fallback;
    result.scenes = result.scenes.slice(0, 8).map((scene, index) => ({
      id: cleanText(scene.id, 80) || `scene-${index + 1}`,
      order: index + 1,
      duration: Math.max(2, Math.min(15, Number(scene.duration) || 4)),
      label: cleanText(scene.label, 80) || `Scene ${index + 1}`,
      visual_prompt: cleanText(scene.visual_prompt, 800),
      voiceover: cleanText(scene.voiceover, 600),
      on_screen_text: cleanText(scene.on_screen_text, 160),
      transition: cleanText(scene.transition, 80) || 'quick cut',
    }));
    const now = nowISO();
    db.prepare('UPDATE ugc_projects SET title = ?, plan = ?, status = ?, updated_at = ? WHERE id = ?').run(
      cleanText(result.title, 200) || `${brief.product} UGC Ad`, JSON.stringify({ angle, ...result }), 'scripted', now, projectId,
    );
    res.status(201).json({ project: projectRow(db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(projectId)), planner });
  } catch (err) { next(err); }
});

ugc.put('/projects/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(req.params.id);
    if (!row) throw new HttpError(404, 'UGC project not found.');
    if (!req.body?.plan || typeof req.body.plan !== 'object') throw badRequest('A valid UGC plan is required.');
    const serialized = JSON.stringify(req.body.plan);
    if (serialized.length > 200000) throw badRequest('UGC plan is too large.');
    const status = Array.isArray(req.body.plan.scenes) && req.body.plan.scenes.length ? 'scripted' : 'planned';
    db.prepare('UPDATE ugc_projects SET title = ?, plan = ?, status = ?, updated_at = ? WHERE id = ?').run(
      cleanText(req.body.plan.title, 200) || row.title, serialized, status, nowISO(), req.params.id,
    );
    res.json({ project: projectRow(db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(req.params.id)) });
  } catch (err) { next(err); }
});

ugc.get('/projects', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM ugc_projects ORDER BY updated_at DESC LIMIT 50').all();
    res.json({ projects: rows.map(projectRow) });
  } catch (err) { next(err); }
});

ugc.get('/projects/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(req.params.id);
    if (!row) throw new HttpError(404, 'UGC project not found.');
    res.json({ project: projectRow(row) });
  } catch (err) { next(err); }
});

ugc.post('/assemble', async (req, res, next) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-studio-ugc-'));
  try {
    const projectId = cleanText(req.body?.project_id, 80);
    const projectRowRaw = projectId ? db.prepare('SELECT * FROM ugc_projects WHERE id = ?').get(projectId) : null;
    if (projectId && !projectRowRaw) throw new HttpError(404, 'UGC project not found.');
    const ids = Array.isArray(req.body?.generation_ids) ? req.body.generation_ids.slice(0, 8).map((id) => cleanText(id, 80)).filter(Boolean) : [];
    if (ids.length < 2) throw badRequest('Generate at least two scene videos before exporting the UGC ad.');
    const rows = ids.map((id) => getGeneration(id));
    if (rows.some((row) => !row || row.type !== 'video' || row.status !== 'completed' || !row.file_path)) {
      throw badRequest('Every selected UGC scene must be a completed video in Library.');
    }
    const absFiles = rows.map((row) => resolveStorageFile(row.file_path));
    const concatList = path.join(tempDir, 'scenes.txt');
    await writeFile(concatList, absFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
    const concatenated = path.join(tempDir, 'concatenated.mp4');
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', concatenated], 900000);
    let finalPath = concatenated;
    const audioId = cleanText(req.body?.audio_generation_id, 80);
    if (audioId) {
      const audio = getGeneration(audioId);
      if (!audio || audio.type !== 'audio' || audio.status !== 'completed' || !audio.file_path) throw badRequest('The selected UGC voiceover must be a completed audio item in Library.');
      const audioPath = resolveStorageFile(audio.file_path);
      const muxed = path.join(tempDir, 'final.mp4');
      await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-i', concatenated, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', muxed], 900000);
      finalPath = muxed;
    }
    const buffer = await readFile(finalPath);
    const rel = storage.newRel('mp4');
    const size = await storage.saveBuffer(buffer, rel);
    const id = randomUUID();
    const title = cleanText(req.body?.title, 200) || projectRow(projectRowRaw)?.title || 'UGC Ad Export';
    insertGeneration({ id, type: 'video', mode: 'ugc_export', prompt: title, model: 'local-ffmpeg', status: 'completed', settings: { project_id: projectId || null, scenes: ids.length, audio_id: audioId || null, aspect_ratio: cleanText(req.body?.aspect_ratio, 20) || '9:16' } });
    updateGeneration(id, { file_path: rel, mime_type: 'video/mp4', file_size: size, completed_at: nowISO() });
    if (projectId) db.prepare('UPDATE ugc_projects SET status = ?, updated_at = ? WHERE id = ?').run('exported', nowISO(), projectId);
    res.status(201).json(publicRow(getGeneration(id)));
  } catch (err) { next(err); } finally { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
});

function resolveStorageFile(rel) {
  const root = path.resolve(config.storageDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw badRequest('Invalid stored media path.');
  return full;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new HttpError(504, 'UGC export timed out.')); }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => { clearTimeout(timer); reject(new HttpError(500, `Could not start FFmpeg for UGC export: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new HttpError(500, `FFmpeg could not assemble the UGC export. ${stderr.slice(-700)}`));
    });
  });
}
