import { useEffect, useState } from "react";
import Inventario from "./Inventario.jsx";
import Alertas from "./Alertas.jsx";

// Módulo "Inventario" del POS: existencias (HU-01) y alertas de stock y caducidad (HU-04). Las dos pestañas quedan
// montadas para no perder la búsqueda. `pedido` lo envía el indicador de la barra superior para abrir las alertas.
export default function InventarioAlertas({ session, ultimaSync, pedido }) {
  const [pestana, setPestana] = useState(pedido?.pestana ?? "existencias");
  useEffect(() => {
    if (pedido?.pestana) setPestana(pedido.pestana);
  }, [pedido]);
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Inventario</h2>
        <div className="row">
          <button className={pestana === "existencias" ? "primary" : "ghost"} onClick={() => setPestana("existencias")}>Existencias</button>
          <button className={pestana === "alertas" ? "primary" : "ghost"} onClick={() => setPestana("alertas")}>Alertas</button>
        </div>
      </header>
      <div hidden={pestana !== "existencias"}><Inventario session={session} ultimaSync={ultimaSync} incrustada /></div>
      {pestana === "alertas" && <Alertas session={session} />}
    </article>
  );
}
