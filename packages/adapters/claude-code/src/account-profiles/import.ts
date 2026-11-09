import type { ClaudeOAuthProfile, ClaudeOAuthTokens } from "./oauth.js";

/**
 * Claude sign-ins found in an exported file. Recognized records carry Claude Code's own
 * credential shape (`claudeAiOauth`), directly as in `.credentials.json` or nested as in account
 * manager exports (`claude_credentials_raw.claudeAiOauth`, with `email`, `account_uuid`,
 * `organization_uuid`, `plan_type` and `claude_config_raw.oauthAccount` beside it), or a bare
 * `{ accessToken: "sk-ant-oat…" }` object.
 */
export interface ClaudeImportedAccount {
  tokens: ClaudeOAuthTokens;
  profile: ClaudeOAuthProfile;
}

const MAX_DEPTH = 6;
const MAX_ACCOUNTS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function credentialsOf(record: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(record.claudeAiOauth)) return record.claudeAiOauth;
  const raw = record.claude_credentials_raw;
  if (isRecord(raw) && isRecord(raw.claudeAiOauth)) return raw.claudeAiOauth;
  return text(record.accessToken)?.startsWith("sk-ant-oat") ? record : null;
}

function accountOf(record: Record<string, unknown>): ClaudeImportedAccount | null {
  const credentials = credentialsOf(record);
  const accessToken = credentials ? text(credentials.accessToken) : undefined;
  if (!credentials || !accessToken) return null;
  const refreshToken = text(credentials.refreshToken);
  const expiresAt = finite(credentials.expiresAt);
  const refreshExpiresAt = finite(credentials.refreshTokenExpiresAt);
  const tokens: ClaudeOAuthTokens = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refreshToken && refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
    scopes: Array.isArray(credentials.scopes)
      ? credentials.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
  const config = isRecord(record.claude_config_raw) ? record.claude_config_raw : record;
  const account = isRecord(config.oauthAccount) ? config.oauthAccount : {};
  const profile: ClaudeOAuthProfile = {};
  const fields: Array<[keyof ClaudeOAuthProfile, string | undefined]> = [
    ["accountUuid", text(record.account_uuid) ?? text(account.accountUuid)],
    ["organizationUuid", text(record.organization_uuid) ?? text(account.organizationUuid)],
    ["email", text(record.email) ?? text(account.emailAddress)],
    ["displayName", text(account.displayName)],
    ["plan", (text(record.plan_type) ?? text(credentials.subscriptionType))?.toLowerCase()],
  ];
  for (const [key, field] of fields) if (field) profile[key] = field;
  return { tokens, profile };
}

export function parseClaudeAccountsExport(content: string): ClaudeImportedAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The file is not JSON; choose an exported accounts file");
  }
  const found: ClaudeImportedAccount[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_ACCOUNTS) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const account = accountOf(value);
    if (account) {
      found.push(account);
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(parsed, 0);
  if (found.length === 0) throw new Error("No Claude accounts were found in this file");
  return found;
}
