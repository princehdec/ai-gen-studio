import { Router } from 'express';
import { HttpError } from '../util.js';
import { getProvider, listProviders, saveProvider } from '../providers/config-store.js';
import { listOpenAIModels } from '../providers/index.js';

export const providers = Router();

providers.get('/', (req, res) => {
  res.json({ providers: listProviders() });
});

providers.put('/:id', (req, res, next) => {
  try {
    const { baseUrl, apiKey } = req.body ?? {};
    const provider = saveProvider(req.params.id, { baseUrl, apiKey });
    res.json({
      provider: {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        capabilities: provider.capabilities,
        configured: provider.configured,
        keyHint: provider.apiKey ? `${provider.apiKey.slice(0, 4)}••••${provider.apiKey.slice(-4)}` : null,
      },
    });
  } catch (err) {
    next(new HttpError(400, err.message));
  }
});

providers.post('/:id/test', async (req, res, next) => {
  try {
    const saved = getProvider(req.params.id);
    if (!saved) throw new HttpError(400, `Unknown provider "${req.params.id}".`);
    const enteredKey = String(req.body?.apiKey || '').trim();
    const apiKey = enteredKey || saved.apiKey;
    if (saved.requiresApiKey && !apiKey) throw new HttpError(401, `${saved.name} API key is not configured. Enter a key, or save one first.`);

    const provider = { ...saved, apiKey, configured: true };
    const models = await listOpenAIModels(provider);
    return res.json({
      ok: true,
      provider: provider.id,
      model_count: models.length,
      saved: Boolean(saved.apiKey),
      local: saved.requiresApiKey === false,
    });
  } catch (err) {
    next(err);
  }
});
