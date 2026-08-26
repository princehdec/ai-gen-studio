/* AI Gen Studio — vanilla SPA. No build step, no dependencies. */
'use strict';

/* ------------------------------ tiny helpers ----------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
};

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

async function api(path, { method = 'GET', body } = {}) {
  let res;
  let networkError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      networkError = null;
      break;
    } catch (err) {
      networkError = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (networkError) {
    throw new Error('The local backend is unavailable or restarting. Please wait a moment and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (HTTP ${res.status}).`);
  return data;
}

async function uploadApi(path, formData) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', body: formData });
  } catch {
    throw new Error('The local backend is unavailable or restarting. Please wait a moment and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (HTTP ${res.status}).`);
  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 15 * 1024 * 1024) {
      reject(new Error(`"${file.name}" is larger than 15 MB — pick a smaller image.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

function audioReferenceToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const allowed = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac']);
    if (!allowed.has(String(file?.type || '').toLowerCase())) return reject(new Error('Reference audio must be WAV, MP3, M4A, OGG/Opus or FLAC.'));
    if (file.size > 15 * 1024 * 1024) return reject(new Error('Reference audio must be 15 MB or smaller.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

async function getVoiceReferencePayload() {
  const file = $('#a-voice-reference')?.files?.[0];
  if (!file) return {};
  if (!$('#a-voice-rights')?.checked) throw new Error('Confirm that you own this voice or have permission to use the reference recording.');
  return {
    reference_audio: await audioReferenceToDataUrl(file),
    reference_transcript: $('#a-voice-reference-transcript')?.value.trim() || undefined,
    rights_confirmed: true,
  };
}

/* ------------------------ local workspace memory ------------------------- */
let currentTab = 'video';
const MEMORY_KEY = 'ai-gen-studio:workspace-settings:v1';
const rememberedFields = [
  'v-provider', 'v-model', 'v-duration', 'v-resolution', 'v-aspect', 'v-audio', 'v-batch-count',
  'i-provider', 'i-model', 'i-aspect', 'i-count', 'i-format', 'i-batch-count',
  'a-provider', 'a-model', 'a-voice', 'a-format', 'a-text', 'a-preview-text', 'a-voice-reference-transcript', 'a-batch-count',
  'ugc-product', 'ugc-audience', 'ugc-goal', 'ugc-offer', 'ugc-platform', 'ugc-duration', 'ugc-tone', 'ugc-language', 'ugc-planner-provider', 'ugc-planner-model', 'ugc-video-model', 'ugc-scene-batch', 'ugc-character-asset', 'ugc-product-asset', 'ugc-voiceover',
  'c-provider', 'c-model', 'c-system', 'c-temperature', 'c-max-tokens',
  'e-method', 'e-scale', 'h-search',
];
const rememberedRadioGroups = ['v-mode', 'a-mode', 'e-mode'];

function readWorkspaceMemory() {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}'); } catch { return {}; }
}

function restoreWorkspaceSettings() {
  const memory = readWorkspaceMemory();
  for (const id of rememberedFields) {
    const el = document.getElementById(id);
    if (!el || memory[id] === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(memory[id]);
    else { el.value = String(memory[id]); if (id.endsWith('-model')) el.dataset.remembered = 'true'; }
  }
  for (const name of rememberedRadioGroups) {
    const value = memory[`radio:${name}`];
    if (value) {
      const radio = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
      if (radio) radio.checked = true;
    }
  }
}

function saveWorkspaceSettings() {
  const memory = readWorkspaceMemory();
  for (const id of rememberedFields) {
    const el = document.getElementById(id);
    if (!el) continue;
    memory[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  for (const name of rememberedRadioGroups) {
    const radio = document.querySelector(`input[name="${name}"]:checked`);
    if (radio) memory[`radio:${name}`] = radio.value;
  }
  if (typeof currentTab === 'string') memory.activeTab = currentTab;
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* storage may be unavailable */ }
}

restoreWorkspaceSettings();
for (const id of rememberedFields) {
  const el = document.getElementById(id);
  el?.addEventListener('input', saveWorkspaceSettings);
  el?.addEventListener('change', saveWorkspaceSettings);
}
for (const name of rememberedRadioGroups) {
  $$(`input[name="${name}"]`).forEach((radio) => radio.addEventListener('change', saveWorkspaceSettings));
}

/* --------------------------------- tabs ---------------------------------- */
const studioComposerTabs = new Set(['video', 'ugc', 'image', 'audio', 'enhance', 'chat', 'labs']);
function syncStudioSurface(tab = currentTab) {
  const hero = $('.studio-hero');
  const gallery = $('.studio-gallery');
  if (hero) hero.hidden = !studioComposerTabs.has(tab);
  if (gallery) gallery.hidden = !(tab === 'history' || (studioComposerTabs.has(tab) && tab !== 'chat'));
  document.body.dataset.workspace = tab;
  const chatThread = $('#studio-chat-thread');
  const chatResult = $('#c-result');
  if (chatThread && chatResult) {
    if (chatResult.parentNode !== chatThread) chatThread.append(chatResult);
    chatThread.hidden = tab !== 'chat';
  }
}

$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => {
    const selected = b === btn;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  $$('.panel').forEach((p) => {
    const active = p.id === `tab-${btn.dataset.tab}`;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
  currentTab = btn.dataset.tab;
  syncStudioSurface(currentTab);
  saveWorkspaceSettings();
  const selectedPanel = document.getElementById(`tab-${currentTab}`);
  const shellTarget = currentTab === 'history'
    ? $('.studio-gallery')
    : studioComposerTabs.has(currentTab)
      ? $('.studio-hero')
      : selectedPanel;
  if (shellTarget) requestAnimationFrame(() => shellTarget.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  if (currentTab === 'history') loadHistory(true).catch((err) => showError('#v-error', err));
}));
const rememberedTab = readWorkspaceMemory().activeTab;
if (rememberedTab) document.querySelector(`.tab[data-tab="${CSS.escape(rememberedTab)}"]`)?.click();
syncStudioSurface(currentTab);

/* ------------------------------- model lists ------------------------------ */
const MODEL_KINDS = ['video', 'image', 'audio'];
const providerByKind = { video: '#v-provider', image: '#i-provider', audio: '#a-provider', chat: '#c-provider' };
const routeForKind = { video: 'videos', image: 'images', audio: 'audio' };
const endpointForKind = (kind, provider) => {
  if (kind === 'chat') return `/api/v1/chat/models?provider=${encodeURIComponent(provider)}`;
  if (kind === 'audio') {
    const mode = $('input[name="a-mode"]:checked')?.value || 'speech';
    return `/api/v1/audio/models?provider=${encodeURIComponent(provider)}&mode=${encodeURIComponent(mode)}`;
  }
  return `/api/v1/${routeForKind[kind]}/models?provider=${encodeURIComponent(provider)}`;
};

async function loadModels(kind, provider = $(providerByKind[kind])?.value || 'openrouter') {
  try {
    const { models, default_model } = await api(endpointForKind(kind, provider));
    const list = $(`#dl-${kind}`);
    if (list) list.innerHTML = (models || []).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    const hint = $(`#${kind[0]}-model-hint`);
    if (hint) hint.textContent = default_model ? `Default: ${default_model}` : `${models?.length || 0} models available`;
    if (kind === 'audio' && default_model) {
      const modelInput = $('#a-model');
      const mode = $('input[name="a-mode"]:checked')?.value || 'speech';
      if (modelInput && (!modelInput.value || (!modelInput.dataset.remembered && modelInput.dataset.mode !== mode))) {
        modelInput.value = default_model;
        modelInput.dataset.mode = mode;
      }
    }
    if (kind === 'chat' && default_model) {
      const modelInput = $('#c-model');
      if (modelInput && (!modelInput.value || !modelInput.dataset.remembered)) modelInput.value = default_model;
    }
  } catch (err) {
    const hint = $(`#${kind[0]}-model-hint`);
    if (hint) hint.textContent = kind === 'chat' && provider === 'ollama'
      ? 'Ollama is offline — start Ollama; Gemma 4 E4B remains selected.'
      : 'Could not load models — enter an ID manually';
    if (kind === 'chat' && provider === 'ollama' && !$('#c-model')?.value) $('#c-model').value = 'gemma4:e4b';
  }
}
for (const kind of MODEL_KINDS) loadModels(kind);
loadModels('chat');

/* --------------------------- provider status ------------------------------ */
let providerState = [];
api('/api/v1/providers').then(({ providers }) => {
  providerState = providers || [];
  const configured = providerState.filter((p) => p.configured).length;
  const el = $('#key-status');
  if (el) {
    el.hidden = false;
    el.classList.add(configured ? 'good' : 'bad');
    el.textContent = configured ? `${configured} provider${configured > 1 ? 's' : ''} connected` : 'Setup a provider to start';
  }
  syncProviderOptions();
}).catch(() => {});

function syncProviderOptions() {
  const map = {
    video: ['#v-provider', 'video'],
    image: ['#i-provider', 'image'],
    audio: ['#a-provider', 'audio'],
    chat: ['#c-provider', 'chat'],
    planner: ['#ugc-planner-provider', 'chat'],
  };
  for (const [kind, [selector, capability]] of Object.entries(map)) {
    const select = $(selector);
    if (!select) continue;
    for (const option of select.options) {
      const provider = providerState.find((p) => p.id === option.value);
      const supported = Boolean(provider?.capabilities.includes(capability));
      option.disabled = Boolean(provider && !supported);
      option.textContent = provider
        ? `${provider.name}${supported ? '' : ' (Chat only)'}${provider.configured ? '' : ' (not configured)'}`
        : option.textContent;
    }
  }
}

for (const [kind, selector] of Object.entries(providerByKind)) {
  $(selector)?.addEventListener('change', () => {
    loadModels(kind);
    if (kind === 'image') $('#i-inputs').disabled = $(selector).value !== 'openrouter';
    if (kind === 'video') $('#v-modes input[value="t2v"]').checked = $(selector).value === 'huggingface' ? true : $('#v-modes input:checked').checked;
  });
}

/* ---------------------------- shared card render -------------------------- */
const MODE_LABELS = {
  t2v: 'text→video', i2v: 'image→video', first_last: 'first+last frame',
  reference: 'reference', t2i: 'text→image', i2i_edit: 'editing',
  speech: 'speech', music: 'music',
};

function settingsChips(gen) {
  const s = gen.settings || {};
  const chips = [];
  if (gen.mode && MODE_LABELS[gen.mode]) chips.push(MODE_LABELS[gen.mode]);
  if (s.duration) chips.push(`${s.duration}s`);
  if (s.resolution) chips.push(s.resolution);
  if (s.aspect_ratio) chips.push(s.aspect_ratio);
  if (s.voice) chips.push(`voice: ${s.voice}`);
  if (s.format) chips.push(String(s.format).toUpperCase());
  if (s.n > 1) chips.push(`${s.n} images`);
  if (s.inputs) chips.push(`${s.inputs} ref${s.inputs > 1 ? 's' : ''}`);
  if (s.transcript) chips.push(`transcript: ${s.transcript.slice(0, 60)}${s.transcript.length > 60 ? '…' : ''}`);
  if (typeof gen.cost === 'number' && gen.cost > 0) chips.push(`$${gen.cost.toFixed(4)}`);
  return chips.map((c) => `<span class="mini">${esc(c)}</span>`).join('');
}

function previewHTML(gen) {
  if (gen.status === 'completed' && gen.file_url) {
    if (gen.type === 'video') {
      return `<video controls preload="metadata" src="${esc(gen.file_url)}"></video>`;
    }
    if (gen.type === 'image') {
      return `<img loading="lazy" src="${esc(gen.file_url)}" alt="${esc(gen.prompt.slice(0, 80))}">`;
    }
    return `<div class="audio-art">🎧</div><audio controls preload="metadata" src="${esc(gen.file_url)}"></audio>`;
  }
  if (gen.status === 'failed') {
    return `<div class="failed-preview"><span>⚠️</span><span class="stage-note">${esc(gen.error || 'Generation failed')}</span></div>`;
  }
  return '<div class="spinner"></div><div class="stage-note">Working…</div>';
}

function renderCard(gen, { live = false } = {}) {
  const el = document.createElement('article');
  el.className = 'gen-card';
  el.dataset.id = gen.id;
  const pill = live && (gen.status === 'pending' || gen.status === 'processing')
    ? `<div class="status-pill" data-created="${esc(gen.created_at)}" data-status="${esc(gen.status)}"><span class="dot"></span><span class="pill-text">${pillText(gen)}</span></div>`
    : '';
  el.innerHTML = `
    <div class="preview">${pill}${previewHTML(gen)}</div>
    <div class="card-body">
      <p class="prompt-line" title="${esc(gen.prompt)}">${esc(gen.prompt)}</p>
      <div class="meta">
        <span class="badge ${esc(gen.type)}">${esc(gen.type)}</span>
        <span class="model-code" title="${esc(gen.model)}">${esc(gen.model)}</span>
        <span>${fmtDate(gen.created_at)}</span>
        ${gen.file_size ? `<span>${fmtBytes(gen.file_size)}</span>` : ''}
      </div>
      ${settingsChips(gen) ? `<div class="chips">${settingsChips(gen)}</div>` : ''}
      ${!live && gen.error ? `<div class="err-line">⚠️ ${esc(gen.error)}</div>` : ''}
      <div class="actions">
        ${gen.file_url ? `<a class="dl" href="${esc(gen.file_url)}" download>⬇ Download</a>` : ''}
        <button type="button" class="del">Delete</button>
      </div>
    </div>`;
  el.querySelector('.del').addEventListener('click', () => deleteGeneration(gen, el));
  return el;
}

function pillText(gen) {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(gen.created_at)) / 1000));
  const mins = Math.floor(secs / 60);
  const elapsed = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
  return `${gen.status === 'pending' ? 'Queued' : 'Generating'} · ${elapsed}`;
}

