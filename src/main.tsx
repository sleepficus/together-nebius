import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import "./ui/dashboard-polish.css";
import "./ui/nemo.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
