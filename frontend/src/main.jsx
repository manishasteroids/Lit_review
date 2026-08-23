import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { AuthModalHost } from "./Auth.jsx";
import ShareViewer from "./components/ShareViewer.jsx";
import "./diagramZoom.js";
import "./styles.css";
import "katex/dist/katex.min.css";

// No client-side router in this app — a public share link is the one path
// that needs to work signed-out with no Sift session, so it's handled as a
// standalone branch here rather than folded into <App/>'s auth-gated tree.
const shareMatch = window.location.pathname.match(/^\/share\/([^/]+)/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {shareMatch ? (
      <ShareViewer token={shareMatch[1]} />
    ) : (
      <>
        <App />
        <AuthModalHost />
      </>
    )}
  </React.StrictMode>
);
