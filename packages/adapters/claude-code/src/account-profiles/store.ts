import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClaudeOAuthTokens, ClaudeUsageWindow } from "./oauth.js";

/**
 * Saved Claude sign-ins, the same on every platform: metadata in
 * `<codexhost data>/claude-accounts/profiles.json`, each token in `secrets/<profileId>.json`.
 * Files are owner-only on macOS and Linux; on Windows they inherit the user profile's ACL, the
 * same protection Claude Code gives its own `.credentials.json` there.
 */
export interface StoredClaudeProfile {
  profileId: string;
  label: string;
  email?: string;
  plan?: string;
  accountUuid?: string;
  organizationUuid?: string;
  addedAt: string;
  status: "ready" | "expired" | "error";
  error?: string;
  usage?: { fiveHour?: ClaudeUsageWindow; sevenDay?: ClaudeUsageWindow; observedAt: string };
}

export interface StoredClaudeSwitch {
  at: string;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: "manual" | "auto";
}

export interface StoredClaudeProfiles {
  version: 1;
  activeProfileId: string | null;
  autoSwitch: { enabled: boolean; thresholdPercent: number; continueAfterLimit: boolean };
  profiles: StoredClaudeProfile[];
  lastSwitch: StoredClaudeSwitch | null;
}

export const DEFAULT_AUTO_SWITCH = Object.freeze({
  enabled: true,
  thresholdPercent: 95,
  continueAfterLimit: true,
});

function emptyProfiles(): StoredClaudeProfiles {
  return {
    version: 1,
    activeProfileId: null,
    autoSwitch: { ...DEFAULT_AUTO_SWITCH },
    profiles: [],
    lastSwitch: null,
  };
}

export function claudeAccountsDirectory(environment: NodeJS.ProcessEnv): string {
  const root = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(root, "claude-accounts");
}

/** Windows refuses to replace a file another handle has open; such locks are brief. */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(String(code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function writePrivateFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await replaceFile(temporary, file);
    await chmod(file, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ClaudeProfileMetadataStore {
  readonly #file: string;

  constructor(directory: string) {
    this.#file = path.join(directory, "profiles.json");
  }

  async read(): Promise<StoredClaudeProfiles> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return emptyProfiles();
      throw new Error("Could not read saved Claude accounts", { cause: error });
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      throw new Error("Saved Claude accounts file is unreadable; remove it and add accounts again");
    }
    const value = parsed as unknown as StoredClaudeProfiles;
    return {
      ...emptyProfiles(),
      ...value,
      autoSwitch: { ...DEFAULT_AUTO_SWITCH, ...(value.autoSwitch ?? {}) },
      lastSwitch: value.lastSwitch ?? null,
    };
  }

  async write(value: StoredClaudeProfiles): Promise<void> {
    await writePrivateFile(this.#file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export interface ClaudeTokenStore {
  read(profileId: string): Promise<ClaudeOAuthTokens | null>;
  write(profileId: string, tokens: ClaudeOAuthTokens): Promise<void>;
  delete(profileId: string): Promise<void>;
}

function parseTokens(text: string): ClaudeOAuthTokens | null {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.accessToken === "string" && value.accessToken) {
      return {
        accessToken: value.accessToken,
        ...(typeof value.refreshToken === "string" && value.refreshToken
          ? { refreshToken: value.refreshToken }
          : {}),
        ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
        ...(typeof value.refreshExpiresAt === "number"
          ? { refreshExpiresAt: value.refreshExpiresAt }
          : {}),
        scopes: Array.isArray(value.scopes)
          ? value.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
      };
    }
  } catch {
    // An unreadable entry behaves as a missing sign-in.
  }
  return null;
}

class FileTokenStore implements ClaudeTokenStore {
  constructor(readonly directory: string) {}

  #file(profileId: string): string {
    return path.join(this.directory, "secrets", `${profileId}.json`);
  }

  async read(profileId: string): Promise<ClaudeOAuthTokens | null> {
    try {
      return parseTokens(await readFile(this.#file(profileId), "utf8"));
    } catch {
      return null;
    }
  }

  async write(profileId: string, tokens: ClaudeOAuthTokens): Promise<void> {
    await writePrivateFile(this.#file(profileId), JSON.stringify(tokens));
  }

  async delete(profileId: string): Promise<void> {
    await rm(this.#file(profileId), { force: true });
  }
}

export function createClaudeTokenStore(directory: string): ClaudeTokenStore {
  return new FileTokenStore(directory);
}
