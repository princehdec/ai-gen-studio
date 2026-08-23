import { Router } from 'express';
import * as storage from '../storage/index.js';
import { HttpError, publicRow } from '../util.js';
import { deleteGeneration, getGeneration, listGenerations } from '../db.js';

export const generations = Router();

const TYPES = new Set(['video', 'image', 'audio']);
const STATUSES = new Set(['pending', 'processing', 'completed', 'failed']);

/** Unified history: every generation, newest first, filterable + searchable. */
generations.get('/', (req, res) => {
  const type = TYPES.has(req.query.type) ? req.query.type : null;
  const status = STATUSES.has(req.query.status) ? req.query.status : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset ?? '0', 10) || 0, 0);

  const { items, total } = listGenerations({ type, status, q, limit, offset });
  res.json({ items: items.map(publicRow), total, limit, offset });
});

generations.get('/:id', (req, res) => {
  const row = getGeneration(req.params.id);
  if (!row) throw new HttpError(404, 'Generation not found.');
  res.json(publicRow(row));
});

/** Deletes both the history row and the stored file. */
generations.delete('/:id', async (req, res, next) => {
  try {
    const row = getGeneration(req.params.id);
    if (!row) throw new HttpError(404, 'Generation not found.');
    if (row.file_path) await storage.remove(row.file_path);
    deleteGeneration(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
