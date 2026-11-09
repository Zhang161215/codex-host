/**
 * The environment a native Claude Code process runs under for a saved sign-in. The account is
 * chosen here, so nothing outside codexhost may route the process elsewhere: provider, endpoint
 * and credential variables inherited from the launch environment are removed, and
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` makes Claude Code (2.1.317) ignore the same variables,
 * `apiKeyHelper` and model routing when they come from settings files.
 */
export interface ClaudeSignInEnvironment {
  accessToken: string;
  /** The subscription type Claude reports for the account (`pro`, `max`, `team`, `enterprise`). */
  plan?: string;
  organizationUuid?: string;
}

const ROUTING_VARIABLES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USER_EMAIL",
]);

/** Third-party provider switches (`CLAUDE_CODE_USE_BEDROCK`, `..._VERTEX`, `..._FOUNDRY`, ...). */
const PROVIDER_SWITCH_PREFIX = "CLAUDE_CODE_USE_";

/** Values Claude Code accepts for `CLAUDE_CODE_SUBSCRIPTION_TYPE`. */
const SUBSCRIPTION_TYPES = new Set(["pro", "max", "team", "enterprise"]);

export function claudeSignInEnvironment(
  environment: NodeJS.ProcessEnv,
  signIn: ClaudeSignInEnvironment,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    const upper = name.toUpperCase();
    if (ROUTING_VARIABLES.has(upper) || upper.startsWith(PROVIDER_SWITCH_PREFIX)) continue;
    // Windows names are case-insensitive; a differently cased copy must not survive beside ours.
    if (upper === "CLAUDE_CODE_OAUTH_TOKEN" || upper === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") {
      continue;
    }
    next[name] = value;
  }
  next.CLAUDE_CODE_OAUTH_TOKEN = signIn.accessToken;
  next.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  // An environment token carries no profile; these let Claude Code apply the account's plan.
  const plan = signIn.plan?.toLowerCase();
  if (plan && SUBSCRIPTION_TYPES.has(plan)) next.CLAUDE_CODE_SUBSCRIPTION_TYPE = plan;
  if (signIn.organizationUuid) next.CLAUDE_CODE_ORGANIZATION_UUID = signIn.organizationUuid;
  return next;
}