// Keep the "Generating · 42s" pills ticking.
setInterval(() => {
  $$('.status-pill[data-created]').forEach((pill) => {
    $('.pill-text', pill).textContent = pillText({
      status: pill.dataset.status,
      created_at: pill.dataset.created,
    });
  });
}, 1000);

async function deleteGeneration(gen, el) {
  if (!confirm(`Delete this ${gen.type} permanently?\nThe stored file will be removed from disk.`)) return;
  try {
    await api(`/api/v1/generations/${gen.id}`, { method: 'DELETE' });
    el.remove();
    activeJobs.delete(gen.id);
    updateJobsEmpty();
    if (currentTab === 'history') loadHistory(true);
  } catch (err) {
    alert(err.message);
  }
}

/* ------------------------------ error banners ----------------------------- */
let toastTimer;
function showToast(message) {
  let root = $('#toast-root');
  if (!root) { root = document.createElement('div'); root.id = 'toast-root'; root.setAttribute('aria-live', 'polite'); document.body.appendChild(root); }
  const toast = document.createElement('div');
  toast.className = 'toast toast-error';
  toast.textContent = String(message || 'Something went wrong.');
  root.replaceChildren(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 5200);
}
let inlineErrorTimer;
function showError(id, err) {
  const el = $(id);
  if (el) { el.hidden = false; el.innerHTML = `<strong>Something went wrong:</strong> ${esc(err.message)}`; }
  const inline = $('#studio-inline-error');
  if (inline) {
    inline.hidden = false;
    inline.textContent = String(err.message || 'Something went wrong.');
    clearTimeout(inlineErrorTimer);
    inlineErrorTimer = setTimeout(() => { inline.hidden = true; }, 7000);
  }
  showToast(err.message);
}
const clearError = (id) => { $(id)?.setAttribute('hidden', 'true'); $('#studio-inline-error')?.setAttribute('hidden', 'true'); };

function setStudioRunBusy(isBusy, label = 'Generating…') {
  const btn = $('#studio-run');
  if (!btn) return;
  btn.classList.toggle('is-busy', isBusy);
  btn.disabled = isBusy;
  btn.setAttribute('aria-busy', String(isBusy));
  btn.textContent = isBusy ? label : (btn.dataset.label || 'Generate ↗');
}
function busy(btn, isBusy, label) {
  btn.disabled = isBusy;
  btn.textContent = isBusy ? label : btn.dataset.label;
  if (btn.closest('#studio-inline-content')) setStudioRunBusy(isBusy, label);
}

/* ------------------------------ batch queue -------------------------------- */
const batchStates = new Map();
const batchSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBatch({ type, count, button, statusId, cancelId, submit, onSuccess, concurrency = 2 }) {
  const total = Math.max(1, Math.min(100, Number(count) || 1));
  const state = { next: 0, done: 0, failed: 0, cancelled: false };
  batchStates.set(type, state);
  const status = $(statusId);
  const cancel = $(cancelId);
  const updateStatus = (prefix = 'Queued') => {
    const skipped = total - state.next;
    const remaining = Math.max(0, total - state.done - state.failed);
    const suffix = state.cancelled ? ` · ${skipped} pending cancelled` : ` · ${remaining} remaining`;
    if (status) status.textContent = `${prefix}: ${state.done + state.failed}/${total} complete${suffix}`;
  };
  if (cancel) { cancel.hidden = false; cancel.onclick = () => { state.cancelled = true; updateStatus('Cancelling'); }; }
  updateStatus();
  try {
    const worker = async () => {
      while (!state.cancelled) {
        const index = state.next++;
        if (index >= total) return;
        try {
          const result = await submit(index);
          await onSuccess(result, index);
          state.done += 1;
        } catch (err) {
          state.failed += 1;
          console.warn(`[batch:${type}] item ${index + 1} failed:`, err.message);
        }
        updateStatus();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  } finally {
    if (batchStates.get(type) === state) batchStates.delete(type);
    if (cancel) { cancel.hidden = true; cancel.onclick = null; }
    if (status) {
      const cancelled = state.cancelled && state.next < total;
      status.textContent = cancelled
        ? `Cancelled · ${state.done} complete, ${state.failed} failed`
        : `Finished · ${state.done} complete${state.failed ? `, ${state.failed} failed` : ''}`;
    }
    busy(button, false);
  }
}

async function waitForVideoTerminal(gen) {
  if (!gen?.id || ['completed', 'failed'].includes(gen.status)) return gen;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    await batchSleep(4000);
    try {
      const current = await api(`/api/v1/videos/${encodeURIComponent(gen.id)}`);
      if (current.status === 'completed' || current.status === 'failed') return current;
    } catch { /* next poll retries */ }
  }
  return gen;
}

/* ================================ VIDEO =================================== */
const activeJobs = new Map(); // id -> { el }

$$('#v-modes input').forEach((radio) => radio.addEventListener('change', syncVideoModeFields));
function syncVideoModeFields() {
  const mode = $('#v-modes input:checked').value;
  $('#v-first-wrap').hidden = !(mode === 'i2v' || mode === 'first_last');
  $('#v-last-wrap').hidden = mode !== 'first_last';
  $('#v-refs-wrap').hidden = mode !== 'reference';
}

$('#v-duration').addEventListener('input', () => {
  $('#v-duration-out').textContent = `${$('#v-duration').value}s`;
});

$('#video-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errId = '#v-error';
  clearError(errId);
  const btn = $('#v-submit');
  btn.dataset.label ??= btn.textContent;

  const mode = $('#v-modes input:checked').value;
  const prompt = $('#v-prompt').value.trim();
  if (!prompt) return showError(errId, new Error('Please enter a prompt.'));

  const needsFirst = mode === 'i2v' || mode === 'first_last';
  const firstFile = $('#v-first').files[0];
  const lastFile = $('#v-last').files[0];
  const refFiles = [...$('#v-refs').files];
  if (needsFirst && !firstFile) return showError(errId, new Error('This mode requires a first-frame image.'));
  if (mode === 'first_last' && !lastFile) return showError(errId, new Error('First + Last frame mode also needs a last-frame image.'));
  if (mode === 'reference' && !refFiles.length) return showError(errId, new Error('Reference mode needs at least one reference image.'));

  busy(btn, true, 'Queueing…');
  try {
    const payload = {
      prompt,
      provider: $('#v-provider').value,
      model: $('#v-model').value.trim() || undefined,
      mode,
      duration: Number($('#v-duration').value),
      resolution: $('#v-resolution').value,
      aspect_ratio: $('#v-aspect').value,
      generate_audio: $('#v-audio').checked,
    };
    if (needsFirst) payload.first_frame = await fileToDataUrl(firstFile);
    if (mode === 'first_last') payload.last_frame = await fileToDataUrl(lastFile);
    if (mode === 'reference') payload.references = await Promise.all(refFiles.map(fileToDataUrl));
    await runBatch({
      type: 'video',
      count: $('#v-batch-count').value,
      button: btn,
      statusId: '#v-batch-status',
      cancelId: '#v-batch-cancel',
      concurrency: 1,
      submit: () => api('/api/v1/videos', { method: 'POST', body: payload }),
      onSuccess: async (gen) => { trackJob(gen); await waitForVideoTerminal(gen); },
    });
    $('#tab-video').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(errId, err);
    busy(btn, false);
  }
});

