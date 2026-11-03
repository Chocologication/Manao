# Manao stage-one Pi worker

The Node/TypeScript worker that drives the Pi SDK for Manao's stage-one AI tasks. One
task at a time; the SDK runs its own agent loop; the model reaches the user's project
only through seven backend-mediated tools (`list_files`, `read_file`, `write_file`,
`build`, `application`, `app_http_get`, `read_image`). The worker holds NO local file or shell capability over user code: it imports
no `node:fs`/`node:child_process` tool surface, registers no built-in Pi tools
(`noTools: "builtin"` plus an explicit tool allowlist), and its resource loading is
explicitly discovery-disabled (no project extensions, no Skills, no prompt templates,
no themes, no AGENTS/context files). The system prompt is fixed server-side; it does
not pre-write change or retry steps.

## Trusted prompts and compaction

[`src/prompts.ts`](src/prompts.ts) owns the task system prompt and the Manao
checkpoint instructions. The task prompt covers user scope, reading before full-file
writes with `expectedSha256`, confirmed application stop, bounded tool results,
image availability, and evidence-based completion. Both session loaders explicitly
disable `APPEND_SYSTEM.md` discovery as well as project context and extensions.

Manual, automatic and turn-prefix compaction keep Pi's native summary formats and
history handling. A shared stream wrapper appends the checkpoint instructions only
to summary requests, preserving the original request and all other messages. The
existing ACK ordering, retry, cancellation and usage accounting still apply.
Checkpoints retain user corrections, important code, failures and fixes, verification
state, known runtime facts, image references and the next unfinished work; they omit
private reasoning, binary images, secrets and whole-file transcripts.

The AI tool surface currently has a Java-oriented file allowlist (`pom.xml`,
`src/**`, and ordinary top-level text documents) and a Maven-only `build` backend.
The prompt explicitly forbids inferring Spring Boot from those capabilities or
introducing Maven into a Python project to satisfy the tool. These are model
instructions, not a backend runtime guard: passing the project's runtime template
to the worker and adapting or restricting tools per runtime remain separate work.
The wider workbench's Python support does not imply Python AI build support.

## HTTP surface (Node built-in `http`, no framework)

| Route | Behavior |
| --- | --- |
| `POST /tasks/{taskId}/start` | Validates the `WorkerStart` body, accepts immediately (200, `WorkerStatus`), then drives the SDK session asynchronously. A replayed identical start is idempotent; a second task while one runs is 409. |
| `GET /tasks/{taskId}` | The reconciliation read for a lost start response — always ask for the ORIGINAL task, never retry with a new task id. |
| `POST /tasks/{taskId}/stop` | Aborts the SDK session. This alone never releases the project's occupancy; release happens only in the backend close flow. |

Every route fails closed without the `MANAO_AI_WORKER_TOKEN` header.

## Worker -> backend

- `POST /internal/ai/tasks/{taskId}/calls/{toolCallId}` submits a tool call; if the POST
  response is lost, the ORIGINAL call is queried by `GET` (the request id is the dedup
  identity; the backend's durable ledger is the only authority). An unresolved call
  blocks the next side effect.
- `POST /internal/ai/tasks/{taskId}/progress` submits monotonic-seq progress items and
  the terminal state. Delivery is a serialized promise chain (SDK listeners are never
  awaited by the loop); the terminal state is sent only after the chain drains. A lost
  response is retried with the SAME seq and identical payload; a gap answer
  (`AI_PROGRESS_GAP` with `expectedSeq`) replays the buffered range; a same-seq
  different-payload answer (`AI_PROGRESS_MISMATCH`) drops the item (the backend's copy
  wins).

## Budgets (worker-enforced, honest reporting)

Task wall clock 1800s, 180 tool calls, 20 builds (user-authorized limits as of 2026-10-18). Exceeding any budget aborts the SDK
run and the terminal state reports `AI_BUDGET_EXCEEDED`. A provider error that settles
normally is never a success: the outcome is `AI_PROVIDER_ERROR`, and an `agent_end`
with `willRetry=true` never settles (the SDK retries inside the same prompt).

## Configuration

All fields are required-empty in `.env.example`; nothing real is committed.

| Variable | Meaning |
| --- | --- |
| `MANAO_AI_WORKER_PORT` | Worker listen port (default 18090). |
| `MANAO_AI_WORKER_TOKEN` | Shared secret the backend presents on `/tasks/*`; empty disables every route. |
| `MANAO_AI_INSTANCE_ID` | Instance identity prefix; every process boot embeds a fresh `bootId` (never a fixed instance string — see `GET /status`). |
| `MANAO_AI_BACKEND_BASE_URL` | Backend base URL for internal callbacks. |
| `MANAO_AI_BACKEND_TOKEN` | The internal token (must equal the backend's `MANAO_AI_INTERNAL_TOKEN`). |
| `MANAO_AI_SCRATCH_DIR` | Worker-private session cwd; never a user project. |
| `MANAO_AI_AGENT_DIR` | Private Pi agent dir holding this worker's `models.json` and auth state. |
| `MANAO_AI_SESSION_DIR` | Private on-disk session transcript dir. |
| `MANAO_AI_PROVIDER` | Model provider id as declared in the private `models.json`. |
| `MANAO_AI_API_TYPE` | Pi API type (for example `openai-completions`, `anthropic-messages`). |
| `MANAO_AI_BASE_URL` | Model API base URL. |
| `MANAO_AI_MODEL` | Model id. |
| `MANAO_AI_IMAGE_INPUT` | Default `false`. Set exactly `true` only for a deployment verified to accept images; `/status.imageInput` supplies the backend/browser capability. |
| `MANAO_AI_API_KEY` | Model API key. Lives ONLY in the worker environment and the ModelRuntime — never in the backend, a project, or a development Job. |

Image originals live in the project's existing workspace PVC. The worker retrieves
authorized bytes through the backend only when assembling a model request; session
history and `read_image` results keep references. `read_image({})` lists one bounded
catalog page, `read_image({ cursor })` continues it, and `read_image({ attachmentId })`
requests an original until its fixed upload-time deadline. Compaction never extends
that deadline. See the [local implementation and acceptance evidence](../docs/evidence/ai-image-input/acceptance.md).

The worker boots without the model fields (health/reconciliation), but every start is
refused with a fixed `AI_WORKER_NOT_CONFIGURED` (HTTP 503) until all five model fields
are present; the backend then fails the task `AI_WORKER_NOT_CONFIGURED` before any
session starts.

### Missing items for a real deployment (intentionally unresolved here)

- A real provider: `MANAO_AI_PROVIDER/API_TYPE/BASE_URL/MODEL/API_KEY` are operator
  choices; no key was created or committed for this stage.
- Deployment wiring: the worker image and its Service, the backend's
  `MANAO_AI_WORKER_BASE_URL/TOKEN` and `MANAO_AI_INTERNAL_TOKEN` values, and the
  private directories (`SCRATCH/AGENT/SESSION`) as worker-local volumes.
- `MANAO_AI_ENABLED=true` on the backend. Since the 2026-10-18 project-access change,
  `MANAO_AI_PROJECT_ID` is accepted for compatibility but no longer restricts tasks;
  admission still requires the authenticated owner's READY project and the existing locks.

## Development

```bash
pnpm install        # pnpm only; SDK pinned @earendil-works/pi-coding-agent@1.2.0
pnpm test           # vitest, 17 tests
pnpm exec tsc --noEmit
pnpm build          # dist/ for the image
```

Tests script the model through the SDK's own loop (faux `streamFn` -> real
`AgentSession`) and stub the backend client; no real provider participates.
