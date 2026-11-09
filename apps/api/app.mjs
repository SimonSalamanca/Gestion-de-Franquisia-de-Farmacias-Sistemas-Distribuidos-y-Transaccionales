import http from "http";
import { crearRouter, send } from "./http.mjs";
import sistema from "./routes/sistema.mjs";
import auth from "./routes/auth.mjs";
import inventario from "./routes/inventario.mjs";
import lotes from "./routes/lotes.mjs";
import tiendas from "./routes/tiendas.mjs";
import empleados from "./routes/empleados.mjs";
import precios from "./routes/precios.mjs";
import recetas from "./routes/recetas.mjs";
import ventas from "./routes/ventas.mjs";
import alertas from "./routes/alertas.mjs";
import historial from "./routes/historial.mjs";
import devoluciones from "./routes/devoluciones.mjs";
import reportes from "./routes/reportes.mjs";
import vistaRed from "./routes/vista-red.mjs";
import proveedores from "./routes/proveedores.mjs";
import solicitudes from "./routes/solicitudes.mjs";
import caja from "./routes/caja.mjs";
import traslados from "./routes/traslados.mjs";
import { ErrorNegocio } from "./errores.mjs";

// Cada módulo de rutas registra las suyas. Para una HU nueva: routes/<dominio>.mjs y agregarlo aquí.
// Separado de server.mjs para que las pruebas HTTP levanten el mismo servidor sin el ciclo de sync.
const router = crearRouter()
  .usar(sistema)
  .usar(auth)
  .usar(inventario)
  .usar(lotes)
  .usar(tiendas)
  .usar(empleados)
  .usar(precios)
  .usar(recetas)
  .usar(ventas)
  .usar(alertas)
  .usar(historial)
  .usar(devoluciones)
  .usar(reportes)
  .usar(vistaRed)
  .usar(proveedores)
  .usar(solicitudes)
  .usar(caja)
  .usar(traslados);

export function crearServidor() {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, null);
    const url = new URL(req.url, "http://localhost");
    try {
      const ruta = router.buscar(req.method, url.pathname);
      if (!ruta) return send(res, 404, { mensaje: "Ruta no encontrada" });
      return await ruta.handler(req, res, { url, params: ruta.params });
    } catch (error) {
      if (error instanceof ErrorNegocio) return send(res, error.status, error.body);
      const status = error.status || 500;
      if (status === 500) console.error(error);
      return send(res, status, { mensaje: status === 400 ? "JSON inválido" : "Error interno" });
    }
  });
}
