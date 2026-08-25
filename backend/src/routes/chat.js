import { Router } from 'express';
import { config } from '../config.js';
import { badRequest, publicRow } from '../util.js';
import { createOpenAIChat, listOpenAIModels, requireProvider } from '../providers/index.js';
import { getProvider } from '../providers/config-store.js';

export const chat = Router();

chat.get('/models', async (req, res, next) => {
  try {
    const provider = requireProvider(req.query.provider || 'openrouter', 'chat');
    const models = await listOpenAIModels(provider);
    res.json({ models, default_model: provider.defaultModel || (provider.id === 'openrouter' ? config.defaults.chatModel : '') });
  } catch (err) { next(err); }
});

chat.post('/', async (req, res, next) => {
  try {
    const {
      prompt,
      provider = 'openrouter',
      model,
      system,
      temperature,
      max_tokens,
    } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw badRequest('A prompt is required.');
    }
    const providerConfig = requireProvider(provider, 'chat');
    const selectedModel = String(model || providerConfig.defaultModel || (providerConfig.id === 'openrouter' ? config.defaults.chatModel : '')).trim();
    if (!selectedModel) throw badRequest(`Enter a ${providerConfig.name} model ID.`);

    const messages = [];
    if (typeof system === 'string' && system.trim()) messages.push({ role: 'system', content: system.trim() });
    messages.push({ role: 'user', content: prompt.trim() });
    const response = await createOpenAIChat(providerConfig, {
      model: selectedModel,
      messages,
      stream: false,
      ...(Number.isFinite(Number(temperature)) ? { temperature: Number(temperature) } : {}),
      ...(Number.isInteger(Number(max_tokens)) ? { max_tokens: Number(max_tokens) } : {}),
    });
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw badRequest(`${providerConfig.name} returned no text output.`);
    res.status(201).json({
      type: 'chat',
      provider: providerConfig.id,
      model: payload.model || selectedModel,
      prompt: prompt.trim(),
      text,
      usage: payload.usage || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});
