import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
// Self-hosted via @fontsource - no runtime request to any external font
// CDN, in line with this project's own "no trackers" privacy notice
// (see AboutModal's privacy section). Only the two weights actually
// used by the title (BrandTitle.tsx) are imported.
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/800.css";
import "./index.css";
import "./header.css";
import "./recommendations-scroll.css";
import "./sticky-layout.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
