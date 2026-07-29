import { useEffect, useState } from "react";
import { AppState, seedState } from "../lib/dataService";
import { cloudDataService } from "../lib/cloudDataService";
import { ReadOnlyPortal } from "./App";

export default function PublicViewer() {
  const [state, setState] = useState<AppState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => cloudDataService.subscribePublic(next => {
    setState(next);
    setLoaded(true);
    setError("");
  }, nextError => {
    setLoaded(true);
    setError(nextError.message || "The production viewer is temporarily unavailable.");
  }), []);

  if (!loaded) return <div className="auth-screen"><div className="auth-loading"><span className="auth-spinner"/><b>Opening Production Job Viewer…</b><small>Loading the latest shared production data</small></div></div>;
  if (error) return <div className="auth-screen"><div className="public-viewer-message"><b>Production viewer unavailable</b><p>{error}</p><button className="secondary" onClick={()=>window.location.reload()}>Try again</button></div></div>;
  if (!state) return <div className="auth-screen"><div className="public-viewer-message"><b>The viewer is not ready yet</b><p>A PlantFlow administrator must initialize the shared production workspace first.</p></div></div>;
  return <ReadOnlyPortal state={state || seedState}/>;
}
