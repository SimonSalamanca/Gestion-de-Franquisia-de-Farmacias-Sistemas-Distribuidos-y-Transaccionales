import { useState } from "react";
import Proveedores from "./Proveedores.jsx";
import Solicitudes from "./Solicitudes.jsx";

// Módulo "Proveedores" (HU-13). En el POS: solicitudes de reabastecimiento y registro de proveedores. En la consola de red:
// solo el registro de proveedores (las solicitudes son de cada tienda y viven en su base).
export default function Abastecimiento({ session }) {
  const hayTienda = session.nodo === "local";
  const [pestana, setPestana] = useState(hayTienda ? "solicitudes" : "proveedores");
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Proveedores</h2>
        {hayTienda && (
          <div className="pestanas" role="tablist">
            <button role="tab" aria-selected={pestana === "solicitudes"} className={pestana === "solicitudes" ? "active" : ""} onClick={() => setPestana("solicitudes")}>Solicitudes</button>
            <button role="tab" aria-selected={pestana === "proveedores"} className={pestana === "proveedores" ? "active" : ""} onClick={() => setPestana("proveedores")}>Proveedores</button>
          </div>
        )}
      </header>
      {hayTienda && pestana === "solicitudes" && <Solicitudes session={session} />}
      {pestana === "proveedores" && <Proveedores session={session} />}
    </article>
  );
}
