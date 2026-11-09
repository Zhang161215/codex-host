import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeAccountProfiles } from "../src/account-profiles/manager.js";
import { parsePastedAuthorization } from "../src/account-profiles/login.js";
import { CLAUDE_OAUTH, type ClaudeOAuthTokens } from "../src/account-profiles/oauth.js";
import type { ClaudeTokenStore } from "../src/account-profiles/store.js";

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

/** Anthropic endpoints keyed by access token; refresh rotates both tokens. */
function fakeAnthropic(accounts: Record<string, FakeAccount>) {
  const byAccess = new Map<string, FakeAccount>();
  const byRefresh = new Map<string, FakeAccount>();
  let issued = 0;
  const issue = (account: FakeAccount) => {
    issued += 1;
    const access = `access-${account.uuid}-${issued}`;
    const refresh = `refresh-${account.uuid}-${issued}`;
    byAccess.set(access, account);
    byRefresh.set(refresh, account);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 28_800,
      scope: "user:inference user:profile",
    };
  };
  const revoked = new Set<string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === CLAUDE_OAUTH.tokenUrl) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.grant_type === "authorization_code") {
        const account = accounts[defined(body.code)];
        return account ? json(issue(account)) : json({ error: "invalid_grant" }, 400);
      }
      const account = byRefresh.get(defined(body.refresh_token));
      if (!account || revoked.has(account.uuid)) return json({ error: "invalid_grant" }, 400);
      byRefresh.delete(defined(body.refresh_token));
      return json(issue(account));
    }
    const token = String((init?.headers as Record<string, string>).Authorization).slice(7);
    const account = byAccess.get(token);
    if (!account) return json({ error: "unauthorized" }, 401);
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
  return { fetch, revoke: (uuid: string) => revoked.add(uuid) };
}

async function setup(accounts: Record<string, FakeAccount>, now = () => Date.now()) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-profiles-"));
  directories.push(directory);
  const tokens = memoryTokens();
  const anthropic = fakeAnthropic(accounts);
  const profiles = new ClaudeAccountProfiles({
    environment: { CODEXHOST_DATA_DIR: directory },
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
  return { profiles, tokens, anthropic, signIn };
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
    const { profiles, signIn } = await setup({ "code-a": alice, "code-b": bob });
    const first = await signIn("code-a");
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
    expect(await profiles.spawnEnvironment()).toBeNull();
  });

  it("refreshes a token close to expiry and saves the rotated pair", async () => {
    let clock = Date.now();
    const { profiles, tokens, signIn } = await setup({ "code-a": alice }, () => clock);
    const state = await signIn("code-a");
    const id = defined(state.activeProfileId);
    const original = defined(tokens.values.get(id));
    clock = original.expiresAt - 60_000;
    const spawn = await profiles.spawnEnvironment();
    const saved = defined(tokens.values.get(id));
    expect(saved.refreshToken).not.toBe(original.refreshToken);
    expect(defined(spawn).apply({}).CLAUDE_CODE_OAUTH_TOKEN).toBe(saved.accessToken);
  });

  it("marks a revoked sign-in expired and moves to the next account", async () => {
    let clock = Date.now();
    const { profiles, tokens, anthropic, signIn } = await setup(
      { "code-a": alice, "code-b": bob },
      () => clock,
    );
    await signIn("code-a");
    await signIn("code-b");
    const aliceId = defined((await profiles.state()).activeProfileId);
    clock = defined(tokens.values.get(aliceId)).expiresAt - 60_000;
    anthropic.revoke("alice");
    // Bob's token is still fresh relative to its own expiry window.
    for (const [id, value] of tokens.values) {
      if (id !== aliceId) tokens.values.set(id, { ...value, expiresAt: clock + 8 * 3_600_000 });
    }
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
  it("accepts code#state, a bare code and the redirect link", () => {
    expect(parsePastedAuthorization(" abc#xyz ")).toEqual({ code: "abc", state: "xyz" });
    expect(parsePastedAuthorization("abc")).toEqual({ code: "abc" });
    expect(parsePastedAuthorization("http://localhost:5555/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });
});
