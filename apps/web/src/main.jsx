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

// Accesibilidad (WCAG 2.1.1, regla axe "scrollable-region-focusable"): las tablas anchas se desplazan dentro de su caja
// .tabla-scroll; para recorrerlas con el teclado la caja debe poder enfocarse. Se marca cada caja al aparecer, con el
// título de su sección como nombre accesible, sin tocar cada módulo.
function marcarTablas(raiz) {
  for (const caja of raiz.querySelectorAll(".tabla-scroll:not([tabindex])")) {
    caja.setAttribute("tabindex", "0");
    caja.setAttribute("role", "region");
    const titulo = caja.closest("section, .rep-bloque, .historial, article")?.querySelector("h2, h3, h4")?.textContent?.trim();
    caja.setAttribute("aria-label", titulo ? `Tabla: ${titulo}` : "Tabla");
  }
}
new MutationObserver(() => marcarTablas(document)).observe(document.documentElement, { childList: true, subtree: true });

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
