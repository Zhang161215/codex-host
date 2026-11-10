import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { HarnessAccountLogin } from "@codexhost/shared-contracts";

import { writeClaudeAccountLog, type ClaudeAccountLog } from "./log.js";
import {
  claudeAuthorizeUrl,
  claudeTokenReadsProfile,
  createClaudePkce,
  exchangeClaudeCode,
  fetchClaudeProfile,
  type ClaudeOAuthProfile,
  type ClaudeOAuthTokens,
  type ClaudePkce,
  type FetchLike,
} from "./oauth.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";

export interface ClaudeLoginResult {
  tokens: ClaudeOAuthTokens;
  profile: ClaudeOAuthProfile;
}

interface PendingLogin {
  loginId: string;
  mode: "callback" | "manual";
  pkce: ClaudePkce;
  port: number | null;
  authorizeUrl: string;
  manualAuthorizeUrl: string;
  servers: http.Server[];
  timer: ReturnType<typeof setTimeout>;
  status: "pending" | "completed" | "failed";
  finishing: Promise<void> | null;
  /** Requests that reached the loopback callback, valid or not. */
  callbacks: number;
  profileId?: string;
  error?: string;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:48px"><h2>${title}</h2><p>${body}</p></body>`;
}

/**
 * Reads `code` and `state` from a pasted value: `code#state` from the code page, a bare code, or
 * a redirect link. `viaCallback` marks a loopback link, whose code belongs to that redirect.
 */
export function parsePastedAuthorization(value: string): {
  code: string;
  state?: string;
  viaCallback?: true;
} {
  const trimmed = value.trim();
  if (/^https?:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("The pasted link does not contain an authorization code");
    const state = url.searchParams.get("state");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return { code, ...(state ? { state } : {}), ...(loopback ? { viaCallback: true } : {}) };
  }
  const [code, state] = trimmed.split("#", 2);
  if (!code) throw new Error("Paste the authorization code shown after signing in");
  return { code, ...(state ? { state } : {}) };
}

/**
 * One Claude sign-in at a time. `callback` listens on a loopback port as Claude Code does;
 * `manual` uses Anthropic's code page, for a browser on another device.
 */
