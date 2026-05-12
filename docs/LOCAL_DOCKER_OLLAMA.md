# Local Docker + Ollama

This compose stack can run without hosted image/storage services for local testing.

## Prerequisites

1. Start Ollama on the host machine.
2. Pull a local multimodal/text model. The default compose model is `qwen3.6:latest`:

```bash
ollama pull qwen3.6:latest
ollama list
```

If your local Ollama uses another model, export variables before starting compose:

```bash
export OLLAMA_TEXT_MODEL=qwen3.6:latest
export OLLAMA_VLM_MODEL=gemma3:4b
```

## Start

```bash
cd /home/guancy/workspace/openflipbook
docker compose up -d --build
```

Open:

```text
http://localhost:3003/play
```

## Local defaults

The root `docker-compose.yml` defaults to:

- `LLM_PROVIDER=ollama`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `OLLAMA_TEXT_MODEL=qwen3.6:latest`
- `OLLAMA_VLM_MODEL=gemma3:4b`
- `IMAGE_PROVIDER=local`
- `STORAGE_PROVIDER=local`
- `MONGODB_URI=mongodb://mongo:27017`
- `MONGODB_DB=openflipbook`

`IMAGE_PROVIDER=local` renders a deterministic JPEG explainer card locally with Pillow. It does not call fal.ai, so it is useful for validating the Flipbook loop with only Docker + Ollama. For production-quality generated images, switch back to the hosted fal.ai provider and configure `FAL_KEY`.

Generated local images are stored in the Docker volume `generated-images` and served by the Next.js container under `/generated/...`.

## Verify

```bash
docker compose ps
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:3003/status
```

A quick API smoke test:

```bash
curl -N http://localhost:3003/api/generate \
  -H 'content-type: application/json' \
  -d '{"query":"how does a steam engine work","aspect_ratio":"16:9"}'
```

## Notes

- The local image provider is intentionally a fallback renderer, not a full diffusion/image model.
- The planner and click resolver still use the configured Ollama model through the OpenAI-compatible API.
- The backend container uses host networking so it can reach host Ollama on `127.0.0.1:11434` when Ollama only binds loopback.
