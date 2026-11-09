import type { HarnessAccountThreads } from "@codexhost/shared-contracts";

/** The sign-in an open Thread's native process runs under. */
export interface ClaudeThreadSignIn {
  /** Null for Claude Code's own login. */
  profileId: string | null;
  /** The sign-in key the process started with; for Claude Code's own login it names the account. */
  key: string;
  /** Whether the process can be replaced without interrupting work. */
  idle: boolean;
}

export type ClaudeThreadSource = () => Iterable<ClaudeThreadSignIn>;

export function nativeSignInKey(
  identity: { accountUuid?: string; organizationUuid?: string } | null,
): string {
  return `native:${identity?.accountUuid ?? ""}:${identity?.organizationUuid ?? ""}`;
}

/**
 * Counts Threads by whether they already run under the active sign-in. A saved profile counts as
 * current whatever its token: a renewed token alone does not change the account.
 */
export function summarizeClaudeThreads(
  threads: Iterable<ClaudeThreadSignIn>,
  active: { profileId: string | null; nativeKey: string },
): HarnessAccountThreads {
  const summary: HarnessAccountThreads = { current: 0, nextMessage: 0, afterTurn: 0 };
  for (const thread of threads) {
    const current =
      thread.profileId === active.profileId &&
      (thread.profileId !== null || thread.key === active.nativeKey);
    if (current) summary.current += 1;
    else if (thread.idle) summary.nextMessage += 1;
    else summary.afterTurn += 1;
  }
  return summary;
}
