import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeAccountProfiles } from "../src/account-profiles/manager.js";
import { parsePastedAuthorization } from "../src/account-profiles/login.js";
import { CLAUDE_OAUTH, type ClaudeOAuthTokens } from "../src/account-profiles/oauth.js";
import { createClaudeTokenStore, type ClaudeTokenStore } from "../src/account-profiles/store.js";

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function memoryTokens(): ClaudeTokenStore & { values: Map<string, ClaudeOAuthTokens> } {
  const values = new Map<string, ClaudeOAuthTokens>();
  return {
    values,
    read: async (id) => values.get(id) ?? null,
    write: async (id, tokens) => {
      values.set(id, tokens);
    },
    delete: async (id) => {
      values.delete(id);
    },
  };
}

interface FakeAccount {
  uuid: string;
  email: string;
  fiveHour: number;
  sevenDay: number;
}

/**
 * Anthropic endpoints keyed by access token. A sign-in asking for a custom lifetime gets a
 * long-lived token without a refresh token, as `claude setup-token` does; refreshable pairs come
 * from `issueRefreshable`. Inference-only tokens cannot read the profile or usage.
 */
function fakeAnthropic(accounts: Record<string, FakeAccount>) {
  const byAccess = new Map<string, FakeAccount>();
  const byRefresh = new Map<string, FakeAccount>();
  const inferenceOnly = new Set<string>();
  const exchanges: Array<Record<string, unknown>> = [];
  let issued = 0;
  const issue = (account: FakeAccount, lifetime?: number) => {
    issued += 1;
    const access = `access-${account.uuid}-${issued}`;
    byAccess.set(access, account);
    const identity = {
      account: { uuid: account.uuid, email_address: account.email },
      organization: { uuid: `org-${account.uuid}`, name: "Personal" },
    };
    if (lifetime !== undefined) {
      return {
        access_token: access,
        expires_in: lifetime,
        scope: "user:inference user:profile",
        ...identity,
      };
    }
    const refresh = `refresh-${account.uuid}-${issued}`;
    byRefresh.set(refresh, account);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 28_800,
      scope: "user:inference user:profile",
      ...identity,
    };
  };
  const revoked = new Set<string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === CLAUDE_OAUTH.tokenUrl) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.grant_type === "authorization_code") {
        exchanges.push(body);
        const account = accounts[String(body.code)];
        if (!account) return json({ error: "invalid_grant" }, 400);
        return json(
          issue(account, typeof body.expires_in === "number" ? body.expires_in : undefined),
        );
      }
      const refreshToken = String(body.refresh_token);
      const account = byRefresh.get(refreshToken);
      if (!account || revoked.has(account.uuid)) return json({ error: "invalid_grant" }, 400);
      byRefresh.delete(refreshToken);
      return json(issue(account));
    }
    const token = String((init?.headers as Record<string, string>).Authorization).slice(7);
    const account = byAccess.get(token);
    if (!account || revoked.has(account.uuid)) return json({ error: "unauthorized" }, 401);
    if (inferenceOnly.has(token)) return json({ error: "insufficient_scope" }, 403);
    if (url.endsWith("/api/oauth/profile")) {
      return json({
        account: { uuid: account.uuid, email: account.email, has_claude_max: true },
        organization: { uuid: `org-${account.uuid}`, organization_type: "claude_max" },
      });
    }
    return json({
      five_hour: { utilization: account.fiveHour, resets_at: "2026-11-09T12:00:00Z" },
      seven_day: { utilization: account.sevenDay, resets_at: "2026-11-12T12:00:00Z" },
    });
  });
  return {
    fetch,
    exchanges,
    revoke: (uuid: string) => revoked.add(uuid),
    /** A token as `claude setup-token` prints it: inference only, lifetime unknown to us. */
    setupToken(account: FakeAccount): string {
      const token = `sk-ant-oat01-${account.uuid}-${"x".repeat(24)}`;
      byAccess.set(token, account);
      inferenceOnly.add(token);
      return token;
    },
    issueRefreshable(account: FakeAccount, expiresAt: number): ClaudeOAuthTokens {
      const value: { access_token: string; refresh_token?: string } = issue(account);
      return {
        accessToken: value.access_token,
        refreshToken: defined(value.refresh_token),
        expiresAt,
        scopes: ["user:inference", "user:profile"],
      };
    },
  };
}

