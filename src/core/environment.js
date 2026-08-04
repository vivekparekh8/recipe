import { access } from "node:fs/promises";
import path from "node:path";

const AGENT_CANDIDATES = [
  { name: "codex", commands: ["codex"] },
  { name: "claude-code", commands: ["claude", "claude-code"] },
  { name: "aider", commands: ["aider"] },
];

async function isExecutable(filePath, platform) {
  try {
    await access(filePath, platform === "win32" ? 0 : 1);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command,
  {
    env = process.env,
    platform = process.platform,
  } = {},
) {
  const separator = platform === "win32" ? ";" : path.delimiter;
  const pathEntries = (env.PATH ?? "").split(separator).filter(Boolean);
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const suffix = platform === "win32" && path.extname(command)
        ? ""
        : extension;
      const candidate = path.resolve(directory, `${command}${suffix}`);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

export async function detectAgents(options = {}) {
  const detected = [];
  for (const agent of AGENT_CANDIDATES) {
    for (const command of agent.commands) {
      const resolvedPath = await resolveExecutable(command, options);
      if (resolvedPath) {
        detected.push({
          name: agent.name,
          command,
          path: resolvedPath,
        });
        break;
      }
    }
  }
  return detected;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