export class ClaudeLoginFlow {
  #login: PendingLogin | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly save: (result: ClaudeLoginResult) => Promise<string>,
    private readonly log: ClaudeAccountLog = writeClaudeAccountLog,
  ) {}

  snapshot(): HarnessAccountLogin | null {
    const login = this.#login;
    if (!login) return null;
    return {
      loginId: login.loginId,
      authorizeUrl: login.authorizeUrl,
      ...(login.manualAuthorizeUrl !== login.authorizeUrl
        ? { manualAuthorizeUrl: login.manualAuthorizeUrl }
        : {}),
      mode: login.mode,
      status: login.status,
      ...(login.profileId ? { profileId: login.profileId } : {}),
      ...(login.error ? { error: login.error } : {}),
    };
  }

  async start(mode: "callback" | "manual"): Promise<void> {
    this.close();
    const pkce = createClaudePkce();
    const loginId = randomUUID().replaceAll("-", "").slice(0, 16);
    const servers: http.Server[] = [];
    let port: number | null = null;
    if (mode === "callback") {
      const primary = this.#server(loginId);
      port = await new Promise<number>((resolve, reject) => {
        primary.once("error", reject);
        primary.listen(0, "127.0.0.1", () => resolve((primary.address() as AddressInfo).port));
      });
      servers.push(primary);
      // Browsers may resolve `localhost` to ::1 first; serve the same port there when possible.
      const secondary = this.#server(loginId);
      await new Promise<void>((resolve) => {
        secondary.once("error", () => resolve());
        secondary.listen(port ?? 0, "::1", () => {
          servers.push(secondary);
          resolve();
        });
      });
    }
    const timer = setTimeout(() => {
      if (this.#login?.loginId === loginId && this.#login.status === "pending") {
        this.log("login.timedOut", { loginId, callbacks: this.#login.callbacks });
      }
      this.#fail(loginId, "Sign-in timed out; start it again");
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    this.#login = {
      loginId,
      mode,
      pkce,
      port,
      authorizeUrl: claudeAuthorizeUrl(pkce, port),
      // The same PKCE pair also works through Anthropic's code page, as in Claude Code.
      manualAuthorizeUrl: claudeAuthorizeUrl(pkce, null),
      servers,
      timer,
      status: "pending",
      finishing: null,
      callbacks: 0,
    };
    this.log("login.started", {
      loginId,
      mode,
      port,
      loopbackIpv6: servers.length > 1,
    });
  }

  #server(loginId: string): http.Server {
    return http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const login = this.#login;
      if (url.pathname !== "/callback" || !login || login.loginId !== loginId) {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      login.callbacks += 1;
      if (!code || state !== login.pkce.state) {
        this.log("login.callbackRejected", {
          loginId,
          reason: !code
            ? (url.searchParams.get("error") ?? "no code").slice(0, 64)
            : "state mismatch",
        });
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Sign-in failed", "The authorization response was not recognized."));
        return;
      }
      void this.#finish(login, code, login.port).then(() => {
        if (login.status === "completed") {
          response.writeHead(302, { Location: SUCCESS_URL }).end();
        } else {
          response
            .writeHead(500, { "Content-Type": "text/html; charset=utf-8" })
            .end(page("Sign-in failed", login.error ?? "Return to codexhost and try again."));
        }
      });
    });
  }

  async complete(loginId: string, pasted: string): Promise<void> {
    const login = this.#login;
    if (!login || login.loginId !== loginId || login.status !== "pending") {
      throw new Error("This sign-in is no longer pending; start it again");
    }
    const { code, state, viaCallback } = parsePastedAuthorization(pasted);
    if (state !== undefined && state !== login.pkce.state) {
      throw new Error("The pasted code belongs to a different sign-in");
    }
    this.log("login.codePasted", { loginId, via: viaCallback ? "callback link" : "code page" });
    // A code from the code page was issued for its redirect; a pasted loopback link for ours.
    await this.#finish(login, code, viaCallback ? login.port : null);
    // `#finish` settles the login; read it back through the snapshot to drop the narrowing.
    if (this.snapshot()?.status === "failed") throw new Error(login.error ?? "Sign-in failed");
  }

  #finish(login: PendingLogin, code: string, port: number | null): Promise<void> {
    if (login.finishing) return login.finishing;
    login.finishing = (async () => {
      try {
        const { tokens, identity } = await exchangeClaudeCode(this.fetchImpl, {
          code,
          pkce: login.pkce,
          port,
        });
        // The profile adds the plan; the identity from the token response is enough without it,
        // and a one-year sign-in has no profile scope to read it with.
        const profile = claudeTokenReadsProfile(tokens)
          ? await fetchClaudeProfile(this.fetchImpl, tokens.accessToken).catch((error: unknown) => {
              this.log("login.profileUnavailable", {
                loginId: login.loginId,
                error: text(error),
              });
              return {};
            })
          : {};
        login.profileId = await this.save({ tokens, profile: { ...identity, ...profile } });
        login.status = "completed";
        this.log("login.completed", {
          loginId: login.loginId,
          profileId: login.profileId,
          // Seconds until the new access token expires; a one-year sign-in shows ~31536000.
          lifetimeSeconds:
            tokens.expiresAt !== undefined
              ? Math.round((tokens.expiresAt - Date.now()) / 1000)
              : null,
          refreshable: tokens.refreshToken !== undefined,
        });
      } catch (error) {
        login.status = "failed";
        login.error = error instanceof Error ? error.message.slice(0, 500) : "Sign-in failed";
        this.log("login.failed", { loginId: login.loginId, error: login.error });
      } finally {
        this.#stop(login);
      }
    })();
    return login.finishing;
  }

  #fail(loginId: string, error: string): void {
    const login = this.#login;
    if (!login || login.loginId !== loginId || login.status !== "pending") return;
    login.status = "failed";
    login.error = error;
    this.#stop(login);
  }

  #stop(login: PendingLogin): void {
    clearTimeout(login.timer);
    for (const server of login.servers) server.close();
    login.servers = [];
  }

  cancel(loginId: string): void {
    const login = this.#login;
    if (!login || login.loginId !== loginId) return;
    if (login.status === "pending") this.log("login.cancelled", { loginId });
    this.#stop(login);
    this.#login = null;
  }

  close(): void {
    if (this.#login) this.#stop(this.#login);
    this.#login = null;
  }
}
