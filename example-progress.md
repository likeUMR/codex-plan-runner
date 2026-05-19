# Codex Plan Demo

<!-- plan-config
workspace: .
reviewEvery: 2
model: gpt-5.5
sandbox: danger-full-access
ephemeral: true
-->

## Steps

- [ ] STEP-01 Extract shared constants
  PROMPT: Implement phase 1 of the demo refactor plan in the current project.
    Goal: collect scattered gameplay constants, tuning values, colors, and UI strings into a shared config structure.
    Keep behavior unchanged and avoid broad renames.

- [ ] STEP-02 Isolate input handling
  PROMPT: Implement phase 2 of the demo refactor plan in the current project.
    Goal: isolate keyboard listeners, key state storage, and input queries behind a dedicated structure.
    Keep behavior unchanged and avoid unrelated refactors.

- [ ] STEP-03 Split main loop responsibilities
  PROMPT: Implement phase 3 of the demo refactor plan in the current project.
    Goal: clarify the boundaries between update, render, and state transition logic.
    Prefer small refactors and keep the current gameplay behavior.

- [ ] STEP-04 Consolidate repeated rendering details
  PROMPT: Implement phase 4 of the demo refactor plan in the current project.
    Goal: collect repeated labels, repeated style fragments, and repeated draw parameters into reusable structures.
    Remove branches that are clearly obsolete.

- [ ] STEP-05 Final cleanup pass
  PROMPT: Implement phase 5 of the demo refactor plan in the current project.
    Goal: normalize naming and minor cleanup after earlier steps without adding new abstraction layers.
    Focus on readability and behavior stability.

## Review Prompt

Review the current project and directly clean up issues where appropriate.
If you find temporary implementations, redundant implementations, or repeated logic, clean them up.
If you find obsolete code, remove it.
Prefer low-risk, high-value cleanup and avoid large rewrites.
