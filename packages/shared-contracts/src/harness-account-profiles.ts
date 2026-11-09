import { z } from "zod";
import { harnessIdSchema } from "./ids.js";

/**
 * Saved sign-ins a Harness can run under, managed by the Harness Adapter. Unlike
 * {@link harnessAccountSnapshotSchema}, these are login records: the Adapter stores their
 * credentials and starts native sessions under the active one.
 */
export const HARNESS_ACCOUNT_PROFILES_METHOD = "codexhost/harness/account-profiles";

const profileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);
const loginIdSchema = profileIdSchema;
const isoDateSchema = z.string().datetime({ offset: true });

export const harnessAccountProfileWindowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    resetsAt: isoDateSchema.optional(),
  })
  .strict();
export type HarnessAccountProfileWindow = z.infer<typeof harnessAccountProfileWindowSchema>;

export const harnessAccountProfileSchema = z
  .object({
    profileId: profileIdSchema,
    label: z.string().trim().min(1).max(256),
    email: z.string().trim().min(1).max(320).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    active: z.boolean(),
    /** `expired`: the saved sign-in was rejected and must be added again. */
    status: z.enum(["ready", "expired", "error"]),
    fiveHour: harnessAccountProfileWindowSchema.optional(),
    sevenDay: harnessAccountProfileWindowSchema.optional(),
    usageObservedAt: isoDateSchema.optional(),
    /** When the saved sign-in stops working; absent when the Harness does not report it. */
    expiresAt: isoDateSchema.optional(),
    error: z.string().max(512).optional(),
  })
  .strict();
export type HarnessAccountProfile = z.infer<typeof harnessAccountProfileSchema>;

export const harnessAccountAutoSwitchSchema = z
  .object({
    enabled: z.boolean(),
    /** Switch away once the 5-hour or 7-day window of the active profile reaches this. */
    thresholdPercent: z.number().int().min(50).max(100),
    /**
     * When Claude refuses a reply because the account hit its limit and the switch found another
     * account, the Thread continues the interrupted work under it.
     */
    continueAfterLimit: z.boolean(),
  })
  .strict();
export type HarnessAccountAutoSwitch = z.infer<typeof harnessAccountAutoSwitchSchema>;

export const harnessAccountLoginSchema = z
  .object({
    loginId: loginIdSchema,
    authorizeUrl: z.string().url().max(4_096),
    /** Same sign-in for any browser or device: the page shows a code to paste back. */
    manualAuthorizeUrl: z.string().url().max(4_096).optional(),
    /** `callback` completes on its own; `manual` waits for the pasted authorization code. */
    mode: z.enum(["callback", "manual"]),
    status: z.enum(["pending", "completed", "failed"]),
    profileId: profileIdSchema.optional(),
    error: z.string().max(512).optional(),
  })
  .strict();
export type HarnessAccountLogin = z.infer<typeof harnessAccountLoginSchema>;

export const harnessAccountSwitchSchema = z
  .object({
    at: isoDateSchema,
    fromProfileId: profileIdSchema.nullable(),
    toProfileId: profileIdSchema.nullable(),
    reason: z.enum(["manual", "auto"]),
  })
  .strict();
export type HarnessAccountSwitch = z.infer<typeof harnessAccountSwitchSchema>;

/** The sign-in the Harness itself holds on this computer, read without changing it. */
export const harnessAccountNativeSchema = z
  .object({
    email: z.string().trim().min(1).max(320).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    fiveHour: harnessAccountProfileWindowSchema.optional(),
    sevenDay: harnessAccountProfileWindowSchema.optional(),
    usageObservedAt: isoDateSchema.optional(),
    /** A saved profile signed in to the same account. */
    savedProfileId: profileIdSchema.optional(),
  })
  .strict();
export type HarnessAccountNative = z.infer<typeof harnessAccountNativeSchema>;

/**
 * Where the Harness's open Threads stand after a switch. A running native process keeps the
 * sign-in it started with, so it changes accounts at a Turn boundary rather than mid-Turn.
 */
