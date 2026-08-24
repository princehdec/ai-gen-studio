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

/* ------------------------ local workspace memory ------------------------- */
let currentTab = 'video';
const MEMORY_KEY = 'ai-gen-studio:workspace-settings:v1';
const rememberedFields = [
  'v-provider', 'v-model', 'v-duration', 'v-resolution', 'v-aspect', 'v-audio',
  'i-provider', 'i-model', 'i-aspect', 'i-count', 'i-format',
  'a-provider', 'a-model', 'a-voice', 'a-format', 'a-text', 'a-preview-text',
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
  saveWorkspaceSettings();
  if (currentTab === 'history') loadHistory(true).catch((err) => showError('#v-error', err));
}));
const rememberedTab = readWorkspaceMemory().activeTab;
if (rememberedTab) document.querySelector(`.tab[data-tab="${CSS.escape(rememberedTab)}"]`)?.click();

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
  } catch (err) {
    const hint = $(`#${kind[0]}-model-hint`);
    if (hint) hint.textContent = `Could not load models — enter an ID manually`;
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
  el.hidden = false;
  el.classList.add(configured ? 'good' : 'bad');
  el.textContent = configured ? `${configured} provider${configured > 1 ? 's' : ''} connected` : 'Setup a provider to start';
  syncProviderOptions();
}).catch(() => {});

function syncProviderOptions() {
  const map = { video: 'video', image: 'image', audio: 'audio', chat: 'chat' };
  for (const [kind, capability] of Object.entries(map)) {
    const select = $(providerByKind[kind]);
    if (!select) continue;
    for (const option of select.options) {
      const provider = providerState.find((p) => p.id === option.value);
      option.disabled = Boolean(provider && !provider.capabilities.includes(capability));
      option.textContent = provider ? `${provider.name}${provider.configured ? '' : ' (not configured)'}` : option.textContent;
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
function showError(id, err) {
  const el = $(id);
  el.hidden = false;
  el.innerHTML = `<strong>Something went wrong:</strong> ${esc(err.message)}`;
}
const clearError = (id) => { $(id).hidden = true; };

function busy(btn, isBusy, label) {
  btn.disabled = isBusy;
  btn.textContent = isBusy ? label : btn.dataset.label;
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

  busy(btn, true, 'Submitting…');
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

    const gen = await api('/api/v1/videos', { method: 'POST', body: payload });
    trackJob(gen);
    $('#tab-video').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(errId, err);
  } finally {
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

  busy(btn, true, 'Generating…');
  try {
    const gens = await api('/api/v1/images', {
      method: 'POST',
      body: {
        prompt,
        provider: $('#i-provider').value,
        model: $('#i-model').value.trim() || undefined,
        n: Number($('#i-count').value),
        aspect_ratio: $('#i-aspect').value || undefined,
        output_format: $('#i-format').value,
        input_images: await Promise.all(files.map(fileToDataUrl)),
      },
    });
    gens.reverse().forEach((g) => $('#i-results').prepend(renderCard(g)));
    $('#i-prompt').value = '';
    refreshHistoryCount();
  } catch (err) {
    showError(errId, err);
  } finally {
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

  busy(btn, true, 'Generating…');
  try {
    const gen = await api('/api/v1/audio', {
      method: 'POST',
      body: {
        prompt,
        provider: $('#a-provider').value,
        mode: $('input[name="a-mode"]:checked').value,
        model: $('#a-model').value.trim() || undefined,
        voice: $('#a-voice').value,
        format: $('#a-format').value,
      },
    });
    $('#a-results').prepend(renderCard(gen));
    $('#a-text').value = '';
    refreshHistoryCount();
  } catch (err) {
    showError(errId, err);
  } finally {
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
  const pill = $('#history-count');
  pill.hidden = false;
  pill.textContent = total;
}

function refreshHistoryCount() {
  historyDirty = true;
  if (currentTab === 'history') loadHistory(true);
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
    card.innerHTML = `
      <div class="provider-card-head"><div><h3>${esc(provider.name)}</h3><p>${provider.capabilities.map(esc).join(' · ')}</p></div><span class="provider-state ${provider.configured ? 'configured' : ''}">${provider.configured ? 'Connected' : 'Not configured'}</span></div>
      <label class="field"><span class="field-label">Base URL</span><input class="provider-base-url" type="url" value="${esc(provider.baseUrl)}" /></label>
      <label class="field"><span class="field-label">API key <small>(blank keeps the saved key)</small></span><span class="saved-key-state">${provider.configured ? `Saved key: ${esc(provider.keyHint || '••••••••')}` : 'No key saved yet'}</span><input class="provider-api-key" type="password" placeholder="${provider.configured ? 'Click to replace saved key' : 'Click to enter API key'}" autocomplete="new-password" readonly /></label>
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
    status.textContent = result.saved
      ? `Connected · ${result.model_count ?? 0} models found`
      : `Connected with entered key · click Save settings to keep it`;
    card.querySelector('.provider-state').textContent = result.saved ? 'Connected' : 'Connection OK (unsaved)';
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
