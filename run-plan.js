#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
  console.error(`[plan-runner] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    plan: "example-progress.md",
    dryRun: false,
    statusOnly: false,
    maxSteps: Number.MAX_SAFE_INTEGER,
    timeoutMs: 20 * 60 * 1000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--status") {
      args.statusOnly = true;
      continue;
    }
    if (value === "--plan") {
      args.plan = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--max-steps") {
      args.maxSteps = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
    fail(`Unknown argument: ${value}`);
  }

  if (!Number.isFinite(args.maxSteps) || args.maxSteps <= 0) {
    fail("--max-steps must be a positive number");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    fail("--timeout-ms must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node run-plan.js [--plan path] [--max-steps N] [--timeout-ms N] [--dry-run] [--status]

Examples:
  node run-plan.js --status
  node run-plan.js --dry-run
  node run-plan.js --max-steps 1
  node run-plan.js --max-steps 1 --timeout-ms 600000
  node run-plan.js --plan example-progress.md
`);
}

function parseConfig(block) {
  const config = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }
    let [, key, value] = match;
    value = value.trim();
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(value)) value = Number(value);
    config[key] = value;
  }
  return config;
}

function normalizePlanObject(plan) {
  if (!plan || typeof plan !== "object") {
    fail("Plan data must be an object");
  }

  const config = plan.config && typeof plan.config === "object" ? plan.config : {};
  const reviewPrompt = typeof plan.reviewPrompt === "string" ? plan.reviewPrompt.trim() : "";
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : null;

  if (!rawSteps || rawSteps.length === 0) {
    fail("Plan must contain a non-empty `steps` array");
  }

  const steps = rawSteps.map((step, index) => {
    if (!step || typeof step !== "object") {
      fail(`Step at index ${index} must be an object`);
    }
    if (typeof step.id !== "string" || step.id.trim() === "") {
      fail(`Step at index ${index} is missing a valid string \`id\``);
    }
    if (typeof step.title !== "string" || step.title.trim() === "") {
      fail(`Step ${step.id} is missing a valid string \`title\``);
    }
    if (typeof step.prompt !== "string" || step.prompt.trim() === "") {
      fail(`Step ${step.id} is missing a valid string \`prompt\``);
    }

    return {
      done: Boolean(step.done),
      id: step.id.trim(),
      title: step.title.trim(),
      prompt: step.prompt.trim(),
    };
  });

  return { config, reviewPrompt, steps };
}

