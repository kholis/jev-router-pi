import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Values are read from the environment, from ~/.jev-pi.env, and from a .env in the launch
 * directory, in increasing order of precedence. Home first, then cwd, so a project-local
 * .env wins over the user-level one. Missing files are fine; the key may still come from
 * the real environment.
 */
export function loadEnvFiles(cwd: string = process.cwd()) {
  for (const file of [join(homedir(), ".jev-pi.env"), join(cwd, ".env")]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable; not an error.
    }
  }
}

export const jevApiKey = () => process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;

/**
 * Startup mode, settable via JEV_DEFAULT_MODE=on in ~/.jev-pi.env (or the environment, or
 * a project .env): `on` makes every new session start with routing enabled, anything else
 * — including unset — keeps routing off until /jev. A mode persisted in the session still
 * wins over this default, so flipping the env var does not resurrect old sessions.
 */
export const jevDefaultMode = (): "auto" | "off" => {
  const v = (process.env.JEV_DEFAULT_MODE ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" || v === "auto" ? "auto" : "off";
};
