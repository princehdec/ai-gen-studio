# AI Gen Studio

Multi-modal AI generation studio (video / image / audio) powered by [OpenRouter](https://openrouter.ai), with a **permanent local gallery** — every generation is downloaded from OpenRouter the moment it finishes and saved to disk + SQLite, so nothing is lost on refresh or restart.

## Quick start

```bash
cd backend
npm install
# 1) paste your key into backend/.env  (OPENROUTER_API_KEY=sk-or-...)
cp .env.example .env   # if .env doesn't exist yet
npm start
```

Open **http://localhost:8787** — tabs for Video, Image, Audio and a unified History.

## What it does

| Tab | Endpoint | Flow |
|---|---|---|
| Video | `POST /api/v1/videos` | Async job: submit → poll → auto-download finished video to `storage/files/` |
| Image | `POST /api/v1/images` | Sync: base64 images returned by OpenRouter are saved as real `.png/.webp/.jpg` files |
| Audio | `POST /api/v1/audio` | Streams an audio-capable chat model (TTS voices or music/SFX prompts) into a `.wav/.mp3` file |
| History | `GET /api/v1/generations?type=&q=` | Everything, newest first, filterable by type + prompt search — served from SQLite |

Video modes: **text-to-video**, **image-to-video** (first frame), **first+last frame interpolation**, and **reference-to-video**. Duration 4–15 s, resolution 480p/720p, aspect ratio selectable.

Models are dropdowns fed live from OpenRouter (`/videos/models`, `/images/models`, audio-output models) with free-text override — change one string to use any OpenRouter model (Veo, Sora, Kling, Wan, Seedance, Nano Banana, Seedream, GPT-Image, FLUX, GPT-4o-audio, …).

## Key facts

- **API key safety** — `OPENROUTER_API_KEY` lives only in `backend/.env`; every provider call is proxied through this server.
- **Persistence** — media files under `storage/files/YYYY-MM/<uuid>.<ext>` (served at `/files/...`), metadata in `storage/app.db` (SQLite via Node's built-in `node:sqlite`, no native deps).
- **Reliability** — failed video jobs keep polling until they finish or hit `VIDEO_TIMEOUT_MIN` (default 15); download hiccups retry automatically; GET requests retry with backoff; paid POSTs never auto-retry (no double billing); friendly errors for invalid key (401), insufficient credits (402), rate limits (429), content-policy failures.
- **Storage swap** — implement `backend/src/storage/s3.js` with the same four functions as `local.js` (`newRel/saveBuffer/saveWebStream/remove`) and set `STORAGE_DRIVER=s3`.

## UGC Studio

The desktop app includes a guided UGC Ad Studio workflow. Enter a product, target audience, campaign goal, offer, platform, tone, and language to create three ad angles. Select an angle to generate an editable script and scene plan, review the visual prompts and voiceover, then produce scene clips with a configured OpenRouter text-to-video model. The app can generate a matching voiceover and assemble completed scene videos into one local MP4 with FFmpeg. Projects, angles, scripts, and scene prompts are saved in the local SQLite database; generated media remains in the local Library.

The first UGC workflow is intentionally guided rather than fully autonomous: review claims, scripts, and scenes before spending provider credits. The Reference library lets you save authorized Character and Product PNG/JPEG/WebP images locally, then select one of each for scene generation. When references are selected, the app sends them as OpenRouter reference-to-video inputs; without references it uses text-to-video. The export uses the platform’s recommended aspect ratio. Captions are reserved for a later export pass. Reference images are only accepted with an ownership/authorization confirmation.

## API quick reference

```bash
curl -X POST localhost:8787/api/v1/videos -H 'Content-Type: application/json' \
  -d '{"prompt":"a cat surfing","mode":"t2v","duration":6,"resolution":"720p","aspect_ratio":"16:9"}'

curl "localhost:8787/api/v1/generations?type=video&q=cat"
```

## Project layout

```
backend/src/
  server.js        Express bootstrap + static serving + error middleware
  config.js        env config (.env)
  db.js            SQLite schema + queries
  openrouter.js    OpenRouter client (video jobs, images, streaming audio, model lists)
  storage/         storage driver abstraction (local disk now, S3-ready interface)
  routes/          videos.js · images.js · audio.js · ugc.js · generations.js
frontend/          index.html · app.js · styles.css  (vanilla SPA, no build step)
storage/files/     permanent generated media
```


## Desktop app

The project now includes a Windows Electron desktop shell. During development:

```bash
npm install
npm run desktop
```

To build a Windows NSIS installer:

```bash
npm run desktop:dist
```

The installer is written to `release/`. The desktop app starts the local Express backend on an available loopback port and stores the SQLite database, generated files, and provider settings in the Windows user-data directory. The app does not expose Node integration to the renderer.

## Provider configuration

Open **Settings** inside the desktop app and configure any of these providers:

| Provider | Capabilities in this release | Default base URL |
|---|---|---|
| OpenRouter | Video, image, audio and chat | `https://openrouter.ai/api/v1` |
| NVIDIA NIM | OpenAI-compatible chat/completions | `https://integrate.api.nvidia.com/v1` |
| Hugging Face | Chat, text-to-image and text-to-video task routing | `https://router.huggingface.co/v1` |

Provider keys are saved locally under the desktop user-data directory and are not rendered back into the UI. OpenRouter keeps its existing dedicated video/image/audio workflows. NVIDIA NIM is exposed as a chat provider because NIM deployments are model- and endpoint-specific; image/video/audio generation is not assumed for every NIM model. Hugging Face image and video support currently covers text-to-image and text-to-video task requests; reference-frame editing is intentionally limited to OpenRouter until provider-specific input schemas are added.

The backend uses a provider registry and normalized capability checks. This means additional OpenAI-compatible endpoints can be added by registering a provider base URL, API-key environment variable, capabilities, model discovery strategy, and task normalizer rather than rewriting the frontend forms.

## Environment variables

The original `.env` flow remains supported for local development. In addition to `OPENROUTER_API_KEY`, the backend can read `NVIDIA_API_KEY`, `HUGGINGFACE_API_KEY`, `NVIDIA_BASE_URL`, `HUGGINGFACE_BASE_URL`, `HUGGINGFACE_TASK_BASE_URL`, and `DEFAULT_CHAT_MODEL`. Desktop settings take precedence for stored provider keys and base URLs.

## Help and automatic updates

The desktop app now includes a **Help** dialog with update status, a manual **Check for updates** action, download progress, and **Install & restart**. Update checks run only in packaged builds; development mode intentionally reports that updates are unavailable.

To enable automatic updates, add a public GitHub repository URL to the root `package.json` under `repository`, publish each Windows NSIS build as a GitHub Release, and include the generated update metadata files alongside the installer. For example:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git"
}
```

After the repository is configured, bump the app version for every release and publish the result with the release artifacts. The app reads the repository metadata and checks GitHub Releases; no GitHub token is stored in the desktop app. Keep any publishing token in CI or the local release environment only.

This follows Electron's public GitHub Release update model: https://electronjs.org/docs/latest/tutorial/tutorial-publishing-updating
