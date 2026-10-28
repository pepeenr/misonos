import React from "react";
import ReactDOM from "react-dom/client";
import { clearSignInMarker } from "./accessSession.js";
import { App } from "./App.js";
import { DialogProvider } from "./dialogs.js";
import { FavoritesProvider } from "./favorites.js";
import { LocalPlayerProvider } from "./localPlayer.js";
import "./styles.css";

clearSignInMarker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DialogProvider>
      <FavoritesProvider>
        <LocalPlayerProvider>
          <App />
        </LocalPlayerProvider>
      </FavoritesProvider>
    </DialogProvider>
  </React.StrictMode>
);