export const harnessAccountThreadsSchema = z
  .object({
    /** Threads whose native process already runs under the active sign-in. */
    current: z.number().int().min(0),
    /** Idle Threads still under an earlier sign-in; their next message restarts them. */
    nextMessage: z.number().int().min(0),
    /** Threads running a Turn under an earlier sign-in; they change after that Turn. */
    afterTurn: z.number().int().min(0),
  })
  .strict();
export type HarnessAccountThreads = z.infer<typeof harnessAccountThreadsSchema>;

export const harnessAccountImportSummarySchema = z
  .object({
    added: z.number().int().min(0),
    /** Saved accounts whose expired sign-in the file replaced. */
    updated: z.number().int().min(0),
    /** Already saved and usable, or unusable copies of saved accounts; left unchanged. */
    skipped: z.number().int().min(0),
    /** Imported but already unusable; they must sign in again. */
    expired: z.number().int().min(0),
  })
  .strict();
export type HarnessAccountImportSummary = z.infer<typeof harnessAccountImportSummarySchema>;

export const harnessAccountProfilesStateSchema = z
  .object({
    harnessId: harnessIdSchema,
    profiles: z.array(harnessAccountProfileSchema).max(64),
    /** Null runs the Harness under its own native sign-in. */
    activeProfileId: profileIdSchema.nullable(),
    autoSwitch: harnessAccountAutoSwitchSchema,
    login: harnessAccountLoginSchema.nullable(),
    lastSwitch: harnessAccountSwitchSchema.nullable(),
    /** Null when no native sign-in was found; absent when the Harness cannot read it. */
    native: harnessAccountNativeSchema.nullable().optional(),
    /** Absent when the Harness does not report its open Threads. */
    threads: harnessAccountThreadsSchema.optional(),
    /** Present only in the reply to an `import` request. */
    importSummary: harnessAccountImportSummarySchema.optional(),
  })
  .strict();
export type HarnessAccountProfilesState = z.infer<typeof harnessAccountProfilesStateSchema>;

const target = { harnessId: harnessIdSchema };
export const harnessAccountProfilesParamsSchema = z.discriminatedUnion("action", [
  z.object({ ...target, action: z.literal("list"), refreshUsage: z.boolean().optional() }).strict(),
  z
    .object({
      ...target,
      action: z.literal("login.start"),
      mode: z.enum(["callback", "manual"]).optional(),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal("login.complete"),
      loginId: loginIdSchema,
      code: z.string().trim().min(1).max(4_096),
    })
    .strict(),
  z.object({ ...target, action: z.literal("login.cancel"), loginId: loginIdSchema }).strict(),
  /** Saves the accounts found in an exported file; the Adapter recognizes the formats. */
  z
    .object({
      ...target,
      action: z.literal("import"),
      content: z.string().min(2).max(3_000_000),
    })
    .strict(),
  /** Saves a long-lived token created elsewhere, such as by `claude setup-token`. */
  z
    .object({
      ...target,
      action: z.literal("token.add"),
      token: z.string().trim().min(20).max(4_096),
    })
    .strict(),
  z
    .object({ ...target, action: z.literal("activate"), profileId: profileIdSchema.nullable() })
    .strict(),
  z.object({ ...target, action: z.literal("remove"), profileId: profileIdSchema }).strict(),
  z
    .object({
      ...target,
      action: z.literal("rename"),
      profileId: profileIdSchema,
      label: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal("autoSwitch.set"),
      autoSwitch: harnessAccountAutoSwitchSchema,
    })
    .strict(),
]);
export type HarnessAccountProfilesParams = z.infer<typeof harnessAccountProfilesParamsSchema>;
/** The request an Adapter receives; Host has already routed it by `harnessId`. */
export type HarnessAccountProfilesRequest = HarnessAccountProfilesParams extends infer P
  ? P extends { harnessId: unknown }
    ? Omit<P, "harnessId">
    : never
  : never;
