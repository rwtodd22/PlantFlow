import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./auth";
import {PortalLoading} from './PortalLoading';
import "./index.css";
import "./label.css";

const publicViewer = new URLSearchParams(window.location.search).get("view") === "portal";
const productionViewer = new URLSearchParams(window.location.search).get("view") === "production";
const jobIntakePortal = new URLSearchParams(window.location.search).get("view") === "intake";

// Start the selected page download alongside authentication, not before it.
// Unrelated routes no longer delay the first login/loading screen.
const pageModule = publicViewer ? import('./PublicViewer') : jobIntakePortal ? import('./JobIntakePortal') : import('./App');
// Authentication may finish after the download fails; the boundary still
// receives the rejection when rendered, without an unhandled preload rejection.
void pageModule.catch(()=>undefined);
const Page = React.lazy(()=>pageModule);
class PageLoadBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="auth-screen"><div className="auth-loading"><b>PlantFlow could not open</b><small>Check your connection and reload to get the latest version.</small><button className="secondary" onClick={()=>window.location.reload()}>Reload PlantFlow</button></div></div>:this.props.children;}
}
const page = <PageLoadBoundary><React.Suspense fallback={<PortalLoading/>}><Page/></React.Suspense></PageLoadBoundary>;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {publicViewer ? page : <AuthGate access={jobIntakePortal?'intake':productionViewer?'production':'main'}>{page}</AuthGate>}
  </React.StrictMode>,
);
