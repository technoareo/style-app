"use client";

import { useEffect } from "react";

export function PwaRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Installation remains optional: the web app must continue to work when
      // service workers are blocked by a browser or device policy.
    });
  }, []);
  return null;
}
