import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { attachReactViews } from "@/app/react-views";

/**
 * React entry. It runs as a module script, i.e. after the legacy document has
 * been parsed and its scripts have run, and mounts into #medris-root, which
 * the build appends at the end of the document. Importing no CSS here is
 * deliberate: the legacy stylesheets fully define the current look.
 */
// Tell the view registry that React can now draw migrated screens (see src/bridge/view-registry.ts).
attachReactViews();

// Register/update the root service worker explicitly on every app launch.
// updateViaCache:"none" prevents an HTTP-cached /sw.js from keeping devices
// on an older worker after a deployment. This is intentionally non-blocking:
// registration must never delay the legacy app or the React mount.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  }).catch((error: unknown) => {
    console.warn("[Medris] Service worker registration failed:", error);
  });
}

const container = document.getElementById("medris-root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
