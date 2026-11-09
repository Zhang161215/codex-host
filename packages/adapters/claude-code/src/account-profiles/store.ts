import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClaudeOAuthTokens, ClaudeUsageWindow } from "./oauth.js";

/**
 * Saved Claude sign-ins. Metadata lives in `<codexhost data>/claude-accounts/profiles.json`;
 * tokens live in the macOS Keychain on macOS and in owner-only files elsewhere, matching how
 * Claude Code itself stores its own login on each platform.
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
  autoSwitch: { enabled: boolean; thresholdPercent: number };
  profiles: StoredClaudeProfile[];
  lastSwitch: StoredClaudeSwitch | null;
}

export const DEFAULT_AUTO_SWITCH = Object.freeze({ enabled: true, thresholdPercent: 95 });

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

async function writePrivateFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
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
    if (
      isRecord(value) &&
      typeof value.accessToken === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.expiresAt === "number"
    ) {
      return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
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

const KEYCHAIN_SERVICE = "codexhost Claude account";
/** `security -i` reads one command line from stdin; longer payloads fall back to argv. */
const SECURITY_STDIN_LIMIT = 4_000;

function runSecurity(
  args: readonly string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    if (input === undefined) {
      execFile("/usr/bin/security", args, { timeout: 10_000 }, (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout) });
      });
      return;
    }
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: "" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: "" });
    });
    child.stdin.end(input);
  });
}

class KeychainTokenStore implements ClaudeTokenStore {
  async read(profileId: string): Promise<ClaudeOAuthTokens | null> {
    const { code, stdout } = await runSecurity([
      "find-generic-password",
      "-a",
      profileId,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    return code === 0 ? parseTokens(stdout.trim()) : null;
  }

  async write(profileId: string, tokens: ClaudeOAuthTokens): Promise<void> {
    const hex = Buffer.from(JSON.stringify(tokens), "utf8").toString("hex");
    const command = `add-generic-password -U -a "${profileId}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
    const result =
      command.length <= SECURITY_STDIN_LIMIT
        ? await runSecurity(["-i"], command)
        : await runSecurity([
            "add-generic-password",
            "-U",
            "-a",
            profileId,
            "-s",
            KEYCHAIN_SERVICE,
            "-X",
            hex,
          ]);
    // `security -i` can exit 0 after a failed command; the read-back is the real confirmation.
    const saved = result.code === 0 ? await this.read(profileId) : null;
    if (saved?.accessToken !== tokens.accessToken || saved.refreshToken !== tokens.refreshToken) {
      throw new Error("Could not save the Claude sign-in to the Keychain");
    }
  }

  async delete(profileId: string): Promise<void> {
    await runSecurity(["delete-generic-password", "-a", profileId, "-s", KEYCHAIN_SERVICE]);
  }
}

export function createClaudeTokenStore(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeTokenStore {
  return platform === "darwin" ? new KeychainTokenStore() : new FileTokenStore(directory);
}
