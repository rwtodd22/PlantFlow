import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthGate } from "./auth";
import PublicViewer from "./PublicViewer";
import "./index.css";
import "./label.css";

const publicViewer = new URLSearchParams(window.location.search).get("view") === "portal";
const productionViewer = new URLSearchParams(window.location.search).get("view") === "production";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {publicViewer ? <PublicViewer/> : <AuthGate access={productionViewer ? "production" : "main"}><App /></AuthGate>}
  </React.StrictMode>,
);
