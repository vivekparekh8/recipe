import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export async function run(cmd, args, cwd, options = {}) {
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  if (options.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trimEnd());
          return;
        }
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      });

      child.stdin.end(options.input);
    });
  }

  const result = await execFileAsync(cmd, args, {
    cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

export async function createTempRepo(name) {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  await run("git", ["init"], repoDir);
  await run("git", ["config", "user.name", "Recipe Test"], repoDir);
  await run("git", ["config", "user.email", "recipe@example.com"], repoDir);
  return repoDir;
}

export async function commitFile(repoDir, relativePath, contents, message) {
  const filePath = path.join(repoDir, relativePath);
  await writeFile(filePath, contents, "utf8");
  await run("git", ["add", relativePath], repoDir);
  await run("git", ["commit", "-m", message], repoDir);
  return run("git", ["rev-parse", "HEAD"], repoDir);
}

export async function diff(repoDir, base, target) {
  const result = await execFileAsync("git", ["diff", "--binary", base, target], {
    cwd: repoDir,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

export async function runCli(repoDir, args, options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(here, "..", "src", "cli.js");
  return run("node", [cliPath, ...args], repoDir, options);
}

export async function runCliResult(repoDir, args, options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(here, "..", "src", "cli.js");
  const env = options.env ? { ...process.env, ...options.env } : process.env;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}
