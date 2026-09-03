import { AxiError, exitCodeForError } from "axi-sdk-js";
import {
  type SuggestionGlobals,
  withSuggestionGlobals,
} from "./suggestions.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "LOCKED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

interface NotFoundOptions {
  globals?: SuggestionGlobals;
  suggestions?: string[];
}

/** A task id was referenced that does not exist in the backlog. */
export function notFound(id: string, options: NotFoundOptions = {}): AxiError {
  const suggestions =
    options.suggestions ??
    withSuggestionGlobals(
      ["Run `tasks-axi list --all` to see existing tasks"],
      options.globals,
    );
  return new AxiError(
    `Task "${id}" not found in this backlog`,
    "NOT_FOUND",
    suggestions,
  );
}

/**
 * A capability the active backend does not support was requested. The
 * capability is named so the error is actionable rather than a raw failure
 * (AXI house style §6; report §8 graceful degradation).
 */
export function unsupported(capability: string, backend: string): AxiError {
  return new AxiError(
    `The ${backend} backend does not support ${capability}`,
    "UNSUPPORTED",
  );
}

/**
 * A `mv` was attempted between two homes on different backends.
 *
 * This is the real constraint the ticket asks to surface rather than paper
 * over: two homes that exchange handoffs must share a backend, because a task
 * carries a Linear issue identity that a markdown file cannot hold and vice
 * versa. Half-working (create there, fail to remove here) would duplicate the
 * task, so the move is refused before anything is written.
 */
export function crossBackendMove(from: string, to: string): AxiError {
  return new AxiError(
    `Cannot move tasks from a ${from} home to a ${to} home`,
    "UNSUPPORTED",
    [
      "Homes that exchange handoffs must share a backend",
      `Point --to at another ${from} home, or migrate the destination home to the ${from} backend first`,
    ],
  );
}
