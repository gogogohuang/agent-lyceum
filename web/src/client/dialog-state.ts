import type { CommandResult } from "./api";

export type DialogState =
  | { phase: "form"; errors: Record<string, string>; notice?: string }
  | { phase: "running" }
  | { phase: "confirm"; need: "confirm" | "typed"; target?: string; typed: string }
  | { phase: "done"; result: CommandResult };

export type DialogAction = { type: "submit" } | { type: "result"; result: CommandResult } | { type: "typed"; value: string } | { type: "back" } | { type: "reset" };

export const initialState: DialogState = { phase: "form", errors: {} };

export function reduce(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "submit":
      return state.phase === "running" ? state : { phase: "running" };
    case "typed":
      return state.phase === "confirm" ? { ...state, typed: action.value } : state;
    case "back":
    case "reset":
      // Ignored while a request is in flight (the dialog component blocks closing during "running"),
      // so a late response can never land on a reopened form.
      return state.phase === "running" ? state : initialState;
    case "result": {
      if (state.phase !== "running") return state;
      const r = action.result;
      if (r.kind === "short" || r.kind === "job") return { phase: "done", result: r };
      if (r.kind === "need") return { phase: "confirm", need: r.need, ...(r.target !== undefined ? { target: r.target } : {}), typed: "" };
      if (r.kind === "invalid") return r.field ? { phase: "form", errors: { [r.field]: r.error } } : { phase: "form", errors: {}, notice: r.error };
      if (r.kind === "stale") return { phase: "form", errors: {}, notice: "頁面已過期（伺服器重新啟動過），請重新整理頁面後再試。" };
      return { phase: "form", errors: {}, notice: r.message };
    }
  }
}

export function confirmReady(state: DialogState): boolean {
  return state.phase === "confirm" && (state.need === "confirm" || state.typed === state.target);
}
