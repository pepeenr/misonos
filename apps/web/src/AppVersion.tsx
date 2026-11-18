import { useEffect, useState } from "react";
import { BUILD, fetchServerBuild, formatBuild, sameBuild } from "./buildInfo.js";

type BuildStatus = "checking" | "current" | "outdated" | "unknown";

// The very bottom of Settings: this build, and whether the server has a newer one.
export function AppVersion() {
  const [status, setStatus] = useState<BuildStatus>("checking");
  useEffect(() => {
    let cancelled = false;
    void fetchServerBuild().then((server) => {
      if (!cancelled) setStatus(!server ? "unknown" : sameBuild(server, BUILD) ? "current" : "outdated");
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <p className="app-version">
      MiSonos {formatBuild(BUILD)}
      {status === "current" ? <span> · latest</span> : null}
      {status === "outdated" ? (
        <>
          {" · "}
          <button type="button" className="app-version-reload" onClick={() => window.location.reload()}>
            newer version available, reload
          </button>
        </>
      ) : null}
    </p>
  );
}
