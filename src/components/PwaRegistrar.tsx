"use client";

import { useEffect } from "react";

export function PwaRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    void (async () => {
      try {
        const response = await fetch("/api/runtime-config", { cache: "no-store" });
        const config = (await response.json()) as { features?: { pwaCache?: boolean } };
        if (config.features?.pwaCache !== true) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(
              keys.filter((key) => key.startsWith("style-studio-")).map((key) => caches.delete(key)),
            );
          }
          return;
        }
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch {
        // Installation remains optional: the web app must continue to work when
        // service workers, runtime config or storage are blocked by device policy.
      }
    })();
  }, []);
  return null;
}
