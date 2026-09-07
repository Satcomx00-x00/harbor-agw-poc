/**
 * Where upstream requests actually go.
 *
 * Extracted from the boot sequence because it is the piece most likely to be
 * wrong and the least likely to announce it: get this wrong and requests reach
 * a real server that answers 200 with a web page, so tools return HTML and it
 * reads like an authentication failure.
 *
 * Being its own function makes it testable without starting anything.
 */

export interface BaseUrlInput {
  /** `servers[0].url`, or Swagger 2.0's scheme+host+basePath. May be a path. */
  declared: string | undefined;
  /** UPSTREAM_BASE_URL. */
  override: string | undefined;
}

export interface BaseUrlResolution {
  url: string;
  /** How it was arrived at, for the start-up log. */
  reason: string;
}

export class BaseUrlError extends Error {
  readonly input: BaseUrlInput;

  constructor(input: BaseUrlInput) {
    super(
      "no usable upstream base URL.\n" +
        `  document declares : ${input.declared ?? "(nothing)"}\n` +
        `  UPSTREAM_BASE_URL : ${input.override ?? "(unset)"}\n` +
        "Set UPSTREAM_BASE_URL to an absolute http(s) URL. A document's base is " +
        "often relative, or names a host reachable only from somewhere else.",
    );
    this.name = "BaseUrlError";
    this.input = input;
  }
}

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

function isAbsolute(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function pathOf(url: string): string {
  if (!isAbsolute(url)) return trimTrailingSlash(url);
  try {
    return trimTrailingSlash(new URL(url).pathname);
  } catch {
    return "";
  }
}

/**
 * UPSTREAM_BASE_URL overrides the **origin**; the document keeps its **path**.
 *
 * That split is the whole reason this function exists. Harbor's document says
 * `host: localhost` with `basePath: /api/v2.0` — the host is a placeholder, the
 * path is authoritative. Treating the override as the complete base drops
 * `/api/v2.0`, every request lands on the portal, and the failure looks like
 * anything but a URL problem.
 *
 * An override that carries its own path is taken as given: the operator was
 * explicit and should win over the document.
 */
export function resolveBaseUrl(input: BaseUrlInput): BaseUrlResolution {
  const declared = input.declared === undefined ? "" : trimTrailingSlash(input.declared);
  const override = input.override === undefined ? "" : trimTrailingSlash(input.override);

  if (override === "") {
    if (!isAbsolute(declared)) throw new BaseUrlError(input);
    return { url: declared, reason: "from the document" };
  }

  if (!isAbsolute(override)) throw new BaseUrlError(input);

  const overridePath = pathOf(override);
  if (overridePath !== "") {
    return { url: override, reason: "from UPSTREAM_BASE_URL, which carries its own path" };
  }

  const declaredPath = pathOf(declared);
  if (declaredPath === "") {
    return { url: override, reason: "from UPSTREAM_BASE_URL" };
  }

  return {
    url: override + declaredPath,
    reason: `origin from UPSTREAM_BASE_URL + path "${declaredPath}" from the document`,
  };
}
