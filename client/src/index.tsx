// client/src/index.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import App from "./App";
import SfuApp from "./SfuApp"; // Assuming you have this file

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

const Main = () => (
  <div>
    <h1>Select Architecture</h1>
    <nav>
      <Link to="/p2p">P2P Mesh Test</Link> | <Link to="/sfu">SFU Test</Link>
    </nav>
  </div>
);

root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Main />} />
        <Route path="/p2p" element={<App />} />
        <Route path="/sfu" element={<SfuApp />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