function trackJob(gen) {
  if (activeJobs.has(gen.id)) return;
  const el = renderCard(gen, { live: true });
  activeJobs.set(gen.id, { el, gen });
  $('#v-jobs-empty').hidden = true;
  $('#v-jobs').prepend(el);
}

function updateJobsEmpty() {
  $('#v-jobs-empty').hidden = activeJobs.size > 0;
}

// Poll the server every 3 s; the server itself polls OpenRouter and
// auto-downloads finished videos to permanent storage.
setInterval(async () => {
  for (const [id, job] of [...activeJobs]) {
    let gen;
    try {
      gen = await api(`/api/v1/videos/${id}`);
    } catch {
      continue; // transient network blip — retry next tick
    }
    if (gen.status === 'completed' || gen.status === 'failed') {
      const fresh = renderCard(gen);
      job.el.replaceWith(fresh);
      activeJobs.delete(id);
      updateJobsEmpty();
      historyDirty = true;
      if (gen.status === 'completed') refreshHistoryCount();
    }
  }
}, 3000);

/* ------------------------------- IMAGE tab -------------------------------- */
$('#image-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errId = '#i-error';
  clearError(errId);
  const btn = $('#i-submit');
  btn.dataset.label ??= btn.textContent;

  const prompt = $('#i-prompt').value.trim();
  if (!prompt) return showError(errId, new Error('Please enter a prompt.'));
  const files = [...$('#i-inputs').files];

  busy(btn, true, 'Queueing…');
  try {
    const payload = {
      prompt,
      provider: $('#i-provider').value,
      model: $('#i-model').value.trim() || undefined,
      n: Number($('#i-count').value),
      aspect_ratio: $('#i-aspect').value || undefined,
      output_format: $('#i-format').value,
      input_images: await Promise.all(files.map(fileToDataUrl)),
    };
    await runBatch({
      type: 'image',
      count: $('#i-batch-count').value,
      button: btn,
      statusId: '#i-batch-status',
      cancelId: '#i-batch-cancel',
      submit: () => api('/api/v1/images', { method: 'POST', body: payload }),
      onSuccess: (gens) => { gens.reverse().forEach((g) => $('#i-results').prepend(renderCard(g))); },
    });
    refreshHistoryCount();
  } catch (err) {
    showError(errId, err);
    busy(btn, false);
  }
});

/* ------------------------------- AUDIO tab -------------------------------- */
let previewUrl = null;
const previewControl = $('#a-preview-control');
const previewButton = $('#a-preview');
const previewPlayer = $('#a-preview-player');
const previewStatus = $('#a-preview-status');

$$('input[name="a-mode"]').forEach((r) => r.addEventListener('change', () => {
  const music = $('input[name="a-mode"]:checked').value === 'music';
  $('#a-text-label').textContent = music ? 'Describe the music / sound effect' : 'Script to narrate';
  $('#a-text').placeholder = music
    ? 'Upbeat lo-fi hip hop track with vinyl crackle, mellow piano and rain ambience'
    : 'Welcome to AI Gen Studio. In today\'s episode…';
  $('#a-voice-wrap').style.display = music ? 'none' : '';
  if (previewControl) previewControl.hidden = music;
  if ($('#a-clone-control')) $('#a-clone-control').hidden = music;
  $('#a-model').dataset.remembered = 'false';
  loadModels('audio');
}));

