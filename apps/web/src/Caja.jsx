import { useEffect, useState } from "react";
import { api } from "./api.js";
import Ventas from "./Ventas.jsx";
import Recetas from "./Recetas.jsx";
import Historial from "./Historial.jsx";

// Módulo "Ventas y recetas" del POS: HU-08 (venta y factura), HU-09 (historial y reimpresión) y HU-12 (recetas). Las dos pestañas
// quedan montadas para no perder el carrito al validar una receta.
export default function Caja({ session }) {
  const [pestana, setPestana] = useState("venta");
  // HU-11: con la caja cerrada (cierre del periodo) no se vende; se avisa antes de armar la venta.
  const [caja, setCaja] = useState(null);
  useEffect(() => {
    let vivo = true;
    const consultar = () => api("/api/local/caja/estado", { token: session.token }).then((r) => vivo && r.ok && setCaja(r.data));
    consultar();
    const timer = setInterval(consultar, 15000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [session.token]);
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Ventas y recetas</h2>
        <div className="pestanas" role="tablist">
          <button role="tab" aria-selected={pestana === "venta"} className={pestana === "venta" ? "active" : ""} onClick={() => setPestana("venta")}>Venta</button>
          <button role="tab" aria-selected={pestana === "recetas"} className={pestana === "recetas" ? "active" : ""} onClick={() => setPestana("recetas")}>Recetas</button>
          <button role="tab" aria-selected={pestana === "historial"} className={pestana === "historial" ? "active" : ""} onClick={() => setPestana("historial")}>Historial</button>
        </div>
      </header>
      {caja && !caja.abierta && (
        <div className="error" role="alert">
          La caja está cerrada: no se pueden registrar ventas hasta que un administrador abra un nuevo periodo (módulo Cierre de caja).
        </div>
      )}
      <div hidden={pestana !== "venta"}><Ventas session={session} /></div>
      <div hidden={pestana !== "recetas"}><Recetas session={session} incrustada /></div>
      {pestana === "historial" && <Historial session={session} />}
    </article>
  );
}
