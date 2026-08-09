# Development

## Architecture

`pi-yahe` is one Pi extension (`src/index.ts`) registering one model tool, `herdr`, backed by a small Node runner (`src/runner.mjs`) and a few pure helpers (`src/core.ts`).

| File | Role |
|---|---|
| `src/index.ts` | The `herdr` tool: 17 actions, surface creation, the delivery watcher |
| `src/runner.mjs` | Executes commands / child Pi in the target pane; records completion |
| `src/core.ts` | Pure helpers: result extraction, label normalization, arg validation, workspace routing |

**Tool actions**

| Area | Actions |
|---|---|
| Commands | `run`, `monitor`, `run_in_pane` |
| Fresh workers | `run_pi` |
| Interactive workers | `spawn_pi`, `agent_list`, `agent_read`, `agent_prompt`, `agent_wait` |
| Terminal control | `pane_list`, `read`, `send_text`, `send_keys`, `pane_close` |
| Isolation | `worktree_list`, `worktree_create` |

Workspace creation is intentionally automatic rather than another public action: new surfaces route by Git root, preserve focus by default, and close after one-shot work. If task startup fails after a surface was created, the surface is closed again instead of leaking.

## The sidecar delivery protocol

Asynchronous work (`monitor`, `run_pi`) works without a daemon or queue. A runner process in the target pane writes completion to a sidecar file; the parent extension watches the directory and injects the result as a Pi steer message (`deliverAs: "steer"`, `triggerTurn: true`), waking the parent if it is idle.

### Layout

```
~/.pi/yahe/<parent-pid>/
  <marker>.json        completion signal, written atomically
  <marker>.log         final report (last assistant message for run_pi; captured output for monitor)
  <marker>.log.run     full stdout/stderr stream of a child Pi (run_pi only)
  <marker>.json.reported  worker's own "I reported" marker (run_pi only)
```

The directory is created with mode `0700`, so only the invoking user can read or inject signals — a local process must not be able to fabricate a completion or point `logFile` at an arbitrary path.

### Ordering and races

1. The runner writes `<marker>.log.run` continuously while a child Pi runs.
2. When the child Pi settles, its extension writes `<marker>.json.reported` **before** `<marker>.json` (both synchronous writes).
3. The parent's watcher delivers on `.json`: reads it, deletes it, steers the content, and only then removes the log if it was fully shown.
4. If the child Pi exits without ever reporting, the runner checks the `.reported` marker — **not** the signal file, which the parent may have already consumed and deleted. This check is what prevents a double delivery: without it, the runner's fallback would mistake a consumed signal for a missing report and write a second completion.
5. The fallback report appends the tail of the `.run` log, so the parent can see what the worker actually did before dying.

Delivery is self-healing: a corrupt signal file (rare under atomic rename) is deleted instead of wedging the queue, and `pendingAsyncTasks` is decremented whether or not delivery succeeds.

### Lifecycle

- `session_start` clears the sidecar directory first, so files left by a crashed process or a reused PID cannot bleed signals into a new session.
- `session_shutdown` removes the directory entirely; sidecar files are session-scoped by design.
- The steer message points at the `.run` log path so output survives tab close until the session ends.

### Recursive workers

A background Pi can call `run_pi` itself. The child's `agent_settled` handler defers its own report while outstanding async tasks exist; the nested task's steer (`triggerTurn`) fires the next `agent_settled`, which reports then. This keeps a parent alive until its nested work returns.

### `piArgs` guardrails

One-shot workers must not override lifecycle flags, so `validateOneShotPiArgs` rejects `--continue`, `--fork`, `--mode`, `--session`, `--print`, `--extension`, `--name`, and their short forms. Overriding `--extension` would strip the completion reporting from the child; overriding `--name` would break its title.

## Shell support

The runner uses a small Node wrapper instead of generating Fish-, Bash-, or Zsh-specific lifecycle commands:

- Bash, Zsh, Fish, Dash, and conventional Unix shells: login shell with `-lc`;
- Nushell: `--login -c`;
- PowerShell: `-NoLogo -Command`;
- unknown shells: conventional `-lc` fallback.

The command itself must still use syntax understood by the target pane's configured shell.

## Result extraction

`lastAssistantResult` scans the session branch from the end: the last assistant message with text wins; a tool-call-only final turn falls back to the previous text. `exitCode` reflects the failure stop reasons (`error`, `aborted`, `length`).

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test with type stripping
npm run check        # both
npm run pack:check   # npm pack --dry-run
```

Unit tests cover the pure helpers in `core.ts`. The sidecar protocol itself is exercised end-to-end: run a `run_pi` worker and confirm exactly one steer arrives, the `.run` log exists, and the tab auto-closes.

## Publishing

`npm publish` after `npm run pack:check`. The package ships TypeScript directly (`files: ["src", "README.md", "LICENSE"]`); Pi loads it through its extension runtime. Peer dependencies are `*` because the extension follows the installed Pi/Herdr version at runtime — a deliberate choice that trades type safety against version coupling.

## Known limitations

- `run_pi` workers are intentionally ephemeral and cannot be resumed; use `spawn_pi` for continuing conversation.
- Automatic steer delivery requires the parent Pi process to remain alive.
- New Herdr tabs need a short shell-readiness barrier because Herdr 0.7.5 does not accept an argv process at tab creation.
- Windows support follows Herdr's Windows support and is not yet verified by this project.
