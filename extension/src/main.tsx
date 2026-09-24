import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@auth/ui/styles.css";
import "./popup.css";
import { Popup } from "./Popup";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
