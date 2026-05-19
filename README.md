# Codex Plan Runner

`codex-plan-runner` is a small Node.js tool that executes a multi-step implementation plan with strict session isolation.

Each step runs in a fresh `codex exec --ephemeral` session, so the model does not inherit previous chat context. After every N completed steps, the runner can open another fresh session for cleanup/review work.

## Files

- `run-plan.js`
  Main runner script.
- `example-progress.md`
  Example plan file in Markdown.
- `logs/`
  Runtime output directory. Created automatically and ignored by Git.

## Requirements

- Node.js
- `codex` available in PATH
- A logged-in Codex desktop or CLI environment

## Usage

```powershell
node run-plan.js --dry-run
node run-plan.js --max-steps 1 --timeout-ms 600000
node run-plan.js --plan example-progress.md
```

## How it works

1. Read the plan file.
2. Find the next unchecked step.
3. Run that step in a fresh `codex exec --ephemeral` session.
4. Mark the step as complete if the session succeeds.
5. Run a separate review session after every configured number of completed steps.

## Logs

Each run writes:

- `*.md`
  Final assistant summary for the step.
- `*.stdout.log`
  Raw `codex exec` standard output.
- `*.stderr.log`
  Raw `codex exec` standard error.

## Notes

- The runner updates the plan file itself instead of asking the model to tick boxes.
- `--timeout-ms` controls the maximum runtime of each step session.
- Review steps are separate sessions by design.
