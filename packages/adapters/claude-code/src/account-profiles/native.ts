import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The sign-in Claude Code itself holds on this computer, read the way Claude Code 2.1.317 reads
 * it and never written or refreshed here: refreshing would rotate Claude Code's refresh token
 * and sign Claude Code out. Identity comes from the global config (`oauthAccount`), the token
 * from the macOS Keychain or `.credentials.json`. On Windows, Claude Code may keep the token in
 * Credential Manager instead; then only the identity is available.
 */
export interface ClaudeNativeIdentity {
  accountUuid?: string;
  organizationUuid?: string;
  email?: string;
  displayName?: string;
}

export interface ClaudeNativeCredentials {
  accessToken: string;
  expiresAt?: number;
  plan?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Claude Code's own directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
function claudeDirectory(environment: NodeJS.ProcessEnv): string {
  return (environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC");
}

function globalConfigFiles(environment: NodeJS.ProcessEnv): string[] {
  return [
    // Claude Code prefers a legacy config file when one exists.
    path.join(claudeDirectory(environment), ".config.json"),
    path.join(environment.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json"),
  ];
}

let identityCache: {
  file: string;
  mtimeMs: number;
  size: number;
  value: ClaudeNativeIdentity | null;
} | null = null;

/** The account Claude Code is signed in to, or null when it is not signed in to a Claude account. */
export async function readClaudeNativeIdentity(
  environment: NodeJS.ProcessEnv,
): Promise<ClaudeNativeIdentity | null> {
  for (const file of globalConfigFiles(environment)) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (
      identityCache?.file === file &&
      identityCache.mtimeMs === info.mtimeMs &&
      identityCache.size === info.size
    ) {
      return identityCache.value;
    }
    let value: ClaudeNativeIdentity | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      const account =
        isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : null;
      if (account) {
        value = {};
        const fields: Array<[keyof ClaudeNativeIdentity, string | undefined]> = [
          ["accountUuid", text(account.accountUuid)],
          ["organizationUuid", text(account.organizationUuid)],
          ["email", text(account.emailAddress)],
          ["displayName", text(account.displayName)],
        ];
        for (const [key, field] of fields) if (field) value[key] = field;
      }
    } catch {
      // A config being rewritten reads as no sign-in until the next look.
    }
    identityCache = { file, mtimeMs: info.mtimeMs, size: info.size, value };
    return value;
  }
  return null;
}

function keychainService(environment: NodeJS.ProcessEnv): string {
  const override = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const plain = override !== undefined ? !override : !environment.CLAUDE_CONFIG_DIR;
  const directory =
    override !== undefined ? override.normalize("NFC") : claudeDirectory(environment);
  const suffix = plain
    ? ""
    : `-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`;
  return `Claude Code-credentials${suffix}`;
}

function keychainAccount(environment: NodeJS.ProcessEnv): string {
  let user: string;
  try {
    user = environment.USER || os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/u.test(user) ? user : "claude-code-user";
}

function parseCredentials(raw: string): ClaudeNativeCredentials | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
    const accessToken = oauth ? text(oauth.accessToken) : undefined;
    if (!oauth || !accessToken) return null;
    const plan = text(oauth.subscriptionType)?.toLowerCase();
    return {
      accessToken,
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return null;
  }
}

function readKeychain(environment: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        keychainAccount(environment),
        "-w",
        "-s",
        keychainService(environment),
      ],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

/** Claude Code's current token, or null when it cannot be read on this platform. */
export async function readClaudeNativeCredentials(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeNativeCredentials | null> {
  if (platform === "darwin") {
    const raw = await readKeychain(environment);
    const parsed = raw ? parseCredentials(raw) : null;
    if (parsed) return parsed;
  }
  try {
    return parseCredentials(
      await readFile(path.join(claudeDirectory(environment), ".credentials.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
