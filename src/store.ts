// Platform admin state.
//
// The operator signs in with the deployment's platform admin token. The SPA
// keeps it in sessionStorage — per tab, gone when the tab closes — and sends
// it as a bearer token, so there is no admin cookie and therefore no CSRF
// surface. Nothing else about the token is persisted or logged.

import { reactive, readonly } from "vue";

const STORAGE_KEY = "xunara.admin.token";

// storage() returns the tab-scoped store, or null outside a browser (unit
// tests, tooling). The token then lives only in memory for that process.
function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

const state = reactive({
  token: storage()?.getItem(STORAGE_KEY) ?? "",
  toasts: [] as { id: number; kind: "success" | "error" | "info"; text: string }[],
});

let toastSeq = 0;

export const admin = {
  state: readonly(state),

  load(): void {
    state.token = storage()?.getItem(STORAGE_KEY) ?? "";
  },

  signIn(token: string): void {
    const trimmed = token.trim();
    state.token = trimmed;
    storage()?.setItem(STORAGE_KEY, trimmed);
  },

  signOut(): void {
    state.token = "";
    storage()?.removeItem(STORAGE_KEY);
  },

  get authenticated(): boolean {
    return state.token !== "";
  },

  toast(kind: "success" | "error" | "info", text: string): void {
    const id = ++toastSeq;
    state.toasts.push({ id, kind, text });
    window.setTimeout(() => {
      const index = state.toasts.findIndex((t) => t.id === id);
      if (index >= 0) state.toasts.splice(index, 1);
    }, 4200);
  },

  dismiss(id: number): void {
    const index = state.toasts.findIndex((t) => t.id === id);
    if (index >= 0) state.toasts.splice(index, 1);
  },
};
