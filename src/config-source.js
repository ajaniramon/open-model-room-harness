import { existsSync, readFileSync } from "node:fs";

export function loadJsonConfig(path) {
  if (!existsSync(path)) return {};

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error.message}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

export function valueAt(source, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => {
    if (!value || typeof value !== "object" || !(key in value)) return undefined;
    return value[key];
  }, source);
}

export function setting(source, dottedPath, environmentName, fallback, environment = process.env) {
  const configured = valueAt(source, dottedPath);
  if (configured !== undefined) return configured;

  const environmentValue = environment[environmentName];
  if (environmentValue !== undefined && environmentValue !== "") return environmentValue;
  return fallback;
}
