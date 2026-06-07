#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function getNodeMajor(versionText) {
  const match = /^v(\d+)\./.exec(versionText.trim());
  return match ? Number(match[1]) : null;
}

function isUsableNode(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return false;
  }

  const result = spawnSync(binaryPath, ["-v"], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout) {
    return false;
  }

  const major = getNodeMajor(result.stdout);
  return major !== null && major >= 20;
}

function findNvmNodeBinary() {
  const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node");
  if (!fs.existsSync(nvmRoot)) {
    return null;
  }

  const candidates = fs
    .readdirSync(nvmRoot)
    .map((entry) => ({
      entry,
      fullPath: path.join(nvmRoot, entry, "bin", "node"),
    }))
    .filter((item) => isUsableNode(item.fullPath))
    .sort((left, right) => right.entry.localeCompare(left.entry));

  return candidates[0]?.fullPath ?? null;
}

function resolveNodeBinary() {
  const currentMajor = getNodeMajor(process.version);
  if (currentMajor !== null && currentMajor >= 20) {
    return process.execPath;
  }

  const explicitBinary = process.env.NODE20_BIN;
  if (isUsableNode(explicitBinary)) {
    return explicitBinary;
  }

  const commonPaths = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    findNvmNodeBinary(),
  ].filter(Boolean);

  const detectedBinary = commonPaths.find((candidate) => isUsableNode(candidate));
  if (detectedBinary) {
    return detectedBinary;
  }

  console.error(
    [
      "This project requires Node.js 20+ to run the official OpenAI SDK.",
      "No suitable Node.js runtime was found automatically.",
      "Set NODE20_BIN=/absolute/path/to/node or run `nvm use 20` first.",
    ].join("\n"),
  );
  process.exit(1);
}

const [, , ...args] = process.argv;
if (args.length === 0) {
  console.error("Usage: node20-runner.cjs <script> [...args]");
  process.exit(1);
}

const nodeBinary = resolveNodeBinary();
const child = spawn(nodeBinary, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to launch Node.js runtime: ${error.message}`);
  process.exit(1);
});
