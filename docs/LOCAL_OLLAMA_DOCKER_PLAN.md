# Local Docker/Ollama setup plan

Goal: run openflipbook locally with Docker Compose while using locally available Ollama models wherever practical.

Constraints:
- Keep execution Docker-only for the app stack.
- Use host networking for the backend so it can reach loopback-bound host Ollama.
- Avoid requiring OpenRouter for text planning and click resolution.
- Avoid requiring fal for basic local smoke tests by providing a local deterministic image renderer.
- Keep external cloud persistence optional; use local filesystem object storage for generated images when R2 is not configured.

Chosen local defaults:
- Text planner: qwen3.6:latest if present, fallback configurable via OLLAMA_TEXT_MODEL.
- Vision/click model: gemma3:4b if present, fallback configurable via OLLAMA_VLM_MODEL.
- Image renderer: local SVG-to-JPEG/Pillow-style generated explainer card, driven by the Ollama-produced plan.
- Mongo: compose-managed local mongo.
- Host web port: 3003 to avoid current 3000 conflicts.
- Backend port: 8787.

Implementation slices:
1. Backend: add Ollama-native LLM/VLM provider path selected by LLM_PROVIDER=ollama.
2. Backend: add local image provider path selected by IMAGE_PROVIDER=local.
3. Web: add local filesystem storage path when STORAGE_PROVIDER=local so R2 keys are not required.
4. Compose/env/docs: add docker-compose.local-ollama.yml and local env examples.
5. Verify with Docker build/start plus HTTP smoke tests against /health, /status, and /sse/generate.
