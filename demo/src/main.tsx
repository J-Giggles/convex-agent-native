import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { connectConvexDemoClient } from "./convexDemoClient.js";
import "./styles.css";

const container = document.querySelector("#root");
if (!(container instanceof HTMLElement)) throw new Error("Application root is unavailable");

const root = createRoot(container);
const convexUrl = import.meta.env.VITE_CONVEX_URL;
const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

try {
  if (!convexUrl || !siteUrl) throw new Error("Demo deployment is not configured");
  const client = await connectConvexDemoClient({
    convexUrl,
    siteUrl,
  });
  window.addEventListener("pagehide", () => client.close(), { once: true });
  root.render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
} catch {
  root.render(
    <StrictMode>
      <main className="startup-error">
        <p className="eyebrow">Convex × Agent Native</p>
        <h1>The public demo is unavailable.</h1>
        <p>Its fail-closed configuration prevented an unsafe connection. Please try again later.</p>
      </main>
    </StrictMode>,
  );
}
