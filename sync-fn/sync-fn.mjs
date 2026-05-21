#!/usr/bin/env node
// Canonical Appwrite function sync script.
// Copied verbatim into each function repo at .github/scripts/sync-fn.mjs
// and invoked from sync-spec.yml (--mode spec) or workflow_dispatch (--mode deploy).
// Modes: spec = metadata-only update; deploy = metadata + tar.gz upload (activate gated by ACTIVATE env).
// Required env: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY.
// Optional env: APPWRITE_FUNCTION_ID (overrides $id), ACTIVATE ("true" to activate immediately), FNCONFIG_PATH.

import { existsSync, readFileSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import yaml from "js-yaml";
import { Client, Functions, AppwriteException } from "node-appwrite";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120;

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[sync-fn] error: ${name} env var is required`);
    process.exit(2);
  }
  return v;
}

function log(msg) {
  console.log(`[sync-fn] ${msg}`);
}

function reportAppwriteError(stage, err) {
  if (err instanceof AppwriteException) {
    console.error(`[sync-fn] ${stage} failed: ${err.message} (code=${err.code} type=${err.type})`);
    if (err.response) console.error(`[sync-fn] response: ${err.response}`);
  } else {
    console.error(`[sync-fn] ${stage} failed: ${err?.stack || err}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { values } = parseArgs({ options: { mode: { type: "string", default: "spec" } } });
const mode = values.mode;
if (mode !== "spec" && mode !== "deploy") {
  console.error(`[sync-fn] error: --mode must be 'spec' or 'deploy' (got '${mode}')`);
  process.exit(2);
}

const endpoint = must("APPWRITE_ENDPOINT");
const projectId = must("APPWRITE_PROJECT_ID");
const apiKey = must("APPWRITE_API_KEY");
const fnConfigPath = resolve(process.env.FNCONFIG_PATH || ".fnconfig.yml");
const activate = (process.env.ACTIVATE ?? "false").toLowerCase() === "true";

if (!existsSync(fnConfigPath)) {
  console.error(`[sync-fn] error: ${fnConfigPath} not found`);
  process.exit(2);
}
const cfg = yaml.load(readFileSync(fnConfigPath, "utf8")) || {};
const functionId = process.env.APPWRITE_FUNCTION_ID || cfg.$id || cfg.id;
if (!functionId) {
  console.error("[sync-fn] error: no function id (set APPWRITE_FUNCTION_ID or $id in .fnconfig.yml)");
  process.exit(2);
}
if (!cfg.name) {
  console.error("[sync-fn] error: .fnconfig.yml is missing required 'name' field");
  process.exit(2);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const functions = new Functions(client);

log(`mode=${mode} project=${projectId} functionId=${functionId} name=${cfg.name}`);

const updateParams = {
  functionId,
  name: cfg.name,
  runtime: cfg.runtime,
  execute: cfg.execute ?? [],
  events: cfg.events ?? [],
  schedule: cfg.schedule ?? "",
  timeout: cfg.timeout,
  enabled: cfg.enabled ?? true,
  logging: cfg.logging ?? true,
  entrypoint: cfg.entrypoint,
  commands: cfg.commands ?? "",
  scopes: cfg.scopes ?? [],
};
if (cfg.buildSpecification) updateParams.buildSpecification = cfg.buildSpecification;
if (cfg.runtimeSpecification) updateParams.runtimeSpecification = cfg.runtimeSpecification;

log("updating function metadata...");
try {
  await functions.update(updateParams);
} catch (err) {
  reportAppwriteError("metadata update", err);
  process.exit(1);
}
log("metadata update OK");

if (mode === "spec") {
  log("spec sync complete.");
  process.exit(0);
}

const ignored = cfg.ignore ?? ["node_modules", ".git", ".github", ".vscode", ".DS_Store", "__pycache__", ".venv"];
const tmpDir = mkdtempSync(join(tmpdir(), `fn-${functionId}-`));
const tarPath = join(tmpDir, `fn-${functionId}.tar.gz`);
const excludeArgs = ignored.flatMap((p) => ["--exclude", p]);

log(`packaging ${process.cwd()} -> ${tarPath} (activate=${activate})`);
const tarRes = spawnSync("tar", ["-czf", tarPath, ...excludeArgs, "-C", process.cwd(), "."], { stdio: "inherit" });
if (tarRes.status !== 0) {
  console.error(`[sync-fn] error: tar exited with status ${tarRes.status}`);
  process.exit(1);
}
const tarStat = statSync(tarPath);
log(`tarball ready (${tarStat.size} bytes)`);

const buf = readFileSync(tarPath);
const codeFile = new File([buf], `fn-${functionId}.tar.gz`, { type: "application/gzip" });

log("creating deployment...");
let deployment;
try {
  deployment = await functions.createDeployment({
    functionId,
    code: codeFile,
    activate,
    entrypoint: cfg.entrypoint,
    commands: cfg.commands ?? "",
  });
} catch (err) {
  reportAppwriteError("createDeployment", err);
  process.exit(1);
}
log(`deployment created: id=${deployment.$id} initial status=${deployment.status}`);

let final = deployment;
for (let i = 1; i <= POLL_MAX_ATTEMPTS; i++) {
  if (final.status === "ready" || final.status === "failed" || final.status === "cancelled") break;
  await sleep(POLL_INTERVAL_MS);
  try {
    final = await functions.getDeployment({ functionId, deploymentId: deployment.$id });
  } catch (err) {
    reportAppwriteError(`getDeployment (poll #${i})`, err);
    process.exit(1);
  }
  log(`poll #${i}: status=${final.status}`);
}

if (final.status === "ready") {
  log(`deployment ready: id=${final.$id} sourceSize=${final.sourceSize} buildSize=${final.buildSize} active=${activate}`);
  if (!activate) log("deployment built but INACTIVE. Activate via Appwrite Console or updateFunctionDeployment when smoke-tested.");
  process.exit(0);
}
console.error(`[sync-fn] deployment ${final.$id} ended with status=${final.status} after ${POLL_MAX_ATTEMPTS} polls`);
process.exit(1);
