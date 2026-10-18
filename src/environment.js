import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

export function loadWorkspaceEnvironment(projectRoot, { control = false } = {}) {
  const controlPath = resolve(projectRoot, ".env.control");
  const localPath = control && existsSync(controlPath)
    ? controlPath
    : resolve(projectRoot, ".env");
  const paths = [
    process.env.AI_WORKSPACE_SECRETS_ENV,
    process.env.AI_WORKSPACE_PROGRAMS_ENV,
    localPath,
  ].filter(Boolean);
  loadEnv({ path: [...new Set(paths)], quiet: true });
  return paths;
}
