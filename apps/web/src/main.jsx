import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// Color de la tienda desde el primer dibujo (la identidad la confirma después /api/conectividad; ver App.jsx).
try {
  const tienda = JSON.parse(localStorage.getItem("farmahub:tienda") || "null");
  if (tienda?.id) document.documentElement.dataset.tienda = String(tienda.id);
} catch {
  /* sin almacenamiento: se aplica al responder el API */
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