previewButton?.addEventListener('click', async () => {
  const text = $('#a-preview-text').value.trim();
  const model = $('#a-model').value.trim();
  if (!text) { previewStatus.textContent = 'Enter a short preview sentence first.'; return; }
  if ($('#a-provider').value !== 'openrouter') { previewStatus.textContent = 'Voice preview currently requires OpenRouter.'; return; }
  previewButton.disabled = true;
  previewButton.textContent = 'Generating preview…';
  previewStatus.textContent = 'Creating a short sample…';
  try {
    const response = await fetch('/api/v1/audio/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('#a-provider').value,
        model,
        prompt: text,
        voice: $('#a-voice').value,
        ...(await getVoiceReferencePayload()),
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error?.message || `Preview failed (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    previewPlayer.src = previewUrl;
    previewPlayer.hidden = false;
    previewStatus.textContent = 'Preview ready. Press play to listen again.';
    await previewPlayer.play().catch(() => {});
  } catch (err) {
    previewStatus.textContent = err.message;
  } finally {
    previewButton.disabled = false;
    previewButton.textContent = 'Preview selected voice';
  }
});

$('#a-provider')?.addEventListener('change', () => {
  if (previewButton) previewButton.disabled = $('#a-provider').value !== 'openrouter';
});
$('input[name="a-mode"]:checked')?.dispatchEvent(new Event('change'));

$('#audio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errId = '#a-error';
  clearError(errId);
  const btn = $('#a-submit');
  btn.dataset.label ??= btn.textContent;

  const prompt = $('#a-text').value.trim();
  if (!prompt) return showError(errId, new Error('Enter some text first.'));

  busy(btn, true, 'Queueing…');
  try {
    const payload = {
      prompt,
      provider: $('#a-provider').value,
      mode: $('input[name="a-mode"]:checked').value,
      model: $('#a-model').value.trim() || undefined,
      voice: $('#a-voice').value,
      format: $('#a-format').value,
      ...(await getVoiceReferencePayload()),
    };
    await runBatch({
      type: 'audio',
      count: $('#a-batch-count').value,
      button: btn,
      statusId: '#a-batch-status',
      cancelId: '#a-batch-cancel',
      submit: () => api('/api/v1/audio', { method: 'POST', body: payload }),
      onSuccess: (gen) => { $('#a-results').prepend(renderCard(gen)); },
    });
    refreshHistoryCount();
  } catch (err) {
    showError(errId, err);
    busy(btn, false);
  }
});

/* ----------------------------- enhance tab -------------------------------- */
function syncEnhanceMode() {
  const mode = $('input[name="e-mode"]:checked')?.value || 'upscale';
  $('#e-upscale-fields').hidden = mode !== 'upscale';
  $('#e-cleanup-fields').hidden = mode !== 'cleanup';
  $('#e-submit').textContent = mode === 'cleanup' ? 'Start cleanup' : 'Start enhancement';
}
$$('input[name="e-mode"]').forEach((radio) => radio.addEventListener('change', syncEnhanceMode));
syncEnhanceMode();

api('/api/v1/enhance/capabilities').then((caps) => {
  const hint = $('#e-capability-hint');
  const method = $('#e-method');
  const realOption = method?.querySelector('option[value="realesrgan"]');
  const cleanupMode = $('#e-cleanup-mode');
  const cleanupNotice = $('#e-cleanup-notice');
  if (realOption) realOption.disabled = !caps.realesrgan;
  if (cleanupMode) cleanupMode.disabled = !caps.propainter;
  if (hint) hint.textContent = [
    caps.ffmpeg ? 'FFmpeg ready' : 'FFmpeg unavailable',
    caps.realesrgan ? 'Real-ESRGAN AI ready' : 'Real-ESRGAN optional',
    caps.propainter ? 'ProPainter cleanup ready' : 'ProPainter optional',
  ].join(' · ');
  if (cleanupNotice && caps.propainter) cleanupNotice.textContent = 'ProPainter is ready. Use it only for your own, licensed or otherwise authorized footage; not for removing someone else’s attribution or rights notice.';
  if (!caps.propainter && $('input[name="e-mode"]:checked')?.value === 'cleanup') {
    $('#e-modes input[value="upscale"]').checked = true;
    syncEnhanceMode();
  }
}).catch(() => {
  const hint = $('#e-capability-hint');
  const cleanupMode = $('#e-cleanup-mode');
  if (cleanupMode) cleanupMode.disabled = true;
  if (hint) hint.textContent = 'FFmpeg fallback available · optional AI tools not detected';
});

$('#enhance-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errId = '#e-error';
  clearError(errId);
  const btn = $('#e-submit');
  const mode = $('input[name="e-mode"]:checked').value;
  const video = $('#e-video').files[0];
  const mask = $('#e-mask').files[0];
  if (!video) return showError(errId, new Error('Choose a source video first.'));
  if (mode === 'cleanup' && !mask) return showError(errId, new Error('Choose a frame mask for cleanup.'));
  if (mode === 'cleanup' && !$('#e-rights').checked) return showError(errId, new Error('Confirm that you own or are authorized to edit this video.'));

  const formData = new FormData();
  formData.append('video', video);
  formData.append('mode', mode);
  formData.append('method', mode === 'cleanup' ? 'propainter' : $('#e-method').value);
  formData.append('scale', $('#e-scale').value);
  if (mask) formData.append('mask', mask);
  formData.append('rightsConfirmed', String($('#e-rights').checked));

  busy(btn, true, mode === 'cleanup' ? 'Cleaning…' : 'Enhancing…');
  try {
    const result = await uploadApi('/api/v1/enhance', formData);
    $('#e-results').prepend(renderCard(result));
    $('#e-empty').hidden = true;
    refreshHistoryCount();
  } catch (err) {
    showError(errId, err);
  } finally {
    busy(btn, false);
  }
});

/* =============================== HISTORY =================================== */
const H_PAGE = 24;
let hState = { type: '', q: '', offset: 0, total: 0 };
let historyDirty = true;

$('#h-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#h-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
  hState.type = chip.dataset.type;
  loadHistory(true);
});

let searchTimer;
$('#h-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    hState.q = $('#h-search').value.trim();
    loadHistory(true);
  }, 350);
});

$('#h-more').addEventListener('click', () => {
  hState.offset += H_PAGE;
  loadHistory(false);
});

async function loadHistory(reset) {
  if (reset) hState.offset = 0;
  const params = new URLSearchParams({ limit: H_PAGE, offset: hState.offset });
  if (hState.type) params.set('type', hState.type);
  if (hState.q) params.set('q', hState.q);

  const { items, total } = await api(`/api/v1/generations?${params}`);
  hState.total = total;
  if (reset) $('#h-grid').replaceChildren();

  const frag = document.createDocumentFragment();
  for (const gen of items) frag.appendChild(renderCard(gen));
  $('#h-grid').appendChild(frag);

  $('#h-empty').hidden = total !== 0;
  $('#h-more').hidden = hState.offset + items.length >= total;
}

function refreshHistoryCount() {
  historyDirty = true;
  if (currentTab === 'history') loadHistory(true);
  if (typeof refreshStudioGallery === 'function') refreshStudioGallery();
}

/* ------------------------- restore in-flight jobs -------------------------- */
(async () => {
  try {
    const [pending, processing] = await Promise.all([
      api('/api/v1/generations?status=pending&type=video&limit=50'),
      api('/api/v1/generations?status=processing&type=video&limit=50'),
    ]);
    [...pending.items, ...processing.items].forEach(trackJob);
  } catch { /* server not ready yet — not fatal */ }
})();


/* ------------------------------- chat tab -------------------------------- */
$('#chat-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errId = '#c-error';
  clearError(errId);
  const btn = $('#c-submit');
  btn.dataset.label ??= btn.textContent;
  const prompt = $('#c-prompt').value.trim();
  if (!prompt) return showError(errId, new Error('Enter a message first.'));
  busy(btn, true, 'Sending…');
  try {
    const result = await api('/api/v1/chat', {
      method: 'POST',
      body: {
        provider: $('#c-provider').value,
        model: $('#c-model').value.trim() || undefined,
        system: $('#c-system').value.trim() || undefined,
        prompt,
        temperature: Number($('#c-temperature').value),
        max_tokens: $('#c-max-tokens').value ? Number($('#c-max-tokens').value) : undefined,
      },
    });
    $('#c-result').className = 'chat-result';
    $('#c-result').innerHTML = `<div class="chat-result-meta">${esc(result.provider)} · ${esc(result.model)}</div><div class="chat-result-text">${esc(result.text).replace(/\n/g, '<br>')}</div>`;
  } catch (err) {
    showError(errId, err);
  } finally {
    busy(btn, false);
  }
});

/* ----------------------------- provider settings -------------------------- */
const settingsDialog = $('#settings-dialog');
const settingsOpen = $('#settings-open');
const settingsContainer = $('#provider-settings');
const settingsStatus = $('#settings-status');

function renderProviderSettings() {
  settingsContainer.replaceChildren();
  for (const provider of providerState) {
    const card = document.createElement('section');
    card.className = 'provider-card';
    card.dataset.provider = provider.id;
    const keyField = provider.requiresApiKey === false
      ? '<p class="field-help local-provider-note">Local runtime · no API key required</p>'
      : `<label class="field"><span class="field-label">API key <small>(blank keeps the saved key)</small></span><span class="saved-key-state">${provider.configured ? `Saved key: ${esc(provider.keyHint || '••••••••')}` : 'No key saved yet'}</span><input class="provider-api-key" type="password" placeholder="${provider.configured ? 'Click to replace saved key' : 'Click to enter API key'}" autocomplete="new-password" readonly /></label>`;
    card.innerHTML = `
      <div class="provider-card-head"><div><h3>${esc(provider.name)}</h3><p>${provider.capabilities.map(esc).join(' · ')}</p></div><span class="provider-state ${provider.configured ? 'configured' : ''}">${provider.configured ? 'Available' : 'Not configured'}</span></div>
      <label class="field"><span class="field-label">Base URL</span><input class="provider-base-url" type="url" value="${esc(provider.baseUrl)}" /></label>
      ${keyField}
      <div class="provider-card-actions"><button type="button" class="btn btn-ghost provider-test" data-provider="${esc(provider.id)}">Test connection</button><span class="hint provider-test-status" aria-live="polite"></span></div>`;
    settingsContainer.appendChild(card);
  }
  settingsContainer.querySelectorAll('.provider-api-key').forEach((input) => {
    input.addEventListener('focus', () => {
      input.removeAttribute('readonly');
      input.value = '';
      input.placeholder = 'Paste a new key';
      input.autocomplete = 'new-password';
    });
  });
}

settingsOpen?.addEventListener('click', async () => {
  try {
    const data = await api('/api/v1/providers');
    providerState = data.providers || providerState;
    renderProviderSettings();
    settingsStatus.textContent = '';
    settingsDialog.showModal();
  } catch (err) {
    settingsStatus.textContent = err.message;
  }
});

settingsContainer?.addEventListener('click', async (e) => {
  const button = e.target.closest('.provider-test');
  if (!button) return;
  const card = button.closest('.provider-card');
  const status = $('.provider-test-status', card);
  button.disabled = true;
  status.textContent = 'Testing…';
  try {
    const enteredKey = $('.provider-api-key', card)?.value.trim() || undefined;
    const result = await api(`/api/v1/providers/${encodeURIComponent(button.dataset.provider)}/test`, {
      method: 'POST',
      body: { apiKey: enteredKey },
    });
    status.textContent = result.local
      ? `Local runtime connected · ${result.model_count ?? 0} models found`
      : result.saved
        ? `Connected · ${result.model_count ?? 0} models found`
        : `Connected with entered key · click Save settings to keep it`;
    card.querySelector('.provider-state').textContent = result.local ? 'Available' : result.saved ? 'Connected' : 'Connection OK (unsaved)';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#settings-reset-memory')?.addEventListener('click', () => {
  localStorage.removeItem(MEMORY_KEY);
  settingsStatus.textContent = 'Remembered choices cleared. Reloading…';
  setTimeout(() => window.location.reload(), 350);
});

$('#settings-save')?.addEventListener('click', async () => {
  const cards = $$('.provider-card', settingsContainer);
  try {
    for (const card of cards) {
      await api(`/api/v1/providers/${encodeURIComponent(card.dataset.provider)}`, {
        method: 'PUT',
        body: {
          baseUrl: $('.provider-base-url', card).value.trim(),
          apiKey: $('.provider-api-key', card).value,
        },
      });
    }
    const data = await api('/api/v1/providers');
    providerState = data.providers || providerState;
    syncProviderOptions();
    renderProviderSettings();
    settingsStatus.textContent = 'Settings saved on this computer.';
    for (const kind of [...MODEL_KINDS, 'chat']) loadModels(kind);
  } catch (err) {
    settingsStatus.textContent = err.message;
  }
});

/* ----------------------------------- About --------------------------------- */
const aboutDialog = $('#about-dialog');
$('#about-open')?.addEventListener('click', async () => {
  try {
    const info = await window.desktopInfo?.get();
    $('#app-version').textContent = info?.version ? `v${info.version}` : 'Development build';
    $('#app-build-info').textContent = info?.packaged
      ? `${info.platform} · ${info.arch} · packaged desktop build`
      : 'Development build · updates require the installed packaged app';
  } catch {
    $('#app-version').textContent = 'Unavailable';
  }
  aboutDialog?.showModal();
});

/* ----------------------------- help & updates ------------------------------ */
const helpDialog = $('#help-dialog');
const helpOpen = $('#help-open');
const updateMessage = $('#update-message');
const updateProgressBar = $('#update-progress-bar');
const updateCheck = $('#update-check');
const updateDownload = $('#update-download');
const updateInstall = $('#update-install');
const updateBridge = window.desktopUpdates;
window.desktopMenu?.onAction((action) => document.getElementById(`${action}-open`)?.click());

function renderUpdateState(state = {}) {
  if (updateMessage) updateMessage.textContent = state.message || 'Update status unavailable.';
  if (updateProgressBar) updateProgressBar.style.width = `${Math.max(0, Math.min(100, Number(state.progress) || 0))}%`;
  if (updateDownload) updateDownload.hidden = state.status !== 'available';
  if (updateInstall) updateInstall.hidden = state.status !== 'downloaded';
  if (updateCheck) updateCheck.disabled = ['checking', 'downloading'].includes(state.status);
}

if (!updateBridge) {
  renderUpdateState({ status: 'dev', message: 'Updates are available after installing a packaged desktop build.' });
} else {
  updateBridge.getStatus().then(renderUpdateState).catch(() => renderUpdateState({ status: 'error', message: 'Could not read update status.' }));
  updateBridge.onState(renderUpdateState);
}
helpOpen?.addEventListener('click', () => helpDialog?.showModal());
updateCheck?.addEventListener('click', async () => {
  renderUpdateState({ status: 'checking', message: 'Checking for updates…' });
  if (updateBridge) renderUpdateState(await updateBridge.check());
});
updateDownload?.addEventListener('click', async () => {
  if (updateBridge) renderUpdateState(await updateBridge.download());
});
updateInstall?.addEventListener('click', () => {
  if (updateBridge) updateBridge.install();
});

/* ============================== UGC STUDIO ================================ */
const UGC_PLATFORM_ASPECTS = {
  tiktok: '9:16', instagram_reels: '9:16', youtube_shorts: '9:16', instagram_feed: '4:5', youtube: '16:9',
};
let ugcState = { project: null, selectedAngle: null, sceneGenerations: [], audioGeneration: null };
let ugcSaveTimer = null;

function ugcShowError(err) {
  const el = $('#ugc-error');
  if (!el) return;
  el.hidden = false;
  el.textContent = err.message || String(err);
}
function ugcClearError() { if ($('#ugc-error')) $('#ugc-error').hidden = true; }
function ugcSetStatus(text) { if ($('#ugc-production-status')) $('#ugc-production-status').textContent = text; }

function ugcPlanFromProject(project) {
  return project?.plan && typeof project.plan === 'object' ? project.plan : {};
}

function renderUgcProject(project) {
  ugcState.project = project;
  const plan = ugcPlanFromProject(project);
  const angles = Array.isArray(plan.angles) ? plan.angles : [];
  ugcState.selectedAngle = plan.angle || ugcState.selectedAngle || angles[0] || null;
  $('#ugc-empty').hidden = true;
  $('#ugc-project-view').hidden = false;
  $('#ugc-project-title').textContent = project.title || plan.title || 'UGC Ad';
  const brief = project.brief || {};
  $('#ugc-project-meta').textContent = `${brief.platform || 'social'} · ${brief.duration || 25}s · ${project.status || 'draft'}`;
  renderUgcAngles();
  renderUgcScript();
  $('#ugc-script').disabled = !ugcState.selectedAngle;
  $('#ugc-produce').disabled = !Array.isArray(plan.scenes) || plan.scenes.length < 2;
  $('#ugc-export').disabled = ugcState.sceneGenerations.length < 2;
  if ($('#ugc-video-model') && !$('#ugc-video-model').value) $('#ugc-video-model').value = $('#v-model')?.value || '';
}

function renderUgcAngles() {
  const host = $('#ugc-angles');
  if (!host) return;
  const angles = Array.isArray(ugcPlanFromProject(ugcState.project).angles) ? ugcPlanFromProject(ugcState.project).angles : [];
  host.replaceChildren();
  angles.forEach((angle, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `ugc-angle-card${ugcState.selectedAngle?.id === angle.id ? ' selected' : ''}`;
    card.innerHTML = `<span class="angle-index">0${index + 1}</span><strong>${esc(angle.title || `Angle ${index + 1}`)}</strong><span class="angle-hook">${esc(angle.hook || '')}</span><small>${esc(angle.description || '')}</small><em>${esc(angle.why_it_works || '')}</em>`;
    card.addEventListener('click', () => {
      ugcState.selectedAngle = angle;
      ugcState.project.plan.angle = angle;
      renderUgcAngles();
      $('#ugc-script').disabled = false;
      saveUgcProjectSoon();
    });
    host.appendChild(card);
  });
}

function renderUgcScript() {
  const plan = ugcPlanFromProject(ugcState.project);
  const editor = $('#ugc-script-editor');
  const empty = $('#ugc-script-empty');
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  if (!scenes.length) {
    editor.hidden = true;
    empty.hidden = false;
    return;
  }
  editor.hidden = false;
  empty.hidden = true;
  $('#ugc-creator-direction').value = plan.creator_direction || '';
  $('#ugc-full-script').value = plan.script || scenes.map((scene) => scene.voiceover).filter(Boolean).join(' ');
  const host = $('#ugc-scenes');
  host.replaceChildren();
  scenes.forEach((scene, index) => {
    const card = document.createElement('article');
    card.className = 'ugc-scene-card';
    card.dataset.sceneId = scene.id || `scene-${index + 1}`;
    card.innerHTML = `<div class="ugc-scene-head"><span class="step-number">${index + 1}</span><div><strong>${esc(scene.label || `Scene ${index + 1}`)}</strong><span class="hint">${Number(scene.duration) || 4}s · ${esc(scene.transition || 'quick cut')}</span></div></div><div class="field-row"><label class="field"><span class="field-label">Label</span><input data-scene-field="label" value="${esc(scene.label || '')}" /></label><label class="field"><span class="field-label">Seconds</span><input data-scene-field="duration" type="number" min="2" max="15" value="${Number(scene.duration) || 4}" /></label></div><label class="field"><span class="field-label">Visual prompt</span><textarea data-scene-field="visual_prompt" rows="3">${esc(scene.visual_prompt || '')}</textarea></label><label class="field"><span class="field-label">Voiceover</span><textarea data-scene-field="voiceover" rows="2">${esc(scene.voiceover || '')}</textarea></label><label class="field"><span class="field-label">On-screen text</span><input data-scene-field="on_screen_text" value="${esc(scene.on_screen_text || '')}" /></label>`;
    card.querySelectorAll('[data-scene-field]').forEach((field) => field.addEventListener('input', () => { updateUgcPlanFromEditor(); saveUgcProjectSoon(); }));
    host.appendChild(card);
  });
}

function updateUgcPlanFromEditor() {
  if (!ugcState.project) return;
  const plan = ugcState.project.plan || {};
  plan.creator_direction = $('#ugc-creator-direction').value;
  plan.script = $('#ugc-full-script').value;
  plan.scenes = $$('.ugc-scene-card').map((card, index) => {
    const get = (field) => $(`[data-scene-field="${field}"]`, card)?.value || '';
    return { ...(plan.scenes[index] || {}), id: card.dataset.sceneId, order: index + 1, label: get('label'), duration: Math.max(2, Math.min(15, Number(get('duration')) || 4)), visual_prompt: get('visual_prompt'), voiceover: get('voiceover'), on_screen_text: get('on_screen_text') };
  });
  $('#ugc-produce').disabled = plan.scenes.length < 2;
  ugcState.project.plan = plan;
}

function saveUgcProjectSoon() {
  if (!ugcState.project?.id) return;
  clearTimeout(ugcSaveTimer);
  ugcSaveTimer = setTimeout(async () => {
    try { await api(`/api/v1/ugc/projects/${encodeURIComponent(ugcState.project.id)}`, { method: 'PUT', body: { plan: ugcState.project.plan } }); } catch (err) { console.warn('[ugc] autosave failed:', err.message); }
  }, 600);
}

async function loadUgcProjects() {
  try {
    const { projects } = await api('/api/v1/ugc/projects');
    const host = $('#ugc-projects');
    if (!host) return;
    host.replaceChildren();
    (projects || []).slice(0, 8).forEach((project) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ugc-recent-item';
      button.innerHTML = `<strong>${esc(project.title)}</strong><small>${esc(project.status)} · ${esc(project.brief?.platform || 'social')}</small>`;
      button.addEventListener('click', () => renderUgcProject(project));
      host.appendChild(button);
    });
  } catch (err) { console.warn('[ugc] projects unavailable:', err.message); }
}

$('#ugc-brief-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  ugcClearError();
  const button = $('#ugc-plan');
  button.dataset.label ??= button.textContent;
  busy(button, true, 'Planning…');
  const brief = {
    product: $('#ugc-product').value,
    audience: $('#ugc-audience').value,
    goal: $('#ugc-goal').value,
    offer: $('#ugc-offer').value,
    platform: $('#ugc-platform').value,
    duration: Number($('#ugc-duration').value),
    tone: $('#ugc-tone').value,
    language: $('#ugc-language').value,
  };
  try {
    const { project } = await api('/api/v1/ugc/plan', { method: 'POST', body: { brief, provider: $('#ugc-planner-provider').value, model: $('#ugc-planner-model').value.trim() || undefined } });
    ugcState = { project: null, selectedAngle: null, sceneGenerations: [], audioGeneration: null };
    renderUgcProject(project);
    loadUgcProjects();
  } catch (err) { ugcShowError(err); }
  finally { busy(button, false); }
});

$('#ugc-script')?.addEventListener('click', async () => {
  if (!ugcState.project || !ugcState.selectedAngle) return;
  const button = $('#ugc-script');
  button.dataset.label ??= button.textContent;
  busy(button, true, 'Writing…');
  ugcClearError();
  try {
    const { project } = await api('/api/v1/ugc/script', { method: 'POST', body: { project_id: ugcState.project.id, angle: ugcState.selectedAngle, provider: $('#ugc-planner-provider').value, model: $('#ugc-planner-model').value.trim() || undefined } });
    ugcState.sceneGenerations = [];
    ugcState.audioGeneration = null;
    renderUgcProject(project);
    ugcSetStatus('Script ready. Review each scene before producing media.');
    loadUgcProjects();
  } catch (err) { ugcShowError(err); }
  finally { busy(button, false); }
});

$('#ugc-new')?.addEventListener('click', () => {
  ugcState = { project: null, selectedAngle: null, sceneGenerations: [], audioGeneration: null };
  $('#ugc-project-view').hidden = true;
  $('#ugc-empty').hidden = false;
  $('#ugc-scenes-output').replaceChildren();
  ugcSetStatus('');
});

async function ugcGenerateScene(scene, index, videoModel, aspect, referenceDataUrls = []) {
  const generated = await api('/api/v1/videos', { method: 'POST', body: { provider: 'openrouter', model: videoModel || undefined, prompt: scene.visual_prompt, mode: referenceDataUrls.length ? 'reference' : 't2v', references: referenceDataUrls.length ? referenceDataUrls : undefined, duration: Math.max(4, Math.min(15, Number(scene.duration) || 4)), resolution: '720p', aspect_ratio: aspect, generate_audio: false } });
  const finished = await waitForVideoTerminal(generated);
  if (finished.status !== 'completed') throw new Error(`Scene ${index + 1} failed: ${finished.error || 'video generation failed'}`);
  return finished;
}

async function ugcRunPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

$('#ugc-produce')?.addEventListener('click', async () => {
  if (!ugcState.project) return;
  updateUgcPlanFromEditor();
  const scenes = ugcState.project.plan?.scenes || [];
  if (scenes.length < 2) return ugcShowError(new Error('Generate and review at least two scenes first.'));
  const button = $('#ugc-produce');
  button.dataset.label ??= button.textContent;
  busy(button, true, 'Producing…');
  $('#ugc-export').disabled = true;
  ugcClearError();
  try {
    const brief = ugcState.project.brief || {};
    const aspect = UGC_PLATFORM_ASPECTS[brief.platform] || '9:16';
    const videoModel = $('#ugc-video-model').value.trim() || $('#v-model').value.trim();
    const concurrency = Number($('#ugc-scene-batch').value) || 1;
    const selectedAssetIds = ['#ugc-character-asset', '#ugc-product-asset'].map((selector) => $(selector)?.value).filter(Boolean);
    const selectedAssets = selectedAssetIds.map((id) => ugcAssets.find((asset) => asset.id === id)).filter(Boolean);
    const referenceDataUrls = await Promise.all(selectedAssets.map(async (asset) => blobToDataUrl(await fetch(asset.file_url).then((response) => { if (!response.ok) throw new Error(`Could not load ${asset.name}.`); return response.blob(); }))));
    ugcSetStatus(`Generating ${scenes.length} scene clips${selectedAssets.length ? ` with ${selectedAssets.length} reference${selectedAssets.length > 1 ? 's' : ''}` : ''}…`);
    ugcState.sceneGenerations = await ugcRunPool(scenes, concurrency, async (scene, index) => {
      ugcSetStatus(`Generating scene ${index + 1} of ${scenes.length}…`);
      return ugcGenerateScene(scene, index, videoModel, aspect, referenceDataUrls);
    });
    if ($('#ugc-voiceover').checked) {
      ugcSetStatus('Generating matching voiceover…');
      const speechModels = await api('/api/v1/audio/models?provider=openrouter&mode=speech');
      const speechModel = speechModels.default_model || 'fish-audio/s2.1-pro-free:free';
      const script = $('#ugc-full-script').value.trim() || scenes.map((scene) => scene.voiceover).filter(Boolean).join(' ');
      ugcState.audioGeneration = await api('/api/v1/audio', { method: 'POST', body: { provider: 'openrouter', mode: 'speech', model: speechModel, prompt: script, voice: 'alloy', format: 'mp3' } });
    } else {
      ugcState.audioGeneration = null;
    }
    $('#ugc-scenes-output').innerHTML = ugcState.sceneGenerations.map((gen, index) => `<article class="ugc-output-card"><span>Scene ${index + 1}</span><video controls preload="metadata" src="${esc(gen.file_url)}"></video><small>${esc(scenes[index].label || '')}</small></article>`).join('');
    $('#ugc-export').disabled = false;
    ugcSetStatus(`Ready to assemble ${ugcState.sceneGenerations.length} scenes${ugcState.audioGeneration ? ' with voiceover' : ''}.`);
    saveUgcProjectSoon();
  } catch (err) { ugcShowError(err); ugcSetStatus('Production stopped. Review the error and try again.'); }
  finally { busy(button, false); }
});

$('#ugc-export')?.addEventListener('click', async () => {
  if (ugcState.sceneGenerations.length < 2 || !ugcState.project) return;
  const button = $('#ugc-export');
  button.dataset.label ??= button.textContent;
  busy(button, true, 'Assembling…');
  ugcClearError();
  try {
    const aspect = UGC_PLATFORM_ASPECTS[ugcState.project.brief?.platform] || '9:16';
    const result = await api('/api/v1/ugc/assemble', { method: 'POST', body: { project_id: ugcState.project.id, generation_ids: ugcState.sceneGenerations.map((gen) => gen.id), audio_generation_id: ugcState.audioGeneration?.id, title: ugcState.project.title, aspect_ratio: aspect } });
    $('#ugc-scenes-output').insertAdjacentHTML('afterbegin', `<article class="ugc-export-card"><div><strong>Export ready</strong><span class="hint">Saved to Library · ${esc(aspect)}</span></div><video controls preload="metadata" src="${esc(result.file_url)}"></video><a class="dl" href="${esc(result.file_url)}" download>Download UGC MP4</a></article>`);
    ugcSetStatus('UGC MP4 assembled and saved to Library.');
    ugcState.project.status = 'exported';
    loadUgcProjects();
    refreshHistoryCount();
  } catch (err) { ugcShowError(err); }
  finally { busy(button, false); }
});

let ugcAssets = [];

async function loadUgcAssets() {
  try {
    const { assets } = await api('/api/v1/ugc/assets');
    ugcAssets = assets || [];
    for (const [type, selector] of [['character', '#ugc-character-asset'], ['product', '#ugc-product-asset']]) {
      const select = $(selector);
      if (!select) continue;
      const previous = select.value;
      select.innerHTML = `<option value="">None</option>${ugcAssets.filter((asset) => asset.type === type).map((asset) => `<option value="${esc(asset.id)}">${esc(asset.name)}</option>`).join('')}`;
      if (ugcAssets.some((asset) => asset.id === previous)) select.value = previous;
    }
    const host = $('#ugc-assets-list');
    if (!host) return;
    host.replaceChildren();
    ugcAssets.forEach((asset) => {
      const row = document.createElement('div');
      row.className = 'ugc-asset-item';
      row.innerHTML = `<img src="${esc(asset.file_url)}" alt="${esc(asset.name)}"><div><strong>${esc(asset.name)}</strong><small>${esc(asset.type)}${asset.description ? ` · ${esc(asset.description)}` : ''}</small></div><button type="button" class="icon-btn">Delete</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        try { await api(`/api/v1/ugc/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' }); await loadUgcAssets(); } catch (err) { $('#ugc-asset-status').textContent = err.message; }
      });
      host.appendChild(row);
    });
  } catch (err) { console.warn('[ugc] assets unavailable:', err.message); }
}

$('#ugc-asset-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('#ugc-asset-status');
  const button = $('#ugc-asset-upload');
  const file = $('#ugc-asset-file').files[0];
  if (!file) { status.textContent = 'Choose a PNG, JPEG or WebP reference image first.'; return; }
  if (!$('#ugc-asset-rights').checked) { status.textContent = 'Confirm that you own or are authorized to use this image.'; return; }
  button.disabled = true;
  status.textContent = 'Saving locally…';
  try {
    const form = new FormData();
    form.append('type', $('#ugc-asset-type').value);
    form.append('name', $('#ugc-asset-name').value.trim());
    form.append('description', $('#ugc-asset-description').value.trim());
    form.append('rights_confirmed', 'true');
    form.append('asset', file);
    await uploadApi('/api/v1/ugc/assets', form);
    $('#ugc-asset-name').value = '';
    $('#ugc-asset-description').value = '';
    $('#ugc-asset-file').value = '';
    $('#ugc-asset-rights').checked = false;
    status.textContent = 'Reference saved locally.';
    await loadUgcAssets();
  } catch (err) { status.textContent = err.message; }
  finally { button.disabled = false; }
});

loadUgcAssets();
loadUgcProjects();

/* ============================ STUDIO SHELL ================================ */
const studioPrompt = $('#studio-prompt');
const studioWorkspace = $('#studio-workspace-select');
let studioGalleryMode = 'inspiration';
let studioGalleryRows = [];
const studioInlineWorkspace = $('#studio-inline-workspace');
const studioInlineContent = $('#studio-inline-content');
const studioFormStaging = $('#studio-form-staging');
const inlineWorkspaceToggle = $('#inline-workspace-toggle');
const inlineWorkspaceSummary = $('#inline-workspace-summary');
const inlineFormSelectors = {
  video: '#video-form',
  ugc: '#ugc-brief-form',
  enhance: '#enhance-form',
  image: '#image-form',
  audio: '#audio-form',
  chat: '#chat-form',
};
const inlinePromptSelectors = {
  video: '#v-prompt',
  ugc: '#ugc-product',
  enhance: null,
  image: '#i-prompt',
  audio: '#a-text',
  chat: '#c-prompt',
};
const inlineWorkspaceSummaries = {
  video: 'Model, mode, duration, resolution and batch',
  ugc: 'Brief, platform, planner and references',
  image: 'Model, aspect ratio, format and batch',
  audio: 'Mode, voice, format and batch',
  enhance: 'Source video, workflow and output settings',
  chat: 'Provider, model, instructions and parameters',
  labs: 'Compare, RAG, workflows, dubbing and Dev tools',
};
const inlineFormOrigins = new Map();
const inlinePromptByFormId = new Map();
Object.entries(inlineFormSelectors).forEach(([tab, selector]) => {
  const form = $(selector);
  if (!form || !form.parentNode) return;
  const placeholder = document.createComment(`inline-origin:${form.id}`);
  form.parentNode.insertBefore(placeholder, form);
  inlineFormOrigins.set(form.id, placeholder);
  inlinePromptByFormId.set(form.id, inlinePromptSelectors[tab]);
  if (studioFormStaging) studioFormStaging.append(form);
});

function restoreInlineForm(form) {
  if (!form) return;
  form.classList.remove('composer-inline-form');
  form.querySelector('.form-heading')?.removeAttribute('hidden');
  const promptSelector = inlinePromptByFormId.get(form.id);
  const prompt = promptSelector ? $(promptSelector) : null;
  prompt?.closest('.field')?.removeAttribute('hidden');
  if (studioFormStaging && form.parentNode !== studioFormStaging) studioFormStaging.append(form);
}

function setInlineWorkspace(tab = studioWorkspace?.value || 'video') {
  const selector = inlineFormSelectors[tab];
  const form = selector ? $(selector) : null;
  if (!studioInlineContent) return;
  const currentForm = studioInlineContent.querySelector(':scope > form');
  if (currentForm && currentForm !== form) restoreInlineForm(currentForm);
  if (!form) {
    studioInlineContent.replaceChildren();
    if (inlineWorkspaceSummary) inlineWorkspaceSummary.textContent = inlineWorkspaceSummaries[tab] || 'Choose a Dev Lab below';
    return;
  }
  studioInlineContent.replaceChildren(form);
  form.classList.add('composer-inline-form');
  form.querySelector('.form-heading')?.setAttribute('hidden', 'true');
  const promptSelector = inlinePromptSelectors[tab];
  const prompt = promptSelector ? $(promptSelector) : null;
  prompt?.closest('.field')?.setAttribute('hidden', 'true');
  if (inlineWorkspaceSummary) inlineWorkspaceSummary.textContent = inlineWorkspaceSummaries[tab] || 'Workspace controls';
}

function setInlineOptionsOpen(open) {
  if (!studioInlineContent || !inlineWorkspaceToggle) return;
  if (studioInlineWorkspace) {
    studioInlineWorkspace.hidden = !open;
    studioInlineWorkspace.setAttribute('aria-hidden', String(!open));
  }
  studioInlineContent.hidden = !open;
  inlineWorkspaceToggle.setAttribute('aria-expanded', String(open));
  inlineWorkspaceToggle.setAttribute('aria-label', open ? 'Close Advanced Options' : 'Open Advanced Options');
  inlineWorkspaceToggle.title = open ? 'Close Advanced Options' : 'Advanced Options';
  inlineWorkspaceToggle.textContent = '⚙';
}

inlineWorkspaceToggle?.addEventListener('click', () => setInlineOptionsOpen(studioInlineContent?.hidden));
$('#tab-btn-history')?.addEventListener('click', () => {
  if (studioWorkspace && studioWorkspace.value === 'labs') studioWorkspace.value = 'video';
  setInlineWorkspace(studioWorkspace?.value || 'video');
  syncStudioComposer();
  setInlineOptionsOpen(false);
});

function selectStudioTab(tab) {
  document.querySelector(`.tab[data-tab="${CSS.escape(tab)}"]`)?.click();
}

function syncStudioComposer() {
  const tab = studioWorkspace?.value || 'video';
  if (tab === 'video') {
    const aspect = $('#v-aspect')?.value || '9:16';
    const duration = $('#v-duration')?.value || '8';
    $('#studio-format-chip').textContent = `${aspect} · ${duration}s`;
    $('#studio-audio-chip').textContent = $('#v-audio')?.checked ? '◉ Audio' : '○ Silent';
  } else if (tab === 'ugc') {
    $('#studio-format-chip').textContent = `${UGC_PLATFORM_ASPECTS[$('#ugc-platform')?.value] || '9:16'} · ${$('#ugc-duration')?.value || '25'}s`;
    $('#studio-audio-chip').textContent = $('#ugc-voiceover')?.checked ? '◉ Voiceover' : '○ Silent';
  } else if (tab === 'audio') {
    $('#studio-format-chip').textContent = 'Speech / Music';
    $('#studio-audio-chip').textContent = '◉ Audio';
  } else if (tab === 'enhance') {
    $('#studio-format-chip').textContent = 'HQ / Cleanup';
    $('#studio-audio-chip').textContent = 'Local';
  } else if (tab === 'labs') {
    $('#studio-format-chip').textContent = 'Dev tools';
    $('#studio-audio-chip').textContent = 'Experimental';
  } else {
    $('#studio-format-chip').textContent = tab === 'image' ? 'Image' : 'Chat';
    $('#studio-audio-chip').textContent = 'Workspace';
  }
}

studioWorkspace?.addEventListener('change', () => {
  const tab = studioWorkspace.value || 'video';
  syncStudioComposer();
  setInlineWorkspace(tab);
  selectStudioTab(tab);
});
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  if (studioComposerTabs.has(btn.dataset.tab)) {
    if (studioWorkspace) studioWorkspace.value = btn.dataset.tab;
    setInlineWorkspace(btn.dataset.tab);
    syncStudioComposer();
  }
}));
['#v-aspect', '#v-duration', '#v-audio', '#ugc-platform', '#ugc-duration', '#ugc-voiceover'].forEach((selector) => $(selector)?.addEventListener('input', syncStudioComposer));
['#v-aspect', '#v-duration', '#v-audio', '#ugc-platform', '#ugc-duration', '#ugc-voiceover'].forEach((selector) => $(selector)?.addEventListener('change', syncStudioComposer));
  function openComposerOptions(fieldSelector) {
    const tab = studioWorkspace?.value || 'video';
    setInlineWorkspace(tab);
    setInlineOptionsOpen(true);
    selectStudioTab(tab);
    requestAnimationFrame(() => $(fieldSelector)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
$('#studio-format-chip')?.addEventListener('click', () => openComposerOptions(studioWorkspace?.value === 'image' ? '#i-aspect' : studioWorkspace?.value === 'audio' ? '#a-text' : '#v-aspect'));
$('#studio-audio-chip')?.addEventListener('click', () => openComposerOptions(studioWorkspace?.value === 'ugc' ? '#ugc-voiceover' : studioWorkspace?.value === 'video' ? '#v-audio' : '#a-voice'));

$('#studio-run')?.addEventListener('click', () => {
  $('#studio-run').dataset.label ??= $('#studio-run').textContent;
  const tab = studioWorkspace?.value || 'video';
  const prompt = studioPrompt?.value.trim() || '';
  const targetSelector = inlinePromptSelectors[tab];
  const target = targetSelector ? $(targetSelector) : null;
  const formSelector = inlineFormSelectors[tab];
  const form = formSelector ? $(formSelector) : null;
  setInlineWorkspace(tab);
  selectStudioTab(tab);
  if (tab === 'labs') {
    $('#tab-labs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (tab === 'enhance') {
    form?.requestSubmit();
    return;
  }
  if (!prompt) {
    setInlineOptionsOpen(false);
    studioPrompt?.focus();
    return;
  }
  if (target) {
    target.value = tab === 'ugc' ? prompt.slice(0, 240) : prompt;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  form?.requestSubmit();
});

$('#studio-add-reference')?.addEventListener('click', () => {
  selectStudioTab('ugc');
  $('#ugc-asset-file')?.focus();
  $('#ugc-asset-file')?.click();
});
$('#studio-open-assets')?.addEventListener('click', () => {
  selectStudioTab('ugc');
  $('#ugc-assets')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#studio-open-library')?.addEventListener('click', () => selectStudioTab('history'));
  const initialComposerTab = studioComposerTabs.has(currentTab) ? currentTab : (studioWorkspace?.value || 'video');
if (studioWorkspace && studioComposerTabs.has(currentTab)) studioWorkspace.value = currentTab;
setInlineWorkspace(initialComposerTab);
setInlineOptionsOpen(false);
syncStudioComposer();

function galleryMediaMarkup(row) {
  if (row.file_url && row.type === 'image') return `<img loading="lazy" src="${esc(row.file_url)}" alt="${esc(row.prompt || row.name || '')}">`;
  if (row.file_url && row.type === 'video') return `<video muted preload="metadata" src="${esc(row.file_url)}"></video>`;
  if (row.file_url && row.type === 'audio') return '<span class="gallery-audio-icon">◉</span>';
  return '<span>✦</span>';
}

function renderStudioGallery() {
  const host = $('#studio-gallery-grid');
  if (!host) return;
  const query = ($('#studio-gallery-search')?.value || '').trim().toLowerCase();
  const activeMode = studioWorkspace?.value || currentTab;
  const modeRows = studioGalleryMode === 'assets' || activeMode === 'history'
    ? studioGalleryRows
    : studioGalleryRows.filter((row) => row.type === activeMode);
  const rows = modeRows.filter((row) => !query || `${row.name || ''} ${row.prompt || ''} ${row.type || ''} ${row.description || ''}`.toLowerCase().includes(query));
  host.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'gallery-empty';
    empty.textContent = studioGalleryMode === 'assets' ? 'No saved Character or Product references yet.' : 'Generate something and it will appear here.';
    host.appendChild(empty);
    return;
  }
  rows.slice(0, 12).forEach((row) => {
    const card = document.createElement('article');
    card.className = 'gallery-card';
    const title = row.name || row.prompt || 'Untitled asset';
    const type = row.type || 'asset';
    card.innerHTML = `<div class="gallery-thumb${type === 'audio' ? ' audio' : ''}${studioGalleryMode === 'assets' ? ' gallery-asset-thumb' : ''}">${galleryMediaMarkup(row)}${studioGalleryMode === 'assets' ? `<span class="gallery-asset-type">${esc(type)}</span>` : ''}</div><div class="gallery-card-body"><strong title="${esc(title)}">${esc(title)}</strong><small class="gallery-type">${esc(type)}${row.model ? ` · ${esc(row.model)}` : ''}</small><small>${esc(row.description || row.created_at ? (row.description || fmtDate(row.created_at)) : '')}</small></div>`;
    card.addEventListener('click', () => {
      if (studioGalleryMode === 'assets') {
        selectStudioTab('ugc');
        const selector = row.type === 'character' ? '#ugc-character-asset' : '#ugc-product-asset';
        if ($(selector)) { $(selector).value = row.id; $(selector).dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        studioPrompt.value = row.prompt || '';
        studioPrompt.dispatchEvent(new Event('input', { bubbles: true }));
        const tab = row.type === 'video' || row.type === 'image' || row.type === 'audio' ? row.type : 'video';
        if (studioWorkspace) studioWorkspace.value = tab;
        syncStudioComposer();
        selectStudioTab(tab);
      }
    });
    host.appendChild(card);
  });
}

async function refreshStudioGallery() {
  const host = $('#studio-gallery-grid');
  if (!host) return;
  try {
    if (studioGalleryMode === 'assets') {
      const { assets } = await api('/api/v1/ugc/assets');
      studioGalleryRows = assets || [];
    } else {
      const { items } = await api('/api/v1/generations?limit=12&offset=0');
      studioGalleryRows = items || [];
    }
    renderStudioGallery();
  } catch (err) {
    host.innerHTML = `<div class="gallery-empty">Gallery unavailable right now.</div>`;
  }
}

$('#gallery-inspiration')?.addEventListener('click', () => {
  studioGalleryMode = 'inspiration';
  $('#gallery-inspiration').classList.add('active');
  $('#gallery-assets').classList.remove('active');
  refreshStudioGallery();
});
$('#gallery-assets')?.addEventListener('click', () => {
  studioGalleryMode = 'assets';
  $('#gallery-assets').classList.add('active');
  $('#gallery-inspiration').classList.remove('active');
  refreshStudioGallery();
});
$('#studio-gallery-search')?.addEventListener('input', renderStudioGallery);

api('/api/v1/providers').then(({ providers }) => {
  const configured = (providers || []).filter((provider) => provider.configured);
  if ($('#studio-provider-summary')) $('#studio-provider-summary').textContent = configured.length ? `${configured.length} provider${configured.length > 1 ? 's' : ''} ready` : 'Connect a provider in Settings';
}).catch(() => {});
syncStudioComposer();
refreshStudioGallery();


/* =============================== DEV LABS ================================= */
const labsApi = '/api/v1/labs';
let labsConfig = { personas: [], skills: [] };
let activeLabWorkflow = null;

function labOutputText(value) {
  return esc(String(value || '')).replace(/\n/g, '<br>');
}
function renderLabSteps(workflow) {
  const host = $('#labs-workflow-steps');
  if (!host) return;
  if (!workflow?.steps?.length) { host.className = 'lab-steps empty-note'; host.textContent = 'Your workflow stages will appear here.'; return; }
  host.className = 'lab-steps';
  host.innerHTML = workflow.steps.map((step) => `<div class="lab-step ${esc(step.status)}"><span class="lab-step-index">${Number(step.step_index) + 1}</span><div><strong>${esc(step.name)}</strong><small>${esc(step.status.replaceAll('-', ' '))}</small>${step.output ? `<p>${labOutputText(step.output)}</p>` : ''}${step.error ? `<p class="error-text">${esc(step.error)}</p>` : ''}</div></div>`).join('');
}
async function loadLabsConfig() {
  try {
    labsConfig = await api(`${labsApi}/config`);
    const persona = $('#labs-persona');
    if (persona) {
      persona.innerHTML = (labsConfig.personas || []).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
      persona.dispatchEvent(new Event('change'));
    }
  } catch { /* Dev Labs remains usable if optional config cannot load. */ }
}
async function loadLabUsage() {
  try {
    const { usage, credits } = await api(`${labsApi}/usage`);
    $('#labs-usage-balance').textContent = `${Number(credits?.balance || 0).toFixed(2)} credits`;
    $('#labs-usage-detail').textContent = `${usage?.events || 0} calls · ${usage?.input_tokens || 0} input / ${usage?.output_tokens || 0} output tokens · estimated cost $${Number(usage?.estimated_cost || 0).toFixed(4)}`;
  } catch { /* non-critical */ }
}
async function loadLabMemory() {
  try {
    const { memories } = await api(`${labsApi}/memory`);
    const host = $('#labs-memory-list');
    if (host) host.innerHTML = memories?.length ? memories.map((memory) => `<div class="lab-list-item"><span>${labOutputText(memory.content)}</span><button type="button" class="icon-btn lab-memory-delete" data-id="${esc(memory.id)}">Delete</button></div>`).join('') : '<span class="hint">No saved memories yet.</span>';
  } catch { /* non-critical */ }
}
async function loadLabDocuments() {
  try {
    const { documents } = await api(`${labsApi}/rag/documents`);
    const host = $('#labs-rag-documents');
    if (host) host.innerHTML = documents?.length ? documents.map((doc) => `<div class="lab-list-item"><span><strong>${esc(doc.name)}</strong><small>${Number(doc.chunks || 0)} chunks</small></span><button type="button" class="icon-btn lab-document-delete" data-id="${esc(doc.id)}">Delete</button></div>`).join('') : '<span class="hint">No indexed documents yet.</span>';
  } catch { /* non-critical */ }
}
$('#labs-persona')?.addEventListener('change', () => {
  const selected = labsConfig.personas?.find((item) => item.id === $('#labs-persona').value);
  $('#labs-persona-system').textContent = selected?.system || '';
});
$('#labs-compare-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('#labs-compare-status');
  const host = $('#labs-compare-results');
  const models = [1, 2, 3].map((index) => ({ provider: $(`#labs-compare-provider-${index}`)?.value, model: $(`#labs-compare-model-${index}`)?.value.trim() })).filter((item) => item.model);
  if (!models.length) { status.textContent = 'Enter at least one model ID.'; return; }
  status.textContent = 'Comparing…'; host.replaceChildren();
  try {
    const result = await api(`${labsApi}/compare`, { method: 'POST', body: { prompt: $('#labs-compare-prompt').value.trim(), models } });
    host.innerHTML = result.results.map((item) => `<article class="lab-result-card"><div><strong>${esc(item.provider_name)}</strong><small>${esc(item.model)} · ${Number(item.latency_ms || 0)} ms</small></div><p>${item.error ? `<span class="error-text">${esc(item.error)}</span>` : labOutputText(item.text)}</p></article>`).join('');
    status.textContent = 'Comparison complete.'; loadLabUsage();
  } catch (err) { status.textContent = err.message; }
});
$('#labs-rag-upload-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#labs-rag-file')?.files?.[0]; const status = $('#labs-rag-upload-status');
  if (!file) { status.textContent = 'Choose a document first.'; return; }
  const form = new FormData(); form.append('document', file); status.textContent = 'Indexing locally…';
  try { await uploadApi(`${labsApi}/rag/upload`, form); status.textContent = 'Document indexed locally.'; $('#labs-rag-file').value = ''; loadLabDocuments(); } catch (err) { status.textContent = err.message; }
});
$('#labs-rag-documents')?.addEventListener('click', async (event) => {
  const button = event.target.closest('.lab-document-delete'); if (!button) return;
  try { await api(`${labsApi}/rag/documents/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }); loadLabDocuments(); } catch (err) { $('#labs-rag-upload-status').textContent = err.message; }
});
$('#labs-rag-query-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('#labs-rag-status'); const answer = $('#labs-rag-answer'); status.textContent = 'Searching indexed context…';
  try { const result = await api(`${labsApi}/rag/query`, { method: 'POST', body: { question: $('#labs-rag-question').value.trim(), provider: $('#labs-rag-provider').value, model: $('#labs-rag-model').value.trim() } }); answer.className = 'lab-output'; answer.innerHTML = `<strong>${esc(result.model)}</strong><p>${labOutputText(result.answer)}</p><small>${result.sources?.length || 0} retrieved source chunks</small>`; status.textContent = 'Answer ready.'; loadLabUsage(); } catch (err) { status.textContent = err.message; }
});
$('#labs-workflow-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const status = $('#labs-workflow-status'); status.textContent = 'Planning chain…';
  try { activeLabWorkflow = await api(`${labsApi}/workflows/plan`, { method: 'POST', body: { goal: $('#labs-workflow-goal').value.trim(), provider: $('#labs-workflow-provider').value, model: $('#labs-workflow-model').value.trim() } }); renderLabSteps(activeLabWorkflow); $('#labs-workflow-run').disabled = false; status.textContent = 'Chain planned. Review the stages, then run planning steps.'; } catch (err) { status.textContent = err.message; }
});
$('#labs-workflow-run')?.addEventListener('click', async () => {
  if (!activeLabWorkflow?.id) return; const status = $('#labs-workflow-status'); status.textContent = 'Running planning steps…'; $('#labs-workflow-run').disabled = true;
  try { activeLabWorkflow = await api(`${labsApi}/workflows/${encodeURIComponent(activeLabWorkflow.id)}/run`, { method: 'POST' }); renderLabSteps(activeLabWorkflow); status.textContent = 'Planning steps complete. Media stages are ready for the next Dev iteration.'; loadLabUsage(); } catch (err) { status.textContent = err.message; $('#labs-workflow-run').disabled = false; }
});
$('#labs-dub-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const video = $('#labs-dub-video')?.files?.[0]; const audio = $('#labs-dub-audio')?.files?.[0]; const status = $('#labs-dub-status');
  if (!video || !audio) { status.textContent = 'Choose both source video and generated audio.'; return; }
  const form = new FormData(); form.append('video', video); form.append('audio', audio); form.append('mode', $('#labs-dub-mode').value); form.append('rights_confirmed', $('#labs-dub-rights').checked ? 'true' : 'false'); status.textContent = 'Processing locally…';
  try { const result = await uploadApi(`${labsApi}/dubbing`, form); status.textContent = 'Dubbed video created.'; const link = $('#labs-dub-output'); link.href = result.file_url; link.hidden = false; link.textContent = 'Download dubbed video'; } catch (err) { status.textContent = err.message; }
});
$('#labs-memory-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const status = $('#labs-memory-status'); status.textContent = 'Saving…';
  try { await api(`${labsApi}/memory`, { method: 'POST', body: { content: $('#labs-memory-content').value.trim(), tags: [$('#labs-persona').value] } }); $('#labs-memory-content').value = ''; status.textContent = 'Memory saved locally.'; loadLabMemory(); } catch (err) { status.textContent = err.message; }
});
$('#labs-memory-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('.lab-memory-delete'); if (!button) return;
  try { await api(`${labsApi}/memory/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }); loadLabMemory(); } catch (err) { $('#labs-memory-status').textContent = err.message; }
});
$('#labs-credit-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const status = $('#labs-credit-status');
  try { await api(`${labsApi}/credits`, { method: 'POST', body: { amount: Number($('#labs-credit-amount').value), reason: $('#labs-credit-reason').value.trim() } }); status.textContent = 'Local test credits added.'; loadLabUsage(); } catch (err) { status.textContent = err.message; }
});
loadLabsConfig(); loadLabUsage(); loadLabMemory(); loadLabDocuments();
