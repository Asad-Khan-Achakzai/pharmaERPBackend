# PharmaERP AI Copilot Module

Self-contained AI platform inside `pharmaERPBackend/src/ai/`. All LLM access flows through this module; no other backend code may call providers directly.

## Layout

- `config/` — env (`aiEnv.js`) and provider factory
- `providers/` — Ollama (default), OpenAI stub
- `middleware/` — company flag gate, rate limiting
- `models/` — conversations, messages, interaction logs
- `services/` — chat orchestration, agent loop, prompts, logging
- `tools/` — ERP tool adapters (read-only in agent loop; write tools via confirmation)
- `routes/` — `/api/v1/ai/*`

## Configuration

```env
AI_PROVIDER=ollama
AI_STREAMING=true
AI_MAX_HISTORY=20
AI_MAX_TOOL_ITERATIONS=5
AI_GLOBAL_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:30b-a3b
```

Company toggle: `Company.aiCopilotEnabled` (Super Admin). Permission: `copilot.use`.

## Extraction to microservice

1. Move `src/ai/` to a standalone Express app.
2. Replace tool `require('../../services/...')` with authenticated internal HTTP calls to the ERP API.
3. Keep `AiRequestContext` and tool schemas in a shared package.
4. Preserve public path `/api/v1/ai` behind a gateway.

## Security

- Permissions enforced in every tool via `baseTool.assertToolPermissions`.
- Rep/team scoping reuses `orderScope`, `lookup.service`, `teamScope`.
- Write tools (`create_order`) only via `POST /ai/tools/execute-confirmed` with `confirmed: true`.
- LLM output is untrusted; ERP data comes only from tool results.
