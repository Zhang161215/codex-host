import type {
  HarnessAccountProfile,
  HarnessAccountProfileWindow,
  HarnessAccountProfilesParams,
  HarnessAccountProfilesState,
  HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import { rendererCreditsTone } from "../renderer-credits-control.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { accountDisplayText } from "./account-privacy.js";
import { formatAccountCreditsReset } from "./accounts-usage.js";
import type { ClaudeAccountMessages } from "./claude-account-messages.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererClaudeAccountClient {
  harnessAccountProfiles?(
    params: HarnessAccountProfilesParams,
  ): Promise<HarnessAccountProfilesState>;
}

const HARNESS_ID = "claude-code";
const LOGIN_POLL_MS = 2_000;
const THRESHOLDS = [80, 85, 90, 95, 98, 100] as const;

type ProfileAction = HarnessAccountProfilesParams extends infer P
  ? P extends { harnessId: unknown }
    ? Omit<P, "harnessId">
    : never
  : never;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) => values[key] ?? match);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Saved Claude Code sign-ins on the accounts page: list with live 5-hour / 7-day quota, switch,
 * rename, remove, add through the browser sign-in, and the automatic switch threshold.
 */
export function mountClaudeAccounts(
  root: HTMLElement,
  signal: AbortSignal,
  getClient: () => RendererClaudeAccountClient | null,
  messages: ClaudeAccountMessages,
  settings: RendererSettingsMessages,
  pluginFor: (id: string) => HarnessPluginDescriptor | undefined,
) {
  const document = root.ownerDocument;
  let state: HarnessAccountProfilesState | null = null;
  let busy = false;
  let hideEmails = false;
  let expanded = true;
  let notice: string | null = null;
  let renaming: string | null = null;
  let confirmingRemoval: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const shown = (text: string): string => accountDisplayText(text, hideEmails);

  const section = document.createElement("section");
  section.className = "settings-pi-accounts settings-claude-accounts";
  section.hidden = true;
  section.setAttribute("aria-label", messages.sectionTitle);
  const header = document.createElement("div");
  header.className = "settings-pi-accounts__header";
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "settings-pi-accounts__fold";
  fold.setAttribute("aria-expanded", "true");
  const title = document.createElement("strong");
  title.textContent = messages.sectionTitle;
  const count = document.createElement("span");
  count.className = "settings-pi-accounts__count";
  fold.append(
    createRendererSettingsIcon("chevron-right", 14),
    createRendererAgentIcon(HARNESS_ID, 16, document, pluginFor(HARNESS_ID)),
    title,
    count,
  );
  const hint = document.createElement("span");
  hint.className = "settings-pi-accounts__hint";
  hint.textContent = messages.sectionHint;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "settings-icon-button";
  refresh.title = messages.refresh;
  refresh.setAttribute("aria-label", messages.refresh);
  refresh.append(createRendererSettingsIcon("refresh", 16));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-pi-accounts__import";
  add.append(createRendererSettingsIcon("add", 14), messages.add);
  header.append(fold, hint, refresh, add);
  const card = document.createElement("div");
  card.className = "settings-pi-accounts__card";
  const login = document.createElement("div");
  login.className = "settings-claude-accounts__login";
  const footer = document.createElement("div");
  footer.className = "settings-claude-accounts__footer";
  const status = document.createElement("p");
  status.className = "settings-claude-accounts__notice";
  status.setAttribute("aria-live", "polite");
  section.append(header, login, card, footer, status);

  fold.addEventListener("click", () => {
    expanded = !expanded;
    fold.setAttribute("aria-expanded", String(expanded));
    render();
  });

  const request = async (action: ProfileAction, quiet = false): Promise<boolean> => {
    const client = getClient();
    if (!client?.harnessAccountProfiles) return false;
    if (!quiet) {
      busy = true;
      render();
    }
    try {
      const next = await client.harnessAccountProfiles({
        harnessId: HARNESS_ID,
        ...action,
      } as HarnessAccountProfilesParams);
      if (signal.aborted) return false;
      state = next;
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      // A Host without the capability (or without Claude Code) simply hides the section.
      if (state === null) section.hidden = true;
      else notice = fill(messages.failed, { error: errorText(error) });
      return false;
    } finally {
      if (!quiet) busy = false;
      if (!signal.aborted) {
        render();
        schedulePoll();
      }
    }
  };

  const schedulePoll = (): void => {
    clearTimeout(pollTimer);
    if (state?.login?.status !== "pending" || signal.aborted) return;
    pollTimer = setTimeout(() => {
      void request({ action: "list" }, true).then(() => {
        const result = state?.login;
        if (result?.status === "completed") {
          const profile = state?.profiles.find((item) => item.profileId === result.profileId);
          notice = fill(messages.loginDone, {
            name: shown(profile?.label ?? profile?.email ?? ""),
          });
          render();
        } else if (result?.status === "failed") {
          notice = fill(messages.loginFailed, { error: result.error ?? "" });
          render();
        }
      });
    }, LOGIN_POLL_MS);
  };
  signal.addEventListener("abort", () => clearTimeout(pollTimer));

  add.addEventListener("click", () => {
    notice = null;
    void request({ action: "login.start", mode: "callback" });
  });
  refresh.addEventListener("click", () => {
    notice = null;
    void request({ action: "list", refreshUsage: true });
  });

  const meter = (label: string, window: HarnessAccountProfileWindow | undefined): HTMLElement => {
    const element = document.createElement("div");
    element.className = "settings-account-usage__meter";
    const name = document.createElement("span");
    name.className = "settings-account-usage__title";
    name.textContent = label;
    const tone = rendererCreditsTone(window?.usedPercent ?? 0);
    const percent = document.createElement("div");
    percent.className = `settings-account-usage__percent settings-account-usage__percent--${tone}`;
    const value = document.createElement("span");
    value.textContent = window ? `${Math.round(window.usedPercent)}%` : "—";
    percent.append(value);
    const bar = document.createElement("div");
    bar.className = `settings-account-usage__bar settings-account-usage__bar--${tone}`;
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(window?.usedPercent ?? 0));
    const filled = document.createElement("span");
    filled.style.width = `${Math.min(100, Math.max(0, window?.usedPercent ?? 0))}%`;
    bar.append(filled);
    const reset = document.createElement("div");
    reset.className = "settings-account-usage__sub";
    reset.textContent = window?.resetsAt
      ? formatAccountCreditsReset(window.resetsAt, settings.locale)
      : "";
    element.append(name, percent, bar, reset);
    return element;
  };

  const EXPIRY_WARNING_MS = 30 * 86_400_000;
  const expiryText = (expiresAt: string | undefined): string => {
    if (!expiresAt) return "";
    const date = new Intl.DateTimeFormat(settings.locale, { dateStyle: "medium" }).format(
      new Date(expiresAt),
    );
    return Date.parse(expiresAt) - Date.now() < EXPIRY_WARNING_MS
      ? fill(messages.expiresSoon, { date })
      : fill(messages.expiresOn, { date });
  };

  const metaLine = (parts: string[]): HTMLElement => {
    const meta = document.createElement("div");
    meta.className = "settings-account-metadata";
    parts.filter(Boolean).forEach((text, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.textContent = "·";
        separator.setAttribute("aria-hidden", "true");
        meta.append(separator);
      }
      const part = document.createElement("span");
      part.textContent = text;
      meta.append(part);
    });
    return meta;
  };

  const actionButton = (text: string, onClick: () => void, extra = ""): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings-account-action ${extra}`.trim();
    button.textContent = text;
    button.disabled = busy;
    button.addEventListener("click", onClick);
    return button;
  };

  const badge = (): HTMLElement => {
    const element = document.createElement("span");
    element.className = "settings-claude-accounts__badge";
    element.textContent = messages.active;
    return element;
  };

  const mark = (): HTMLElement => {
    const element = document.createElement("div");
    element.className = "settings-harness-account__logo";
    element.dataset.agent = HARNESS_ID;
    element.setAttribute("aria-hidden", "true");
    element.append(createRendererAgentIcon(HARNESS_ID, 26, document, pluginFor(HARNESS_ID)));
    return element;
  };

  const renderProfile = (profile: HarnessAccountProfile): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-pi-accounts__row settings-claude-accounts__row";
    if (profile.active) row.dataset.active = "true";
    const identity = document.createElement("div");
    identity.className = "settings-pi-accounts__identity";
    if (renaming === profile.profileId) {
      const input = document.createElement("input");
      input.className = "settings-claude-accounts__rename";
      input.value = profile.label;
      input.setAttribute("aria-label", messages.renamePrompt);
      input.maxLength = 256;
      const commit = (save: boolean) => {
        const label = input.value.trim();
        renaming = null;
        if (save && label && label !== profile.label) {
          void request({ action: "rename", profileId: profile.profileId, label });
        } else render();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") commit(true);
        if (event.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      identity.append(input);
      queueMicrotask(() => input.focus());
    } else {
      const label = document.createElement("strong");
      label.className = "settings-account-email";
      label.textContent = shown(profile.label);
      label.title = label.textContent;
      label.translate = false;
      identity.append(label);
    }
    const statusText =
      profile.status === "expired"
        ? messages.expired
        : profile.status === "error" || profile.error
          ? messages.error
          : "";
    identity.append(
      metaLine([
        profile.email && profile.email !== profile.label ? shown(profile.email) : "",
        profile.plan ? profile.plan.toUpperCase() : "",
        statusText || expiryText(profile.expiresAt),
      ]),
    );
    const usage = document.createElement("div");
    usage.className = "settings-claude-accounts__usage";
    if (profile.fiveHour || profile.sevenDay) {
      usage.append(
        meter(messages.fiveHour, profile.fiveHour),
        meter(messages.sevenDay, profile.sevenDay),
      );
    } else {
      const empty = document.createElement("span");
      empty.className = "settings-account-usage__message";
      empty.textContent = profile.status === "expired" ? messages.expired : messages.noUsage;
      usage.append(empty);
    }
    const actions = document.createElement("div");
    actions.className = "settings-pi-accounts__actions";
    if (profile.active) actions.append(badge());
    else if (profile.status !== "expired") {
      actions.append(
        actionButton(
          messages.use,
          () => {
            notice = null;
            void request({ action: "activate", profileId: profile.profileId });
          },
          "settings-claude-accounts__use",
        ),
      );
    }
    if (profile.status === "expired") {
      actions.append(
        actionButton(
          messages.relogin,
          () => void request({ action: "login.start", mode: "callback" }),
        ),
      );
    }
    actions.append(
      actionButton(messages.rename, () => {
        renaming = profile.profileId;
        render();
      }),
    );
    const removing = confirmingRemoval === profile.profileId;
    actions.append(
      actionButton(
        removing ? fill(messages.removeConfirm, { name: shown(profile.label) }) : messages.remove,
        () => {
          if (!removing) {
            confirmingRemoval = profile.profileId;
            render();
            setTimeout(() => {
              if (confirmingRemoval === profile.profileId) {
                confirmingRemoval = null;
                render();
              }
            }, 5_000);
            return;
          }
          confirmingRemoval = null;
          void request({ action: "remove", profileId: profile.profileId });
        },
        "settings-pi-accounts__remove",
      ),
    );
    row.append(mark(), identity, usage, actions);
    return row;
  };

  const renderNative = (active: boolean): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-pi-accounts__row settings-claude-accounts__row";
    if (active) row.dataset.active = "true";
    const identity = document.createElement("div");
    identity.className = "settings-pi-accounts__identity";
    const label = document.createElement("strong");
    label.className = "settings-account-email";
    label.textContent = messages.native;
    identity.append(label, metaLine([messages.nativeHint]));
    const spacer = document.createElement("div");
    const actions = document.createElement("div");
    actions.className = "settings-pi-accounts__actions";
    if (active) actions.append(badge());
    else {
      actions.append(
        actionButton(
          messages.use,
          () => {
            notice = null;
            void request({ action: "activate", profileId: null });
          },
          "settings-claude-accounts__use",
        ),
      );
    }
    row.append(mark(), identity, spacer, actions);
    return row;
  };

  const renderLogin = (): void => {
    const pending = state?.login?.status === "pending" ? state.login : null;
    login.hidden = !pending;
    if (!pending) {
      login.replaceChildren();
      return;
    }
    const text = document.createElement("p");
    text.textContent = messages.loginPending;
    const open = document.createElement("a");
    open.className = "settings-pi-accounts__import";
    open.href = pending.authorizeUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = messages.loginOpen;
    const manual = document.createElement("label");
    manual.className = "settings-claude-accounts__paste";
    const manualText = document.createElement("span");
    manualText.textContent = messages.loginManual;
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = messages.loginPaste;
    manual.append(manualText, input);
    const submit = actionButton(messages.loginSubmit, () => {
      const code = input.value.trim();
      if (!code) return;
      if (/^sk-ant-/u.test(code)) {
        // A ready-made token (`claude setup-token`) replaces the browser sign-in.
        void request({ action: "token.add", token: code }).then((ok) => {
          if (!ok) return;
          notice = messages.tokenAdded;
          void request({ action: "login.cancel", loginId: pending.loginId }, true);
        });
        return;
      }
      void request({ action: "login.complete", loginId: pending.loginId, code }).then((ok) => {
        if (ok && state?.login?.status === "completed") {
          const profile = state.profiles.find((item) => item.profileId === state?.login?.profileId);
          notice = fill(messages.loginDone, { name: shown(profile?.label ?? "") });
          render();
        }
      });
    });
    const cancel = actionButton(messages.loginCancel, () => {
      void request({ action: "login.cancel", loginId: pending.loginId });
    });
    const row = document.createElement("div");
    row.className = "settings-claude-accounts__login-actions";
    row.append(open, submit, cancel);
    login.replaceChildren(text, manual, row);
  };

  const renderFooter = (): void => {
    if (!state) {
      footer.replaceChildren();
      return;
    }
    const auto = document.createElement("label");
    auto.className = "settings-claude-accounts__auto";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = state.autoSwitch.enabled;
    toggle.disabled = busy;
    const autoText = document.createElement("span");
    autoText.textContent = messages.autoSwitch;
    auto.append(toggle, autoText);
    const threshold = document.createElement("label");
    threshold.className = "settings-claude-accounts__threshold";
    const thresholdText = document.createElement("span");
    thresholdText.textContent = messages.threshold;
    const select = document.createElement("select");
    select.disabled = busy || !state.autoSwitch.enabled;
    for (const value of THRESHOLDS) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}%`;
      option.selected = value === state.autoSwitch.thresholdPercent;
      select.append(option);
    }
    threshold.append(thresholdText, select);
    const save = (): void => {
      void request({
        action: "autoSwitch.set",
        autoSwitch: { enabled: toggle.checked, thresholdPercent: Number(select.value) },
      });
    };
    toggle.addEventListener("change", save);
    select.addEventListener("change", save);
    const help = document.createElement("p");
    help.className = "settings-claude-accounts__help";
    help.textContent = `${messages.autoSwitchHint} ${messages.applyNote}`;
    const controls = document.createElement("div");
    controls.className = "settings-claude-accounts__controls";
    controls.append(auto, threshold);
    footer.replaceChildren(controls, help);
    const last = state.lastSwitch;
    if (last?.reason === "auto" && last.toProfileId) {
      const profile = state.profiles.find((item) => item.profileId === last.toProfileId);
      const info = document.createElement("p");
      info.className = "settings-claude-accounts__help";
      info.textContent = fill(messages.lastAuto, {
        name: shown(profile?.label ?? last.toProfileId),
        time: formatAccountCreditsReset(last.at, settings.locale),
      });
      footer.append(info);
    }
  };

  function render(): void {
    if (!state) return;
    section.hidden = false;
    count.textContent = String(state.profiles.length);
    add.disabled = busy || state.login?.status === "pending";
    refresh.disabled = busy || state.profiles.length === 0;
    card.hidden = !expanded;
    footer.hidden = !expanded || state.profiles.length === 0;
    renderLogin();
    if (state.profiles.length === 0) {
      const empty = document.createElement("p");
      empty.className = "settings-pi-accounts__empty";
      empty.textContent = messages.empty;
      card.replaceChildren(empty);
    } else {
      card.replaceChildren(
        ...state.profiles.map(renderProfile),
        renderNative(state.activeProfileId === null),
      );
    }
    renderFooter();
    status.textContent = notice ?? "";
    status.hidden = !notice;
  }

  return {
    section,
    refresh(force = false): void {
      if (!getClient()?.harnessAccountProfiles) return;
      void request({ action: "list", ...(force ? { refreshUsage: true } : {}) }, state !== null);
    },
    setHideEmails(value: boolean): void {
      hideEmails = value;
      render();
    },
  };
}