async function setup(accounts: Record<string, FakeAccount>, now = () => Date.now()) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-profiles-"));
  directories.push(directory);
  const tokens = memoryTokens();
  const anthropic = fakeAnthropic(accounts);
  const profiles = new ClaudeAccountProfiles({
    // Claude Code's own login is read from here, never from this machine's real one.
    environment: {
      CODEXHOST_DATA_DIR: directory,
      CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
    },
    platform: "linux",
    fetch: anthropic.fetch,
    tokenStore: tokens,
    now,
  });
  const signIn = async (code: string) => {
    const started = await profiles.handle({ action: "login.start", mode: "manual" });
    const login = defined(started.login);
    const state = new URL(login.authorizeUrl).searchParams.get("state");
    return profiles.handle({
      action: "login.complete",
      loginId: login.loginId,
      code: `${code}#${state}`,
    });
  };
  return { profiles, tokens, anthropic, signIn, directory };
}

/** Claude Code's own login as it keeps it on disk outside macOS. */
async function writeNativeLogin(
  directory: string,
  account: FakeAccount,
  tokens?: ClaudeOAuthTokens,
): Promise<void> {
  const claude = path.join(directory, "claude");
  await mkdir(claude, { recursive: true });
  await writeFile(
    path.join(claude, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: account.uuid,
        organizationUuid: `org-${account.uuid}`,
        emailAddress: account.email,
      },
    }),
  );
  if (tokens) {
    await writeFile(
      path.join(claude, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { ...tokens, subscriptionType: "max" } }),
    );
  }
}

function exportRecord(
  account: FakeAccount,
  tokens: ClaudeOAuthTokens,
  refreshTokenExpiresAt: number,
) {
  return {
    id: `claude_${account.uuid}`,
    email: account.email,
    auth_mode: "oauth",
    account_uuid: account.uuid,
    organization_uuid: `org-${account.uuid}`,
    plan_type: "Pro",
    quota: { five_hour_percentage: 0, seven_day_percentage: 45 },
    claude_credentials_raw: {
      claudeAiOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        refreshTokenExpiresAt,
        scopes: tokens.scopes,
        subscriptionType: "pro",
      },
    },
    claude_config_raw: {
      oauthAccount: { accountUuid: account.uuid, emailAddress: account.email },
    },
  };
}

const alice: FakeAccount = {
  uuid: "alice",
  email: "alice@example.com",
  fiveHour: 20,
  sevenDay: 30,
};
const bob: FakeAccount = { uuid: "bob", email: "bob@example.com", fiveHour: 5, sevenDay: 10 };
const carol: FakeAccount = {
  uuid: "carol",
  email: "carol@example.com",
  fiveHour: 99,
  sevenDay: 40,
};

