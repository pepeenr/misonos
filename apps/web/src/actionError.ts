/**
 * What to tell someone an action failed with: the bridge's own words when they're meant
 * for people, else `fallback`. A speaker's "UPnPError (code=711)", a bare status or a
 * dropped connection says nothing to them.
 */
export function actionError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message.trim() : "";
  if (!text || error instanceof TypeError || /UPnPError|\(code=|^Request failed: \d+$|^Sonos SOAP /.test(text)) return fallback;
  return text;
}
