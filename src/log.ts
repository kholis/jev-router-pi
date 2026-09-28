import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// pi owns the terminal in every mode and redraws over anything we print, so logging always
// goes to a file and never to stderr or stdout.
export const LOG_FILE = join(homedir(), ".jev-pi.log");

export function log(line: string) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [jev] ${line}\n`);
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line: string) => {
  if (process.env.JEV_DEBUG) log(line);
};
