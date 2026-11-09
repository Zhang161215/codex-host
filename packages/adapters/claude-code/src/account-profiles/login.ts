import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { HarnessAccountLogin } from "@codexhost/shared-contracts";

import {
  claudeAuthorizeUrl,
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
  servers: http.Server[];
  timer: ReturnType<typeof setTimeout>;
  status: "pending" | "completed" | "failed";
  finishing: Promise<void> | null;
  profileId?: string;
  error?: string;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:48px"><h2>${title}</h2><p>${body}</p></body>`;
}

/** Reads `code` and `state` from a pasted value: `code#state`, a bare code, or the redirect URL. */
export function parsePastedAuthorization(value: string): { code: string; state?: string } {
  const trimmed = value.trim();
  if (/^https?:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("The pasted link does not contain an authorization code");
    const state = url.searchParams.get("state");
    return { code, ...(state ? { state } : {}) };
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
  ) {}

  snapshot(): HarnessAccountLogin | null {
    const login = this.#login;
    if (!login) return null;
    return {
      loginId: login.loginId,
      authorizeUrl: login.authorizeUrl,
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
    const timer = setTimeout(
      () => this.#fail(loginId, "Sign-in timed out; start it again"),
      LOGIN_TIMEOUT_MS,
    );
    timer.unref?.();
    this.#login = {
      loginId,
      mode,
      pkce,
      port,
      authorizeUrl: claudeAuthorizeUrl(pkce, port),
      servers,
      timer,
      status: "pending",
      finishing: null,
    };
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
      if (!code || state !== login.pkce.state) {
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Sign-in failed", "The authorization response was not recognized."));
        return;
      }
      void this.#finish(login, code).then(() => {
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
    const { code, state } = parsePastedAuthorization(pasted);
    if (state !== undefined && state !== login.pkce.state) {
      throw new Error("The pasted code belongs to a different sign-in");
    }
    await this.#finish(login, code);
    // `#finish` settles the login; read it back through the snapshot to drop the narrowing.
    if (this.snapshot()?.status === "failed") throw new Error(login.error ?? "Sign-in failed");
  }

  #finish(login: PendingLogin, code: string): Promise<void> {
    if (login.finishing) return login.finishing;
    login.finishing = (async () => {
      try {
        const { tokens, identity } = await exchangeClaudeCode(this.fetchImpl, {
          code,
          pkce: login.pkce,
          port: login.port,
        });
        // The profile adds the plan; the identity from the token response is enough without it.
        const profile = await fetchClaudeProfile(this.fetchImpl, tokens.accessToken).catch(
          () => ({}),
        );
        login.profileId = await this.save({ tokens, profile: { ...identity, ...profile } });
        login.status = "completed";
      } catch (error) {
        login.status = "failed";
        login.error = error instanceof Error ? error.message.slice(0, 500) : "Sign-in failed";
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
    this.#stop(login);
    this.#login = null;
  }

  close(): void {
    if (this.#login) this.#stop(this.#login);
    this.#login = null;
  }
}
