import { AxiError } from "../errors.js";

/**
 * The `linear-axi/client` seam.
 *
 * The client is loaded dynamically rather than declared as a package
 * dependency, for two reasons. First, the npm name `linear-axi` is held by an
 * unrelated package, so a plain `dependencies` entry would install the wrong
 * code; the fleet installs our `linear-axi` globally or as a link. Second, it
 * keeps the markdown backend - and every command that never touches Linear -
 * free of a network client it does not need, which matters because
 * `bin/tasks-axi.ts` is deliberately import-light.
 *
 * The import specifier stays the literal `linear-axi/client` the ticket names.
 * A missing or incompatible install fails with a structured, actionable error
 * rather than a raw module-resolution stack.
 */

/** The subset of the client surface this backend uses. */
export interface LinearClientLike {
  request<T>(
    query: string,
    variables: Record<string, unknown>,
    operation: string,
  ): Promise<T>;
}

export interface ClientModuleLike {
  createClient(options?: { env?: NodeJS.ProcessEnv }): LinearClientLike;
}

const SPECIFIER = "linear-axi/client";

let cached: ClientModuleLike | undefined;

export async function loadClientModule(): Promise<ClientModuleLike> {
  if (cached) return cached;
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ SPECIFIER);
  } catch (error) {
    throw new AxiError(
      `The linear backend requires the ${SPECIFIER} module, which is not installed`,
      "UNSUPPORTED",
      [
        "Install linear-axi from https://github.com/yjuyjuy/linear-axi (e.g. `npm i -g linear-axi` from that checkout)",
        'Or set `backend = "markdown"` in .tasks.toml',
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    );
  }
  const module = loaded as Partial<ClientModuleLike>;
  if (typeof module.createClient !== "function") {
    throw new AxiError(
      `The installed ${SPECIFIER} does not export createClient`,
      "UNSUPPORTED",
      [
        "Upgrade linear-axi to a build that ships the typed client subpath",
        `Check \`node -e "import('${SPECIFIER}').then(m => console.log(Object.keys(m)))"\``,
      ],
    );
  }
  cached = module as ClientModuleLike;
  return cached;
}

/** Reset the module cache; tests inject their own client instead. */
export function resetClientModuleCache(): void {
  cached = undefined;
}