function parseMarkdownPlan(content) {
  const configMatch = content.match(/<!--\s*plan-config([\s\S]*?)-->/);
  const config = configMatch ? parseConfig(configMatch[1]) : {};

  const reviewMatch = content.match(/## Review Prompt\s+([\s\S]*?)$/);
  const reviewPrompt = reviewMatch ? reviewMatch[1].trim() : "";

  const stepsSectionMatch = content.match(/## Steps\s+([\s\S]*?)(?:\n## |\s*$)/);
  if (!stepsSectionMatch) {
    fail("Could not find `## Steps` section in plan file");
  }

  const lines = stepsSectionMatch[1].split(/\r?\n/);
  const steps = [];
  let current = null;

  for (const line of lines) {
    const stepMatch = line.match(/^-\s\[( |x)\]\s+([A-Z0-9_-]+)\s+(.+)$/);
    if (stepMatch) {
      if (current) {
        current.prompt = current.promptLines.join("\n").trim();
        delete current.promptLines;
        steps.push(current);
      }
      current = {
        done: stepMatch[1] === "x",
        id: stepMatch[2],
        title: stepMatch[3].trim(),
        promptLines: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const promptStart = line.match(/^\s{2}PROMPT:\s*(.*)$/);
    if (promptStart) {
      current.promptLines.push(promptStart[1]);
      continue;
    }

    const promptContinue = line.match(/^\s{4,}(.*)$/);
    if (promptContinue) {
      current.promptLines.push(promptContinue[1]);
    }
  }

  if (current) {
    current.prompt = current.promptLines.join("\n").trim();
    delete current.promptLines;
    steps.push(current);
  }

  if (steps.length === 0) {
    fail("No step entries were found in the plan");
  }

  for (const step of steps) {
    if (!step.prompt) {
      fail(`Step ${step.id} is missing a PROMPT block`);
    }
  }

  return { config, reviewPrompt, steps };
}

function parseJsonPlan(content) {
  let plan;
  try {
    plan = JSON.parse(content);
  } catch (error) {
    fail(`Could not parse JSON plan: ${error.message}`);
  }

  return normalizePlanObject(plan);
}

function parsePlan(content, planPath) {
  const ext = path.extname(planPath).toLowerCase();
  if (ext === ".json") {
    return parseJsonPlan(content);
  }
  return parseMarkdownPlan(content);
}

function formatConfigValue(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function printPlanStatus({ planPath, workspace, parsed, maxSteps }) {
  const completed = countCompleted(parsed.steps);
  const pending = parsed.steps.filter((step) => !step.done);
  const cadence = Number(parsed.config.reviewEvery || 2);

  console.log(`[plan-runner] Plan: ${planPath}`);
  console.log(`[plan-runner] Format: ${path.extname(planPath).toLowerCase() === ".json" ? "json" : "markdown"}`);
  console.log(`[plan-runner] Workspace: ${workspace}`);
  console.log(`[plan-runner] Total steps: ${parsed.steps.length}`);
  console.log(`[plan-runner] Completed: ${completed}`);
  console.log(`[plan-runner] Pending: ${pending.length}`);
  console.log(`[plan-runner] Review cadence: every ${cadence} step(s)`);

  if (Object.keys(parsed.config).length > 0) {
    console.log("[plan-runner] Config:");
    for (const [key, value] of Object.entries(parsed.config)) {
      console.log(`  - ${key}: ${formatConfigValue(value)}`);
    }
  }

  console.log("[plan-runner] Next steps:");
  for (const step of pending.slice(0, maxSteps)) {
    console.log(`  - ${step.id}: ${step.title}`);
  }

  if (!parsed.reviewPrompt) {
    console.log("[plan-runner] Review prompt: not defined, built-in fallback will be used");
  }
}

function countCompleted(steps) {
  return steps.filter((step) => step.done).length;
}

function markStepComplete(planPath, stepId) {
  if (path.extname(planPath).toLowerCase() === ".json") {
    markJsonStepComplete(planPath, stepId);
    return;
  }

  const content = fs.readFileSync(planPath, "utf8");
  const updated = content.replace(
    new RegExp(`- \\[ \\] ${stepId}\\b`),
    `- [x] ${stepId}`
  );

  if (updated === content) {
    fail(`Could not mark ${stepId} as complete in ${planPath}`);
  }

  fs.writeFileSync(planPath, updated, "utf8");
}

function markJsonStepComplete(planPath, stepId) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  } catch (error) {
    fail(`Could not parse JSON plan while marking completion: ${error.message}`);
  }

  if (!plan || !Array.isArray(plan.steps)) {
    fail(`JSON plan ${planPath} does not contain a valid \`steps\` array`);
  }

  const step = plan.steps.find((entry) => entry && entry.id === stepId);
  if (!step) {
    fail(`Could not find ${stepId} in ${planPath}`);
  }

  step.done = true;
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

function buildStepPrompt(step, planPath) {
  return [
    step.prompt,
    "",
    "Extra requirements:",
    "1. This is a completely fresh session. Do not rely on previous step conversations.",
    "2. Only implement what is required for the current step.",
    `3. Do not modify the plan file ${planPath}; the runner updates plan state externally.`,
    "4. Finish with a concise summary of what changed, what was verified, and what risks remain.",
  ].join("\n");
}

function buildReviewPrompt(customPrompt, planPath) {
  const base = customPrompt || [
    "Review the current project and directly clean up issues where appropriate.",
    "If you find temporary implementations, redundant implementations, or repeated logic, clean them up.",
    "If you find obsolete code, remove it.",
  ].join("\n");

  return [
    base,
    "",
    "Extra requirements:",
    "1. This is a completely fresh session. Do not rely on implementation-step context.",
    `2. You may modify code directly, but do not modify the plan file ${planPath}.`,
    "3. Prefer low-risk, high-value cleanup and avoid large rewrites.",
    "4. Finish with a short cleanup summary and any remaining risks.",
  ].join("\n");
}

function runCodex({ cwd, prompt, label, config, dryRun, logsDir, timeoutMs }) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}`;
  const outputFile = path.join(logsDir, `${stem}.md`);
  const stdoutFile = path.join(logsDir, `${stem}.stdout.log`);
  const stderrFile = path.join(logsDir, `${stem}.stderr.log`);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    "--cd",
    cwd,
  ];

  if (config.ephemeral !== false) {
    args.push("--ephemeral");
  }
  if (config.model) {
    args.push("--model", String(config.model));
  }
  if (config.sandbox) {
    args.push("--sandbox", String(config.sandbox));
  }

  args.push(prompt);

  console.log(`\n[plan-runner] ${label}`);
  console.log(`[plan-runner] codex ${args.map(quoteArg).join(" ")}`);

  if (dryRun) {
    return { status: 0, outputFile, stdoutFile, stderrFile, dryRun: true };
  }

  const result = spawnSync("codex", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    fs.writeFileSync(stdoutFile, result.stdout, "utf8");
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    fs.writeFileSync(stderrFile, result.stderr, "utf8");
  }

  return {
    status: result.status ?? 1,
    signal: result.signal,
    error: result.error,
    outputFile,
    stdoutFile,
    stderrFile,
  };
}

function quoteArg(value) {
  if (/^[A-Za-z0-9._:\\/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

function tailText(text, maxChars = 4000) {
  if (!text || text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(args.plan);

  if (!fs.existsSync(planPath)) {
    fail(`Plan file not found: ${planPath}`);
  }

  const planDir = path.dirname(planPath);
  const content = fs.readFileSync(planPath, "utf8");
  const parsed = parsePlan(content, planPath);
  const workspace = path.resolve(planDir, parsed.config.workspace || ".");
  const logsDir = path.join(planDir, "logs");
  ensureDir(logsDir);

  if (args.statusOnly) {
    printPlanStatus({
      planPath,
      workspace,
      parsed,
      maxSteps: args.maxSteps,
    });
    return;
  }

  let completed = countCompleted(parsed.steps);
  const pendingSteps = parsed.steps.filter((step) => !step.done).slice(0, args.maxSteps);

  if (pendingSteps.length === 0) {
    console.log("[plan-runner] No pending steps. Nothing to do.");
    return;
  }

  console.log(`[plan-runner] Plan: ${planPath}`);
  console.log(`[plan-runner] Workspace: ${workspace}`);
  console.log(`[plan-runner] Pending this run: ${pendingSteps.length}`);
  console.log(`[plan-runner] Already completed: ${completed}`);
  console.log(`[plan-runner] Review cadence: every ${parsed.config.reviewEvery || 2} step(s)`);

  for (const step of pendingSteps) {
    const stepPrompt = buildStepPrompt(step, planPath);
    const result = runCodex({
      cwd: workspace,
      prompt: stepPrompt,
      label: `step-${step.id}`,
      config: parsed.config,
      dryRun: args.dryRun,
      logsDir,
      timeoutMs: args.timeoutMs,
    });

    if (result.error) {
      fail(`Step ${step.id} failed to launch: ${result.error.message}`);
    }
    if (result.status !== 0) {
      if (result.signal) {
        fail(`Step ${step.id} terminated by signal ${result.signal}. See log target: ${result.outputFile}`);
      }
      const stderrTail = tailText(readIfExists(result.stderrFile));
      if (stderrTail) {
        console.error(stderrTail);
      }
      fail(`Step ${step.id} failed. See logs: ${result.outputFile}, ${result.stdoutFile}, ${result.stderrFile}`);
    }

    if (!args.dryRun) {
      markStepComplete(planPath, step.id);
    }

    completed += 1;
    const finalMessage = readIfExists(result.outputFile);
    if (finalMessage) {
      console.log(finalMessage);
    }
    console.log(`[plan-runner] Step ${step.id} completed${args.dryRun ? " (dry-run)" : ""}.`);

    const cadence = Number(parsed.config.reviewEvery || 2);
    if (cadence > 0 && completed % cadence === 0) {
      const reviewPrompt = buildReviewPrompt(parsed.reviewPrompt, planPath);
      const reviewResult = runCodex({
        cwd: workspace,
        prompt: reviewPrompt,
        label: `review-after-${step.id}`,
        config: parsed.config,
        dryRun: args.dryRun,
        logsDir,
        timeoutMs: args.timeoutMs,
      });

      if (reviewResult.error) {
        fail(`Review after ${step.id} failed to launch: ${reviewResult.error.message}`);
      }
      if (reviewResult.status !== 0) {
        if (reviewResult.signal) {
          fail(`Review after ${step.id} terminated by signal ${reviewResult.signal}. See log target: ${reviewResult.outputFile}`);
        }
        const reviewStderrTail = tailText(readIfExists(reviewResult.stderrFile));
        if (reviewStderrTail) {
          console.error(reviewStderrTail);
        }
        fail(`Review after ${step.id} failed. See logs: ${reviewResult.outputFile}, ${reviewResult.stdoutFile}, ${reviewResult.stderrFile}`);
      }

      const reviewMessage = readIfExists(reviewResult.outputFile);
      if (reviewMessage) {
        console.log(reviewMessage);
      }
      console.log(`[plan-runner] Review after ${step.id} completed${args.dryRun ? " (dry-run)" : ""}.`);
    }
  }

  console.log("\n[plan-runner] Run finished.");
}

main();
