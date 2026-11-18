// Which build of MiSonos this is. vite.config.ts stamps it in at build time and also
// writes it to /build.json, so the app can tell whether the server has a newer one.

export interface BuildInfo {
  /** When the build ran (ISO). Tells two builds apart. */
  time: string;
  /** Short git commit, when the build knew it (Coolify passes it only if set to). */
  commit?: string;
}

declare const __MISONOS_BUILD__: BuildInfo;

export const BUILD: BuildInfo = __MISONOS_BUILD__;

/** "18 Nov 2026, 19:20 · 3d51984" */
export function formatBuild(build: BuildInfo, locale?: string): string {
  const date = new Date(build.time);
  const when = Number.isNaN(date.getTime())
    ? build.time
    : date.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return build.commit ? `${when} · ${build.commit}` : when;
}

export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.time === b.time && (a.commit ?? "") === (b.commit ?? "");
}

/** The build the server has now; undefined when it can't say (offline, dev server). */
export async function fetchServerBuild(): Promise<BuildInfo | undefined> {
  try {
    const response = await fetch(`/build.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<BuildInfo>;
    return typeof body.time === "string" ? { time: body.time, commit: typeof body.commit === "string" ? body.commit : undefined } : undefined;
  } catch {
    return undefined;
  }
}
