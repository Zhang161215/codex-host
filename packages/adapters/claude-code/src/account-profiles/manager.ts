import { createHash, randomUUID } from "node:crypto";

import type { HarnessAccountProfilesCapability } from "@codexhost/harness-adapter";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type {
  HarnessAccountProfilesRequest,
  HarnessAccountProfilesState,
  HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

import { projectClaudeAccountUsage } from "../account-usage.js";
import type { ClaudePlanLimitEvent } from "../transport.js";
import { ClaudeLoginFlow, type ClaudeLoginResult } from "./login.js";
import {
  ClaudeOAuthError,
  fetchClaudeProfile,
  fetchClaudeUsage,
  parseClaudeAccessToken,
  refreshClaudeTokens,
  type ClaudeOAuthTokens,
  type ClaudeOAuthUsage,
  type FetchLike,
} from "./oauth.js";
import {
  claudeAccountsDirectory,
  ClaudeProfileMetadataStore,
  createClaudeTokenStore,
  type ClaudeTokenStore,
  type StoredClaudeProfile,
  type StoredClaudeProfiles,
} from "./store.js";

const CLAUDE_CODE_HARNESS_ID = harnessIdSchema.parse("claude-code");

/** Refresh a refreshable token this long before it expires, so a Turn never starts on a stale one. */
const REFRESH_MARGIN_MS = 30 * 60_000;
const USAGE_FRESH_MS = 60_000;
const AUTO_SWITCH_COOLDOWN_MS = 2 * 60_000;

/** Environment for one native Claude Code process; `key` changes whenever the sign-in does. */
export interface ClaudeProfileSpawnEnvironment {
  key: string;
  apply(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export interface ClaudeAccountProfilesOptions {
  environment: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  tokenStore?: ClaudeTokenStore;
  now?: () => number;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : fallback;
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function highestUse(profile: StoredClaudeProfile): number | null {
  const values = [profile.usage?.fiveHour?.usedPercent, profile.usage?.sevenDay?.usedPercent];
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length ? Math.max(...known) : null;
}

/**
 * Claude Code sign-ins owned by codexhost. The active profile's access token is injected into
 * every native process through `CLAUDE_CODE_OAUTH_TOKEN`, which leaves Claude Code's own login
 * (Keychain, Credential Manager or `.credentials.json`) untouched on every platform.
 */
export class ClaudeAccountProfiles implements HarnessAccountProfilesCapability {
  readonly #metadata: ClaudeProfileMetadataStore;
  readonly #tokens: ClaudeTokenStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #login: ClaudeLoginFlow;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #refreshFlights = new Map<string, Promise<ClaudeOAuthTokens>>();
  readonly #usageFlights = new Map<string, Promise<void>>();
  #autoSwitchAt = 0;
  #autoSwitching: Promise<boolean> | null = null;

  constructor(options: ClaudeAccountProfilesOptions) {
    const directory = claudeAccountsDirectory(options.environment);
    this.#metadata = new ClaudeProfileMetadataStore(directory);
    this.#tokens = options.tokenStore ?? createClaudeTokenStore(directory);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#login = new ClaudeLoginFlow(this.#fetch, (result) => this.#saveLogin(result));
  }

  /** Serializes read-modify-write of the metadata file within this Host. */
  #mutate<T>(change: (data: StoredClaudeProfiles) => T | Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const data = await this.#metadata.read();
      const result = await change(data);
      await this.#metadata.write(data);
      return result;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async handle(request: HarnessAccountProfilesRequest): Promise<HarnessAccountProfilesState> {
    switch (request.action) {
      case "list":
        await this.#refreshUsage(request.refreshUsage === true);
        break;
      case "login.start":
        await this.#login.start(request.mode ?? "callback");
        break;
      case "login.complete":
        await this.#login.complete(request.loginId, request.code);
        break;
      case "login.cancel":
        this.#login.cancel(request.loginId);
        break;
      case "token.add":
        await this.#addToken(request.token);
        break;
      case "activate":
        await this.#activate(request.profileId, "manual");
        break;
      case "remove":
        await this.#remove(request.profileId);
        break;
      case "rename":
        await this.#mutate((data) => {
          const profile = data.profiles.find((item) => item.profileId === request.profileId);
          if (!profile) throw new Error("This account no longer exists");
          profile.label = request.label;
        });
        break;
      case "autoSwitch.set":
        await this.#mutate((data) => {
          data.autoSwitch = { ...request.autoSwitch };
        });
        break;
    }
    return this.state();
  }

  async state(): Promise<HarnessAccountProfilesState> {
    const data = await this.#metadata.read();
    const expiries = new Map(
      await Promise.all(
        data.profiles.map(
          async (profile) =>
            [profile.profileId, (await this.#tokens.read(profile.profileId))?.expiresAt] as const,
        ),
      ),
    );
    return {
      harnessId: CLAUDE_CODE_HARNESS_ID,
      activeProfileId: data.activeProfileId,
      autoSwitch: data.autoSwitch,
      lastSwitch: data.lastSwitch,
      login: this.#login.snapshot(),
      profiles: data.profiles.map((profile) => ({
        profileId: profile.profileId,
        label: profile.label,
        ...(profile.email ? { email: profile.email } : {}),
        ...(profile.plan ? { plan: profile.plan } : {}),
        active: profile.profileId === data.activeProfileId,
        status: profile.status,
        ...(profile.usage?.fiveHour ? { fiveHour: profile.usage.fiveHour } : {}),
        ...(profile.usage?.sevenDay ? { sevenDay: profile.usage.sevenDay } : {}),
        ...(profile.usage ? { usageObservedAt: profile.usage.observedAt } : {}),
        ...(expiries.get(profile.profileId) !== undefined
          ? { expiresAt: new Date(expiries.get(profile.profileId) ?? 0).toISOString() }
          : {}),
        ...(profile.error ? { error: profile.error } : {}),
      })),
    };
  }

  /** Saves a token created elsewhere; its lifetime is unknown until Claude rejects it. */
  async #addToken(value: string): Promise<void> {
    const accessToken = parseClaudeAccessToken(value);
    // `claude setup-token` grants inference only, so the profile lookup may be refused.
    const profile = await fetchClaudeProfile(this.#fetch, accessToken).catch(() => ({}));
    await this.#saveLogin({ tokens: { accessToken, scopes: [] }, profile }, accessToken.slice(-4));
  }

  async #saveLogin(result: ClaudeLoginResult, tokenHint?: string): Promise<string> {
    const { tokens, profile } = result;
    const profileId = await this.#mutate(async (data) => {
      const existing = profile.accountUuid
        ? data.profiles.find(
            (item) =>
              item.accountUuid === profile.accountUuid &&
              item.organizationUuid === profile.organizationUuid,
          )
        : undefined;
      const id = existing?.profileId ?? `c${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await this.#tokens.write(id, tokens);
      if (existing) {
        existing.status = "ready";
        delete existing.error;
        if (profile.email) existing.email = profile.email;
        if (profile.plan) existing.plan = profile.plan;
      } else {
        data.profiles.push({
          profileId: id,
          label:
            profile.email ??
            profile.displayName ??
            (tokenHint ? `Claude (…${tokenHint})` : `Claude account ${data.profiles.length + 1}`),
          ...(profile.email ? { email: profile.email } : {}),
          ...(profile.plan ? { plan: profile.plan } : {}),
          ...(profile.accountUuid ? { accountUuid: profile.accountUuid } : {}),
          ...(profile.organizationUuid ? { organizationUuid: profile.organizationUuid } : {}),
          addedAt: new Date(this.#now()).toISOString(),
          status: "ready",
        });
      }
      if (data.activeProfileId === null) {
        data.lastSwitch = this.#switchRecord(null, id, "manual");
        data.activeProfileId = id;
      }
      return id;
    });
    await this.#refreshProfileUsage(profileId, true).catch(() => undefined);
    return profileId;
  }

  #switchRecord(from: string | null, to: string | null, reason: "manual" | "auto") {
    return {
      at: new Date(this.#now()).toISOString(),
      fromProfileId: from,
      toProfileId: to,
      reason,
    };
  }

  async #activate(profileId: string | null, reason: "manual" | "auto"): Promise<void> {
    await this.#mutate((data) => {
      if (profileId !== null) {
        const profile = data.profiles.find((item) => item.profileId === profileId);
        if (!profile) throw new Error("This account no longer exists");
        if (profile.status === "expired") throw new Error("Sign in to this account again first");
      }
      if (data.activeProfileId === profileId) return;
      data.lastSwitch = this.#switchRecord(data.activeProfileId, profileId, reason);
      data.activeProfileId = profileId;
    });
  }

  async #remove(profileId: string): Promise<void> {
    await this.#mutate(async (data) => {
      data.profiles = data.profiles.filter((item) => item.profileId !== profileId);
      if (data.activeProfileId === profileId) {
        data.lastSwitch = this.#switchRecord(profileId, null, "manual");
        data.activeProfileId = null;
      }
      await this.#tokens.delete(profileId);
    });
  }

  async #markExpired(profileId: string, error: string): Promise<void> {
    await this.#mutate((data) => {
      const profile = data.profiles.find((item) => item.profileId === profileId);
      if (!profile) return;
      profile.status = "expired";
      profile.error = error;
    }).catch(() => undefined);
  }

  /** A usable access token, refreshed once per profile at a time and saved before use. */
  async #tokensFor(profileId: string, force = false): Promise<ClaudeOAuthTokens> {
    const stored = await this.#tokens.read(profileId);
    if (!stored) {
      await this.#markExpired(profileId, "The saved sign-in is missing");
      throw new Error("The saved sign-in is missing; sign in to this account again");
    }
    const remaining = stored.expiresAt === undefined ? Infinity : stored.expiresAt - this.#now();
    if (!force && remaining > REFRESH_MARGIN_MS) return stored;
    if (!stored.refreshToken) {
      // Long-lived tokens are used as they are until they expire or Claude rejects them.
      if (!force && remaining > 0) return stored;
      await this.#markExpired(profileId, "Sign-in expired or was revoked");
      throw new Error("This Claude account's sign-in expired; sign in to it again");
    }
    const running = this.#refreshFlights.get(profileId);
    if (running) return running;
    const flight = (async () => {
      try {
        const refreshed = await refreshClaudeTokens(this.#fetch, stored);
        await this.#tokens.write(profileId, refreshed);
        return refreshed;
      } catch (error) {
        if (error instanceof ClaudeOAuthError && error.revoked) {
          await this.#markExpired(profileId, "Sign-in expired or was revoked");
          throw new Error("This Claude account's sign-in expired; sign in to it again");
        }
        throw error;
      }
    })().finally(() => this.#refreshFlights.delete(profileId));
    this.#refreshFlights.set(profileId, flight);
    return flight;
  }

  #refreshProfileUsage(profileId: string, force: boolean): Promise<void> {
    const running = this.#usageFlights.get(profileId);
    if (running) return running;
    const flight = (async () => {
      const data = await this.#metadata.read();
      const profile = data.profiles.find((item) => item.profileId === profileId);
      if (!profile || profile.status === "expired") return;
      const observed = profile.usage ? Date.parse(profile.usage.observedAt) : 0;
      if (!force && this.#now() - observed < USAGE_FRESH_MS) return;
      let usage: ClaudeOAuthUsage | undefined;
      let failure: string | undefined;
      try {
        let tokens = await this.#tokensFor(profileId);
        try {
          usage = await fetchClaudeUsage(this.#fetch, tokens.accessToken);
        } catch (error) {
          if (!(error instanceof ClaudeOAuthError) || error.status !== 401) throw error;
          tokens = await this.#tokensFor(profileId, true);
          usage = await fetchClaudeUsage(this.#fetch, tokens.accessToken);
        }
      } catch (error) {
        // A token without the profile scope (`claude setup-token`) cannot read usage; its quota
        // still arrives from the native sessions that run under it.
        if (!(error instanceof ClaudeOAuthError && error.status === 403)) {
          failure = message(error, "Usage lookup failed");
        }
      }
      await this.#mutate((next) => {
        const target = next.profiles.find((item) => item.profileId === profileId);
        if (!target) return;
        if (usage) {
          target.usage = { ...usage, observedAt: new Date(this.#now()).toISOString() };
          if (target.status === "error") target.status = "ready";
          delete target.error;
        } else if (failure && target.status !== "expired") {
          target.error = failure;
        }
      });
    })().finally(() => this.#usageFlights.delete(profileId));
    this.#usageFlights.set(profileId, flight);
    return flight;
  }

  async #refreshUsage(force: boolean): Promise<void> {
    const data = await this.#metadata.read();
    await Promise.all(
      data.profiles.map((profile) =>
        this.#refreshProfileUsage(profile.profileId, force).catch(() => undefined),
      ),
    );
  }

  /**
   * The sign-in a new native process must run under, or null for Claude Code's own login.
   * Throws a displayable error when the active profile cannot sign in and no other can take over.
   */
  async spawnEnvironment(): Promise<ClaudeProfileSpawnEnvironment | null> {
    const data = await this.#metadata.read();
    const profileId = data.activeProfileId;
    if (profileId === null) return null;
    let tokens: ClaudeOAuthTokens;
    try {
      // A long-lived token Claude has rejected stays rejected until its account signs in again.
      const profile = data.profiles.find((item) => item.profileId === profileId);
      if (profile?.status === "expired") {
        throw new Error("This Claude account's sign-in expired; sign in to it again");
      }
      tokens = await this.#tokensFor(profileId);
    } catch (error) {
      if (data.autoSwitch.enabled && (await this.#switchAway(profileId))) {
        return this.spawnEnvironment();
      }
      throw error;
    }
    const accessToken = tokens.accessToken;
    return {
      key: `${profileId}:${fingerprint(accessToken)}`,
      apply(environment) {
        const next: NodeJS.ProcessEnv = { ...environment, CLAUDE_CODE_OAUTH_TOKEN: accessToken };
        // A process-level API key would take precedence over the subscription sign-in.
        delete next.ANTHROPIC_API_KEY;
        delete next.ANTHROPIC_AUTH_TOKEN;
        return next;
      },
    };
  }

  /** Account telemetry for the active profile, or undefined when Claude Code's own login is used. */
  async activeAccountSnapshot(): Promise<HarnessAccountSnapshot | null | undefined> {
    const data = await this.#metadata.read();
    if (data.activeProfileId === null) return undefined;
    await this.#refreshProfileUsage(data.activeProfileId, false).catch(() => undefined);
    const profile = (await this.#metadata.read()).profiles.find(
      (item) => item.profileId === data.activeProfileId,
    );
    if (!profile?.usage) return null;
    const window = (value: { usedPercent: number; resetsAt?: string } | undefined) =>
      value ? { utilization: value.usedPercent, resets_at: value.resetsAt ?? null } : null;
    return projectClaudeAccountUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: window(profile.usage.fiveHour),
          seven_day: window(profile.usage.sevenDay),
        },
        ...(profile.plan ? { subscription_type: profile.plan } : {}),
      } as Parameters<typeof projectClaudeAccountUsage>[0],
      { ...(profile.email ? { email: profile.email } : {}) },
    );
  }

  /** Live quota pushed by a native session of the active profile; may switch accounts. */
  observePlanLimit(planLimit: ClaudePlanLimitEvent): void {
    void this.#observePlanLimit(planLimit).catch(() => undefined);
  }

  async #observePlanLimit(planLimit: ClaudePlanLimitEvent): Promise<void> {
    const data = await this.#metadata.read();
    const activeId = data.activeProfileId;
    if (activeId === null) return;
    const toWindow = (value: ClaudePlanLimitEvent["fiveHour"]) =>
      value
        ? {
            usedPercent: value.utilizationPercent,
            ...(value.resetsAtUnix !== undefined
              ? { resetsAt: new Date(value.resetsAtUnix * 1000).toISOString() }
              : {}),
          }
        : undefined;
    const fiveHour = toWindow(planLimit.fiveHour);
    const sevenDay = toWindow(planLimit.sevenDay);
    await this.#mutate((next) => {
      const profile = next.profiles.find((item) => item.profileId === activeId);
      if (!profile || next.activeProfileId !== activeId) return;
      profile.usage = {
        ...profile.usage,
        ...(fiveHour ? { fiveHour } : {}),
        ...(sevenDay ? { sevenDay } : {}),
        observedAt: new Date(this.#now()).toISOString(),
      };
    });
    const used = Math.max(fiveHour?.usedPercent ?? 0, sevenDay?.usedPercent ?? 0);
    if (!data.autoSwitch.enabled || used < data.autoSwitch.thresholdPercent) return;
    if (this.#now() - this.#autoSwitchAt < AUTO_SWITCH_COOLDOWN_MS) return;
    await this.#switchAway(activeId);
  }

  /** Moves the active profile to the ready account with the most quota left. */
  #switchAway(fromProfileId: string): Promise<boolean> {
    if (this.#autoSwitching) return this.#autoSwitching;
    const run = (async (): Promise<boolean> => {
      const data = await this.#metadata.read();
      const candidates = data.profiles.filter(
        (item) => item.profileId !== fromProfileId && item.status !== "expired",
      );
      await Promise.all(
        candidates.map((item) =>
          this.#refreshProfileUsage(item.profileId, false).catch(() => undefined),
        ),
      );
      const fresh = await this.#metadata.read();
      if (fresh.activeProfileId !== fromProfileId) return fresh.activeProfileId !== null;
      const ranked = fresh.profiles
        .filter((item) => item.profileId !== fromProfileId && item.status === "ready")
        .map((item) => ({ item, used: highestUse(item) }))
        .filter(({ used }) => used === null || used < fresh.autoSwitch.thresholdPercent)
        .sort((left, right) => (left.used ?? 50) - (right.used ?? 50));
      const target = ranked[0]?.item;
      if (!target) return false;
      this.#autoSwitchAt = this.#now();
      await this.#activate(target.profileId, "auto");
      return true;
    })().finally(() => {
      this.#autoSwitching = null;
    });
    this.#autoSwitching = run;
    return run;
  }

  close(): void {
    this.#login.close();
  }
}
