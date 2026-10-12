import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./App";
import { installGlobalErrorHandlers } from "./lib/error-report";
import "./index.css";

// First line of defense: script errors and unhandled rejections anywhere on
// the site report to the admin Errors tab (and the console) from here on.
installGlobalErrorHandlers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
