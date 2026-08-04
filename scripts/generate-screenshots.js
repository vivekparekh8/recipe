#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "src", "cli.js");
const outputDir = path.join(root, "docs", "screenshots");

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

async function recipe(args, cwd) {
  return run("node", [cliPath, ...args], cwd);
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sanitizeOutput(value, repoDir, resolvedRepoDir) {
  return value
    .replaceAll(resolvedRepoDir, "~/recipe-demo")
    .replaceAll(repoDir, "~/recipe-demo")
    .replace(/\b[0-9a-f]{64}\b/g, (match) => `${match.slice(0, 12)}...`)
    .replace(/\b[0-9a-f]{40}\b/g, (match) => `${match.slice(0, 12)}...`);
}

function wrapTerminalLine(line, maxLength = 86) {
  if (line.length <= maxLength) {
    return [line];
  }

  const wrapped = [];
  let remaining = line;
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const breakAt = candidate.lastIndexOf(" ");
    const width = breakAt >= 64 ? breakAt : maxLength;
    wrapped.push(remaining.slice(0, width));
    remaining = `  ${remaining.slice(width).trimStart()}`;
  }
  wrapped.push(remaining);
  return wrapped;
}

function renderTerminalSvg({ title, command, output }) {
  const lines = [`$ ${command}`, "", ...output.split("\n")]
    .flatMap((line) => wrapTerminalLine(line));
  const lineHeight = 21;
  const width = 1220;
  const height = Math.max(320, 94 + lines.length * lineHeight + 30);
  const text = lines.map((line, index) => {
    const color = index === 0 ? "#f4c95d" : "#dce7df";
    return `  <text x="46" y="${92 + index * lineHeight}" fill="${color}" font-family="Menlo, Monaco, monospace" font-size="14.5" xml:space="preserve">${escapeXml(line)}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101714"/>
      <stop offset="1" stop-color="#17231d"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#07100b" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="#e7e0d0"/>
  <rect x="22" y="20" width="${width - 44}" height="${height - 42}" rx="15" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="22" y="20" width="${width - 44}" height="48" rx="15" fill="#24332b"/>
  <rect x="22" y="53" width="${width - 44}" height="15" fill="#24332b"/>
  <circle cx="47" cy="44" r="6" fill="#ef6a62"/>
  <circle cx="67" cy="44" r="6" fill="#f4c95d"/>
  <circle cx="87" cy="44" r="6" fill="#79c98c"/>
  <text x="410" y="49" fill="#bcd0c3" font-family="Menlo, Monaco, monospace" font-size="14">${escapeXml(title)}</text>
${text}
</svg>
`;
}

async function commit(repoDir, message) {
  await run("git", ["add", "."], repoDir);
  await run("git", ["commit", "-q", "-m", message], repoDir);
}

async function main() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "recipe-screenshot-"));
  const resolvedRepoDir = await realpath(repoDir);
  await mkdir(outputDir, { recursive: true });

  await run("git", ["init", "-q"], repoDir);
  await run("git", ["config", "user.name", "Recipe Demo"], repoDir);
  await run("git", ["config", "user.email", "recipe@example.com"], repoDir);
  await writeFile(
    path.join(repoDir, "calc.js"),
    "export const calc = () => 0;\n",
    "utf8",
  );
  await commit(repoDir, "base");

  const started = JSON.parse(await recipe([
    "codex",
    "start",
    "--prompt",
    "Fix calc so it returns 42, keep the change minimal.",
    "--json",
  ], repoDir));

  const editCommand = "node -e \"require('fs').writeFileSync('calc.js', 'export const calc = () => 42;\\n')\"";
  await recipe([
    "codex",
    "step",
    "--session",
    started.sessionId,
    "--prompt",
    "Apply the one-line implementation change.",
    "--command",
    editCommand,
    "--summary",
    "Update calc implementation",
    "--json",
  ], repoDir);
  await recipe([
    "codex",
    "test",
    "--session",
    started.sessionId,
    "--command",
    "node -e \"import('./calc.js').then(m => process.exit(m.calc() === 42 ? 0 : 1))\"",
    "--summary",
    "calc returns 42",
    "--json",
  ], repoDir);
  await commit(repoDir, "fix: return the answer");
  await recipe([
    "codex",
    "finalize",
    "--session",
    started.sessionId,
    "--target",
    "HEAD",
    "--json",
  ], repoDir);

  const inspect = await recipe(["inspect", "HEAD", "--timeline", "--no-events"], repoDir);
  const attribution = await recipe(["inspect", "HEAD", "--line", "calc.js:1"], repoDir);
  const publish = await recipe(["publish", "HEAD", "--verify", "--replay"], repoDir);
  const verify = await recipe(["verify", "HEAD", "--replay"], repoDir);
  const replay = await recipe(["replay", "HEAD"], repoDir);

  const screenshots = [
    {
      file: "01-inspect-timeline.svg",
      title: "recipe inspect: timeline",
      command: "recipe inspect HEAD --timeline --no-events",
      output: inspect,
    },
    {
      file: "02-line-attribution.svg",
      title: "recipe inspect: source-map lookup",
      command: "recipe inspect HEAD --line calc.js:1",
      output: attribution,
    },
    {
      file: "03-verify-replay.svg",
      title: "recipe verify: trust gate",
      command: "recipe verify HEAD --replay",
      output: verify,
    },
    {
      file: "04-publish.svg",
      title: "recipe publish: review artifacts",
      command: "recipe publish HEAD --verify --replay",
      output: publish,
    },
    {
      file: "05-replay.svg",
      title: "recipe replay: exact",
      command: "recipe replay HEAD",
      output: replay,
    },
  ];

  for (const screenshot of screenshots) {
    const svg = renderTerminalSvg({
      ...screenshot,
      output: sanitizeOutput(screenshot.output, repoDir, resolvedRepoDir),
    });
    await writeFile(path.join(outputDir, screenshot.file), svg, "utf8");
  }

  console.log(`Generated ${screenshots.length} screenshots in ${outputDir}`);
}

await main();
