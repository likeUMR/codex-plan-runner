# Codex Plan Runner

`codex-plan-runner` is a small Node.js tool for executing a multi-step implementation plan with strict session isolation.

The core idea is simple:

- each step runs in a fresh `codex exec --ephemeral` session
- the runner, not the model, owns plan state
- review and cleanup can be injected at a fixed cadence

This is useful when you want a long implementation plan but do not want one large chat session to accumulate too much context and drift.

## What it does

`codex-plan-runner` reads a Markdown plan file, finds unchecked steps, and runs them one by one. If a step succeeds, the runner updates the checkbox from `[ ]` to `[x]`.

After every configured number of completed steps, the runner opens a separate fresh session for review and cleanup work.

## Requirements

- Node.js
- `codex` available in `PATH`
- a logged-in Codex desktop or CLI environment

## Files

- `run-plan.js`
  Main runner script
- `example-progress.md`
  Example Markdown plan
- `example-progress.json`
  Example JSON plan
- `logs/`
  Runtime output directory, created automatically and ignored by Git

## Quick start

Inspect the parsed plan without running anything:

```powershell
node run-plan.js --status
```

Preview the sessions that would be started:

```powershell
node run-plan.js --dry-run
```

Run exactly one pending step:

```powershell
node run-plan.js --max-steps 1 --timeout-ms 600000
```

Run against a custom plan file:

```powershell
node run-plan.js --plan my-plan.md
node run-plan.js --plan example-progress.json --status
```

## Command line options

- `--plan <path>`
  Path to the plan file. Supports `.md` and `.json`. Default: `example-progress.md`
- `--dry-run`
  Do not call `codex`; only print what would be executed
- `--status`
  Parse the plan and print runner status without executing steps
- `--max-steps <n>`
  Maximum number of pending implementation steps to run in this invocation
- `--timeout-ms <n>`
  Per-session timeout in milliseconds. Default: `1200000`

## Plan file formats

The runner currently supports:

- Markdown plans: `.md`
- JSON plans: `.json`

Markdown is easier to edit by hand. JSON is more rigid and easier to generate or update programmatically.

## Markdown format

The Markdown runner format expects three parts:

1. a `plan-config` HTML comment block
2. a `## Steps` section
3. an optional `## Review Prompt` section

Minimal example:

```md
# Demo Plan

<!-- plan-config
workspace: .
reviewEvery: 2
model: gpt-5.5
sandbox: danger-full-access
ephemeral: true
-->

## Steps

- [ ] STEP-01 Extract constants
  PROMPT: Implement phase 1 in the current project.
    Goal: collect repeated constants into a shared config module.

- [ ] STEP-02 Split input handling
  PROMPT: Implement phase 2 in the current project.
    Goal: isolate keyboard listeners and key state tracking.

## Review Prompt

Review the current project and directly clean up low-risk issues.
```

## Markdown reference

### 1. `plan-config`

This is parsed from:

```md
<!-- plan-config
key: value
...
-->
```

Supported keys today:

- `workspace`
  Working directory passed to `codex exec --cd`
- `reviewEvery`
  Run one review session after every N completed steps
- `model`
  Passed to `codex exec --model`
- `sandbox`
  Passed to `codex exec --sandbox`
- `ephemeral`
  If not `false`, the runner adds `--ephemeral`

Parsing rules:

- blank lines are ignored
- lines starting with `#` are ignored
- `true` and `false` are parsed as booleans
- digit-only values are parsed as numbers
- everything else is kept as a string

### 2. `## Steps`

Each step must follow this shape:

```md
- [ ] STEP-01 Human readable title
  PROMPT: First line of prompt
    Additional prompt lines
    More prompt lines
```

Rules:

- a step line must start with `- [ ]` or `- [x]`
- the next token is treated as the step id, for example `STEP-01`
- the rest of the same line is treated as the step title
- the prompt must start on a line beginning with two spaces + `PROMPT:`
- further prompt lines must be indented by at least four spaces

What gets parsed:

- `done`
  Whether the step is already checked
- `id`
  Step identifier
- `title`
  Human-readable label
- `prompt`
  The full multi-line prompt text after indentation is stripped

### 3. `## Review Prompt`

This section is optional.

If present, its contents are used as the base review prompt every time review cadence is reached. If omitted, the runner falls back to a built-in generic cleanup prompt.

## JSON format

JSON plans use a single object with:

- `config`
- `steps`
- optional `reviewPrompt`