describe("Claude account profiles", () => {
  it("saves a sign-in, makes the first one active and injects its token", async () => {
    const { profiles, anthropic, signIn } = await setup({ "code-a": alice, "code-b": bob });
    const first = await signIn("code-a");
    // A one-year token, as `claude setup-token` requests, with the scopes that allow it.
    expect(anthropic.exchanges[0]).toMatchObject({ expires_in: 31_536_000 });
    const scope = new URL(defined(first.login).authorizeUrl).searchParams.get("scope");
    expect(scope).toBe("user:inference user:profile");
    const yearAhead = Date.now() + 364 * 86_400_000;
    expect(Date.parse(defined(first.profiles[0]?.expiresAt))).toBeGreaterThan(yearAhead);
    expect(first.login?.status).toBe("completed");
    expect(first.activeProfileId).toBe(first.profiles[0]?.profileId);
    expect(first.profiles[0]).toMatchObject({
      label: "alice@example.com",
      plan: "max",
      active: true,
      status: "ready",
      fiveHour: { usedPercent: 20 },
      sevenDay: { usedPercent: 30 },
    });
    const second = await signIn("code-b");
    expect(second.profiles).toHaveLength(2);
    expect(second.activeProfileId).toBe(first.activeProfileId);

    const spawn = await profiles.spawnEnvironment();
    const environment = defined(spawn).apply({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-api",
      HOME: "/h",
    });
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^access-alice-/u);
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment.PATH).toBe("/bin");
  });

  it("signing in to the same account again updates it instead of adding a duplicate", async () => {
    const { signIn } = await setup({ "code-a": alice, "code-a2": alice });
    await signIn("code-a");
    const again = await signIn("code-a2");
    expect(again.profiles).toHaveLength(1);
  });

  it("switching changes the spawn key; the native login means no override", async () => {
    const { profiles, signIn } = await setup({ "code-a": alice, "code-b": bob });
    await signIn("code-a");
    const state = await signIn("code-b");
    const bobId = defined(state.profiles.find((item) => item.email === bob.email)).profileId;
    const before = await profiles.spawnEnvironment();
    await profiles.handle({ action: "activate", profileId: bobId });
    const after = await profiles.spawnEnvironment();
    expect(defined(after).key).not.toBe(defined(before).key);
    expect(defined(after).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^access-bob-/u);
    const native = await profiles.handle({ action: "activate", profileId: null });
    expect(native.lastSwitch).toMatchObject({ toProfileId: null, reason: "manual" });
    const own = defined(await profiles.spawnEnvironment());
    expect(own.key).toMatch(/^native:/u);
    expect(own.apply({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("never refreshes a long-lived token", async () => {
    const { profiles, anthropic, signIn } = await setup({ "code-a": alice });
    await signIn("code-a");
    await profiles.spawnEnvironment();
    await profiles.handle({ action: "list", refreshUsage: true });
    const grants = anthropic.fetch.mock.calls
      .filter(([url]) => url === CLAUDE_OAUTH.tokenUrl)
      .map(([, init]) => (JSON.parse(String(init?.body)) as { grant_type: string }).grant_type);
    expect(grants).toEqual(["authorization_code"]);
  });

  it("still refreshes a refreshable token close to expiry and saves the rotated pair", async () => {
    const clock = Date.now();
    const { profiles, tokens, anthropic, signIn } = await setup({ "code-a": alice }, () => clock);
    const state = await signIn("code-a");
    const id = defined(state.activeProfileId);
    const original = anthropic.issueRefreshable(alice, clock + 60_000);
    tokens.values.set(id, original);
    const spawn = await profiles.spawnEnvironment();
    const saved = defined(tokens.values.get(id));
    expect(saved.refreshToken).not.toBe(original.refreshToken);
    expect(defined(spawn).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toBe(saved.accessToken);
  });

  it("a long-lived token past its expiry is marked expired and the next account takes over", async () => {
    let clock = Date.now();
    const { profiles, tokens, signIn } = await setup(
      { "code-a": alice, "code-b": bob },
      () => clock,
    );
    await signIn("code-a");
    await signIn("code-b");
    const aliceId = defined((await profiles.state()).activeProfileId);
    clock = defined(defined(tokens.values.get(aliceId)).expiresAt) + 1;
    for (const [id, value] of tokens.values) {
      if (id !== aliceId) tokens.values.set(id, { ...value, expiresAt: clock + 86_400_000 });
    }
    const spawn = await profiles.spawnEnvironment();
    expect(defined(spawn).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^access-bob-/u);
    const state = await profiles.state();
    expect(state.profiles.find((item) => item.profileId === aliceId)?.status).toBe("expired");
    expect(state.lastSwitch).toMatchObject({ fromProfileId: aliceId, reason: "auto" });
  });

  it("a long-lived token Claude rejects is marked expired and the next account takes over", async () => {
    const { profiles, anthropic, signIn } = await setup({ "code-a": alice, "code-b": bob });
    await signIn("code-a");
    await signIn("code-b");
    const aliceId = defined((await profiles.state()).activeProfileId);
    anthropic.revoke("alice");
    await profiles.handle({ action: "list", refreshUsage: true });
    const spawn = await profiles.spawnEnvironment();
    expect(defined(spawn).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^access-bob-/u);
    const state = await profiles.state();
    expect(state.profiles.find((item) => item.profileId === aliceId)?.status).toBe("expired");
    expect(state.lastSwitch).toMatchObject({ fromProfileId: aliceId, reason: "auto" });
  });

  it("switches automatically at the threshold to the account with most quota left", async () => {
    const { profiles, signIn } = await setup({ "code-a": alice, "code-b": bob, "code-c": carol });
    await signIn("code-a");
    await signIn("code-b");
    const state = await signIn("code-c");
    const aliceId = defined(state.activeProfileId);
    const bobId = defined(state.profiles.find((item) => item.email === bob.email)).profileId;
    profiles.observePlanLimit({ fiveHour: { utilizationPercent: 90 } });
    await vi.waitFor(async () =>
      expect(
        (await profiles.state()).profiles.find((p) => p.profileId === aliceId)?.fiveHour,
      ).toMatchObject({ usedPercent: 90 }),
    );
    expect((await profiles.state()).activeProfileId).toBe(aliceId);

    profiles.observePlanLimit({ fiveHour: { utilizationPercent: 100 } });
    await vi.waitFor(async () => expect((await profiles.state()).activeProfileId).toBe(bobId));
    expect((await profiles.state()).lastSwitch).toMatchObject({
      fromProfileId: aliceId,
      toProfileId: bobId,
      reason: "auto",
    });
  });

  it("does not switch automatically when disabled", async () => {
    const { profiles, signIn } = await setup({ "code-a": alice, "code-b": bob });
    await signIn("code-a");
    const state = await signIn("code-b");
    await profiles.handle({
      action: "autoSwitch.set",
      autoSwitch: { enabled: false, thresholdPercent: 95 },
    });
    profiles.observePlanLimit({ sevenDay: { utilizationPercent: 100 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await profiles.state()).activeProfileId).toBe(state.activeProfileId);
  });

  it("removing the active account falls back to Claude Code's own login", async () => {
    const { profiles, tokens, signIn } = await setup({ "code-a": alice });
    const state = await signIn("code-a");
    const removed = await profiles.handle({
      action: "remove",
      profileId: defined(state.activeProfileId),
    });
    expect(removed.profiles).toHaveLength(0);
    expect(removed.activeProfileId).toBeNull();
    expect(tokens.values.size).toBe(0);
  });

  it("saves a pasted setup-token even though it cannot read the profile or usage", async () => {
    const { profiles, anthropic } = await setup({});
    const token = anthropic.setupToken(carol);
    const state = await profiles.handle({ action: "token.add", token: `  ${token}\n` });
    expect(state.profiles).toHaveLength(1);
    const [profile] = state.profiles;
    expect(profile).toMatchObject({ label: "Claude (…xxxx)", status: "ready", active: true });
    expect(profile).not.toHaveProperty("error");
    expect(profile).not.toHaveProperty("expiresAt");
    const spawn = await profiles.spawnEnvironment();
    expect(defined(spawn).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    await expect(
      profiles.handle({ action: "token.add", token: "not-a-claude-token-at-all" }),
    ).rejects.toThrow(/sk-ant-oat/u);
  });

  it("offers a copyable code-page link that completes the same sign-in", async () => {
    const { profiles, anthropic } = await setup({ "code-a": alice });
    const started = await profiles.handle({ action: "login.start", mode: "callback" });
    const login = defined(started.login);
    const loopback = new URL(login.authorizeUrl);
    const manual = new URL(defined(login.manualAuthorizeUrl));
    expect(loopback.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/localhost:\d+\/callback$/u,
    );
    expect(manual.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH.manualRedirectUrl);
    expect(manual.searchParams.get("state")).toBe(loopback.searchParams.get("state"));
    const done = await profiles.handle({
      action: "login.complete",
      loginId: login.loginId,
      code: `code-a#${manual.searchParams.get("state")}`,
    });
    expect(done.login?.status).toBe("completed");
    expect(anthropic.exchanges[0]).toMatchObject({ redirect_uri: CLAUDE_OAUTH.manualRedirectUrl });
  });

  it("imports an account manager export and leaves saved accounts alone", async () => {
    const clock = Date.now();
    const { profiles, anthropic } = await setup({}, () => clock);
    const live = anthropic.issueRefreshable(alice, clock + 3_600_000);
    const dead = anthropic.issueRefreshable(bob, clock - 60_000);
    const content = JSON.stringify([
      exportRecord(alice, live, clock + 20 * 86_400_000),
      exportRecord(bob, dead, clock - 86_400_000),
    ]);
    const first = await profiles.handle({ action: "import", content });
    expect(first.importSummary).toEqual({ added: 1, updated: 0, skipped: 0, expired: 1 });
    const imported = defined(first.profiles.find((item) => item.email === alice.email));
    expect(imported).toMatchObject({
      status: "ready",
      plan: "pro",
      active: true,
      fiveHour: { usedPercent: 20 },
    });
    // A refreshable sign-in lasts until its refresh token's fixed deadline.
    expect(Date.parse(defined(imported.expiresAt))).toBe(clock + 20 * 86_400_000);
    expect(first.profiles.find((item) => item.email === bob.email)?.status).toBe("expired");

    const again = await profiles.handle({ action: "import", content });
    expect(again.importSummary).toEqual({ added: 0, updated: 0, skipped: 2, expired: 0 });
    expect(again.profiles).toHaveLength(2);
  });

  it("imports Claude Code's credentials file and rejects files without accounts", async () => {
    const { profiles, anthropic } = await setup({});
    const tokens = anthropic.issueRefreshable(carol, Date.now() + 3_600_000);
    const state = await profiles.handle({
      action: "import",
      content: JSON.stringify({ claudeAiOauth: { ...tokens, subscriptionType: "max" } }),
    });
    expect(state.profiles[0]).toMatchObject({ label: carol.email, plan: "max", status: "ready" });
    await expect(profiles.handle({ action: "import", content: "not json" })).rejects.toThrow(
      /not JSON/u,
    );
    await expect(profiles.handle({ action: "import", content: '{"hello":1}' })).rejects.toThrow(
      /No Claude accounts/u,
    );
  });

  it("shows this computer's Claude Code login and its quota without refreshing it", async () => {
    const { profiles, anthropic, directory, signIn } = await setup({ "code-c": carol });
    await writeNativeLogin(
      directory,
      carol,
      anthropic.issueRefreshable(carol, Date.now() + 3_600_000),
    );
    const listed = await profiles.handle({ action: "list", refreshUsage: true });
    expect(listed.native).toMatchObject({
      email: carol.email,
      plan: "max",
      fiveHour: { usedPercent: 99 },
    });
    expect(listed.native).not.toHaveProperty("savedProfileId");
    const saved = await signIn("code-c");
    // Adding an account keeps Claude Code's own login in use.
    expect(saved.activeProfileId).toBeNull();
    expect(saved.native?.savedProfileId).toBe(saved.profiles[0]?.profileId);

    // An expired native token is read but never refreshed: Claude Code owns it.
    await writeNativeLogin(
      directory,
      carol,
      anthropic.issueRefreshable(carol, Date.now() - 60_000),
    );
    await profiles.handle({ action: "list", refreshUsage: true });
    const grants = anthropic.fetch.mock.calls
      .filter(([url]) => url === CLAUDE_OAUTH.tokenUrl)
      .map(([, init]) => (JSON.parse(String(init?.body)) as { grant_type: string }).grant_type);
    expect(grants).not.toContain("refresh_token");
  });

  it("restarts on a native account switch and can move from it to a saved account", async () => {
    const { profiles, directory, signIn } = await setup({ "code-b": bob });
    await writeNativeLogin(directory, alice);
    const state = await signIn("code-b");
    const bobId = defined(state.profiles[0]).profileId;
    expect(state.activeProfileId).toBeNull();
    const before = defined(await profiles.spawnEnvironment());
    expect(before.key).toContain("alice");
    expect(before.apply({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
    // Another tool switches Claude Code's own login.
    await writeNativeLogin(directory, carol);
    const after = defined(await profiles.spawnEnvironment());
    expect(after.key).not.toBe(before.key);

    profiles.observePlanLimit({ sevenDay: { utilizationPercent: 100 } });
    await vi.waitFor(async () => expect((await profiles.state()).activeProfileId).toBe(bobId));
    expect((await profiles.state()).native?.sevenDay).toMatchObject({ usedPercent: 100 });
  });

  it("rejects a pasted code from another sign-in", async () => {
    const { profiles } = await setup({ "code-a": alice });
    const started = await profiles.handle({ action: "login.start", mode: "manual" });
    await expect(
      profiles.handle({
        action: "login.complete",
        loginId: defined(started.login).loginId,
        code: "code-a#not-this-state",
      }),
    ).rejects.toThrow(/different sign-in/u);
  });
});

describe("parsePastedAuthorization", () => {
  it("accepts code#state, a bare code and redirect links", () => {
    expect(parsePastedAuthorization(" abc#xyz ")).toEqual({ code: "abc", state: "xyz" });
    expect(parsePastedAuthorization("abc")).toEqual({ code: "abc" });
    expect(parsePastedAuthorization("http://localhost:5555/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
      viaCallback: true,
    });
    expect(
      parsePastedAuthorization(
        "https://platform.claude.com/oauth/code/callback?code=abc&state=xyz",
      ),
    ).toEqual({ code: "abc", state: "xyz" });
  });
});

describe("Claude token file store", () => {
  it("round-trips long-lived and refreshable tokens on every platform", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claude-tokens-"));
    directories.push(directory);
    const store = createClaudeTokenStore(directory);
    await store.write("c1", { accessToken: "sk-ant-oat01-a", scopes: [] });
    await store.write("c2", {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 42,
      scopes: ["user:inference"],
    });
    expect(await store.read("c1")).toEqual({ accessToken: "sk-ant-oat01-a", scopes: [] });
    expect(await store.read("c2")).toMatchObject({ refreshToken: "refresh", expiresAt: 42 });
    await store.write("c1", { accessToken: "sk-ant-oat01-b", scopes: [] });
    expect((await store.read("c1"))?.accessToken).toBe("sk-ant-oat01-b");
    await store.delete("c1");
    expect(await store.read("c1")).toBeNull();
  });
});
