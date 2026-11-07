import { useState } from "react";
import Ventas from "./Ventas.jsx";
import Recetas from "./Recetas.jsx";
import Historial from "./Historial.jsx";

// Módulo "Ventas y recetas" del POS: HU-08 (venta y factura), HU-09 (historial y reimpresión) y HU-12 (recetas). Las dos pestañas
// quedan montadas para no perder el carrito al validar una receta.
export default function Caja({ session }) {
  const [pestana, setPestana] = useState("venta");
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Ventas y recetas</h2>
        <div className="row">
          <button className={pestana === "venta" ? "primary" : "ghost"} onClick={() => setPestana("venta")}>Venta</button>
          <button className={pestana === "recetas" ? "primary" : "ghost"} onClick={() => setPestana("recetas")}>Recetas</button>
          <button className={pestana === "historial" ? "primary" : "ghost"} onClick={() => setPestana("historial")}>Historial</button>
        </div>
      </header>
      <div hidden={pestana !== "venta"}><Ventas session={session} /></div>
      <div hidden={pestana !== "recetas"}><Recetas session={session} incrustada /></div>
      {pestana === "historial" && <Historial session={session} />}
    </article>
  );
}
