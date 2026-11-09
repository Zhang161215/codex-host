import { createHash, randomBytes } from "node:crypto";

/**
 * Claude.ai subscription OAuth, as Claude Code performs it for `claude setup-token` (verified
 * against Claude Code 2.1.317): the token exchange asks for a one-year access token, so a saved
 * sign-in needs no refresh. The token endpoint only honours a custom `expires_in` for some scopes
 * (`user:mcp_servers`, for one, is rejected), hence the reduced scope set. `user:profile` keeps the
 * profile and usage endpoints available; Claude Code itself treats a token passed through
 * `CLAUDE_CODE_OAUTH_TOKEN` as inference-only either way.
 */
export const CLAUDE_OAUTH = Object.freeze({
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  manualRedirectUrl: "https://platform.claude.com/oauth/code/callback",
  apiBaseUrl: "https://api.anthropic.com",
  scopes: ["user:inference", "user:profile"],
  /** One year, the lifetime `claude setup-token` requests. */
  tokenLifetimeSeconds: 31_536_000,
});

const REQUEST_TIMEOUT_MS = 20_000;

export interface ClaudeOAuthTokens {
  accessToken: string;
  /** Absent for long-lived tokens, which are used until they expire. */
  refreshToken?: string;
  /** Unix milliseconds; absent when unknown, as for a pasted token. */
  expiresAt?: number;
  /** Unix milliseconds. Refreshing never moves it; after it the account must sign in again. */
  refreshExpiresAt?: number;
  scopes: string[];
}

export interface ClaudeOAuthExchange {
  tokens: ClaudeOAuthTokens;
  /** Account identity the token endpoint returns alongside the tokens. */
  identity: ClaudeOAuthProfile;
}

export interface ClaudeOAuthProfile {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** Subscription plan, such as `pro` or `max`. */
  plan?: string;
}

export interface ClaudeUsageWindow {
  usedPercent: number;
  resetsAt?: string;
}

export interface ClaudeOAuthUsage {
  fiveHour?: ClaudeUsageWindow;
  sevenDay?: ClaudeUsageWindow;
}

/** An HTTP failure safe to show: no token or response body is included. */
export class ClaudeOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The grant itself was rejected; the profile must sign in again. */
    readonly revoked = false,
  ) {
    super(message);
    this.name = "ClaudeOAuthError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export interface ClaudePkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function createClaudePkce(): ClaudePkce {
  const verifier = base64Url(randomBytes(32));
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    state: base64Url(randomBytes(32)),
  };
}

export function claudeRedirectUri(port: number | null): string {
  return port === null ? CLAUDE_OAUTH.manualRedirectUrl : `http://localhost:${port}/callback`;
}

export function claudeAuthorizeUrl(pkce: ClaudePkce, port: number | null): string {
  const url = new URL(CLAUDE_OAUTH.authorizeUrl);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLAUDE_OAUTH.clientId);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", claudeRedirectUri(port));
  url.searchParams.append("scope", CLAUDE_OAUTH.scopes.join(" "));
  url.searchParams.append("code_challenge", pkce.challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", pkce.state);
  return url.toString();
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  action: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ClaudeOAuthError(`${action} failed: network error (check the proxy settings)`);
  }
  if (!response.ok) {
    const revoked =
      (response.status === 400 || response.status === 401) && url === CLAUDE_OAUTH.tokenUrl;
    throw new ClaudeOAuthError(
      `${action} failed (HTTP ${response.status})`,
      response.status,
      revoked,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ClaudeOAuthError(`${action} failed: unreadable response`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTokens(value: unknown, previous?: ClaudeOAuthTokens): ClaudeOAuthTokens {
  if (!isRecord(value)) throw new ClaudeOAuthError("Token response is malformed");
  const accessToken = text(value.access_token);
  const refreshToken = text(value.refresh_token) ?? previous?.refreshToken;
  const refreshExpiresIn = value.refresh_token_expires_in;
  const refreshExpiresAt =
    typeof refreshExpiresIn === "number" && refreshExpiresIn > 0
      ? Date.now() + refreshExpiresIn * 1000
      : previous?.refreshExpiresAt;
  const expiresIn = value.expires_in;
  if (!accessToken || typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new ClaudeOAuthError("Token response is malformed");
  }
  const scopes = (text(value.scope) ?? "").split(" ").filter(Boolean);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    ...(refreshToken && refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
    scopes,
  };
}

function identityFrom(value: unknown): ClaudeOAuthProfile {
  const account = isRecord(value) && isRecord(value.account) ? value.account : {};
  const organization = isRecord(value) && isRecord(value.organization) ? value.organization : {};
  const identity: ClaudeOAuthProfile = {};
  const fields: Array<[keyof ClaudeOAuthProfile, string | undefined]> = [
    ["accountUuid", text(account.uuid)],
    ["email", text(account.email_address) ?? text(account.email)],
    ["organizationUuid", text(organization.uuid)],
    ["organizationName", text(organization.name)],
  ];
  for (const [key, field] of fields) if (field) identity[key] = field;
  return identity;
}

/** A token pasted by the user, such as the output of `claude setup-token`. */
export function parseClaudeAccessToken(value: string): string {
  const token = value.trim();
  if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/u.test(token)) {
    throw new Error("This is not a Claude subscription token (it starts with sk-ant-oat)");
  }
  return token;
}

export async function exchangeClaudeCode(
  fetchImpl: FetchLike,
  input: { code: string; pkce: ClaudePkce; port: number | null },
): Promise<ClaudeOAuthExchange> {
  const value = await request(
    fetchImpl,
    CLAUDE_OAUTH.tokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: claudeRedirectUri(input.port),
        client_id: CLAUDE_OAUTH.clientId,
        code_verifier: input.pkce.verifier,
        state: input.pkce.state,
        expires_in: CLAUDE_OAUTH.tokenLifetimeSeconds,
      }),
    },
    "Sign-in",
  );
  return { tokens: parseTokens(value), identity: identityFrom(value) };
}