Minimal example:

```json
{
  "config": {
    "workspace": ".",
    "reviewEvery": 2,
    "model": "gpt-5.5",
    "sandbox": "danger-full-access",
    "ephemeral": true
  },
  "steps": [
    {
      "id": "STEP-01",
      "title": "Extract constants",
      "done": false,
      "prompt": "Implement phase 1 in the current project.\nGoal: collect repeated constants into a shared config module."
    },
    {
      "id": "STEP-02",
      "title": "Split input handling",
      "done": false,
      "prompt": "Implement phase 2 in the current project.\nGoal: isolate keyboard listeners and key state tracking."
    }
  ],
  "reviewPrompt": "Review the current project and directly clean up low-risk issues."
}
```

### JSON field reference

#### `config`

Supported keys are the same as the Markdown `plan-config` block:

- `workspace`
- `reviewEvery`
- `model`
- `sandbox`
- `ephemeral`

#### `steps`

`steps` must be a non-empty array of objects with:

- `id`
  Required string
- `title`
  Required string
- `prompt`
  Required string
- `done`
  Optional boolean-like value; falsy means pending

#### `reviewPrompt`

Optional string. If omitted or empty, the runner uses the built-in fallback cleanup prompt.

## Execution logic

The runner behaves like this:

1. Parse the plan file based on extension
2. Resolve `workspace` relative to the plan file directory
3. Find all unchecked steps
4. Take up to `--max-steps` pending steps
5. For each step:
   - build a fresh step prompt
   - call `codex exec` in a new process
   - wait for it to finish
   - if successful, mark the step as complete
6. After every `reviewEvery` completed steps:
   - build a fresh review prompt
   - call `codex exec` in a separate new process

This means:

- implementation steps do not share conversation context
- review steps do not share conversation context with implementation steps
- plan progress is controlled outside the model

When the runner marks a step complete:

- Markdown plans are updated by replacing `- [ ] STEP-ID` with `- [x] STEP-ID`
- JSON plans are updated by setting the matching step's `done` field to `true`

## Prompt augmentation

The runner does not send the raw plan prompt as-is. It appends extra guardrails.

For implementation steps, it adds instructions like:

- this is a fresh session
- do not rely on previous steps
- do not edit the plan file directly
- finish with a short summary

For review sessions, it adds instructions like:

- this is a fresh session
- review may edit code directly
- do not edit the plan file
- prefer low-risk cleanup

## Success and failure behavior

### Success

A step is considered successful when:

- `codex exec` exits with status `0`
- the process was not terminated by timeout or signal

If successful:

- the step checkbox is updated from `[ ]` to `[x]`
- the final assistant summary is printed
- logs are written to `logs/`

### Failure

If a step or review session fails:

- the runner stops immediately
- the step is not checked
- log file paths are printed for inspection

There is no automatic retry yet.

## Logs

Each session writes three files:

- `*.md`
  Final assistant summary from `--output-last-message`
- `*.stdout.log`
  Raw `codex exec` standard output
- `*.stderr.log`
  Raw `codex exec` standard error

This separation is useful because the final summary is compact, while stdout and stderr preserve the full execution record for debugging.

## Practical workflow

A good workflow usually looks like this:

1. Write or update the plan file
2. Run `node run-plan.js --status`
3. Run `node run-plan.js --dry-run`
4. Run one or two steps first with `--max-steps`
5. Inspect changes and logs
6. Let the runner continue through the rest of the plan

## Design choices

Why the runner updates plan state itself:

- more reliable than asking the model to tick boxes
- clearer separation between orchestration and implementation

Why review runs in separate sessions:

- implementation prompts stay focused
- cleanup prompts stay focused
- review can be inserted at a fixed cadence instead of being mixed into every step

Why support both Markdown and JSON:

- Markdown is easy to read and edit by hand
- JSON is easier to generate and update from other tools
- different teams prefer different authoring styles

Why Markdown still remains the default:

- easy to read and edit by hand
- easy to commit and review in Git
- good enough for simple orchestration

## Limitations

- Markdown parsing is intentionally simple and format-sensitive
- JSON parsing is strict and expects the documented object shape
- no built-in retry policy yet
- no structured result schema yet
- no automatic verification command pipeline yet
- only `[x]` is treated as completed

## Suggested next improvements

- add retries with backoff
- add optional verification commands after each step
- support YAML plan formats
- support structured result extraction
- support a quieter console mode
