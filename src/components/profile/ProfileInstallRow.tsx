"use client";

/**
 * "Install app" on request, in the profile's Preferences group.
 *
 * Shown only when the browser can install the app from the page
 * (`useCanInstall`, src/lib/install-app.ts); a row that did nothing would be
 * worse than none, and the browser's own menu still works. The tap calls
 * `requestInstall()` directly so `navigator.install()` keeps its user
 * activation. The answer is written to a polite live region.
 */

import { useCallback, useRef, useState } from "react";
import { Download } from "lucide-react";
import { GroupedRow } from "@/components/profile/GroupedRow";
import { requestInstall } from "@/lib/install-app";
import { useCanInstall } from "@/lib/use-install-app";

export function ProfileInstallRow() {
  const available = useCanInstall();
  const [status, setStatus] = useState("");
  const busy = useRef(false);

  const install = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    // First call of the handler: keeps the tap's user activation.
    const outcome = await requestInstall();
    busy.current = false;
    setStatus(
      outcome === "accepted"
        ? "The app was installed or opened."
        : outcome === "dismissed"
          ? "Installation was cancelled."
          : "Installation could not start.",
    );
  }, []);

  return (
    <>
      {available && (
        <GroupedRow
          icon={Download}
          label="Install app"
          value="Home screen"
          onClick={install}
        />
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
    </>
  );
}