export async function refreshClaudeTokens(
  fetchImpl: FetchLike,
  tokens: ClaudeOAuthTokens,
): Promise<ClaudeOAuthTokens> {
  if (!tokens.refreshToken) throw new ClaudeOAuthError("This sign-in cannot be refreshed");
  const scopes = tokens.scopes.filter((scope) => scope !== "org:create_api_key");
  const value = await request(
    fetchImpl,
    CLAUDE_OAUTH.tokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CLAUDE_OAUTH.clientId,
        ...(scopes.length ? { scope: scopes.join(" ") } : {}),
      }),
    },
    "Token refresh",
  );
  const refreshed = parseTokens(value, tokens);
  return refreshed.scopes.length ? refreshed : { ...refreshed, scopes: tokens.scopes };
}

function bearer(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
  };
}

function planFrom(account: Record<string, unknown>, organization: Record<string, unknown>) {
  const type = text(organization.organization_type);
  if (type?.startsWith("claude_")) return type.slice("claude_".length);
  if (type) return type;
  if (account.has_claude_max === true) return "max";
  if (account.has_claude_pro === true) return "pro";
  return undefined;
}

export async function fetchClaudeProfile(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<ClaudeOAuthProfile> {
  const value = await request(
    fetchImpl,
    `${CLAUDE_OAUTH.apiBaseUrl}/api/oauth/profile`,
    { method: "GET", headers: bearer(accessToken) },
    "Profile lookup",
  );
  const account = isRecord(value) && isRecord(value.account) ? value.account : {};
  const organization = isRecord(value) && isRecord(value.organization) ? value.organization : {};
  const profile: ClaudeOAuthProfile = {};
  const fields: Array<[keyof ClaudeOAuthProfile, string | undefined]> = [
    ["accountUuid", text(account.uuid)],
    ["email", text(account.email)],
    ["displayName", text(account.display_name) ?? text(account.full_name)],
    ["organizationUuid", text(organization.uuid)],
    ["organizationName", text(organization.name)],
    ["plan", planFrom(account, organization)],
  ];
  for (const [key, field] of fields) if (field) profile[key] = field;
  return profile;
}

function usageWindow(value: unknown): ClaudeUsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const utilization = value.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  const resetsAt = text(value.resets_at);
  return {
    usedPercent: Math.min(100, Math.max(0, utilization)),
    ...(resetsAt && Number.isFinite(Date.parse(resetsAt))
      ? { resetsAt: new Date(resetsAt).toISOString() }
      : {}),
  };
}

export async function fetchClaudeUsage(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<ClaudeOAuthUsage> {
  const value = await request(
    fetchImpl,
    `${CLAUDE_OAUTH.apiBaseUrl}/api/oauth/usage`,
    { method: "GET", headers: bearer(accessToken) },
    "Usage lookup",
  );
  if (!isRecord(value)) return {};
  const fiveHour = usageWindow(value.five_hour);
  const sevenDay = usageWindow(value.seven_day);
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}
