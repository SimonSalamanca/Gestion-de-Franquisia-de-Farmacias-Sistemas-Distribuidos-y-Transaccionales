import { send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { ErrorNegocio } from "../errores.mjs";
import { estadoReal, link } from "../sync.mjs";
import { comparativoRed, reporteTienda } from "../reportes.mjs";

// HU-05: reportes de solo lectura (sin Idempotency-Key). Tienda: nodo local, REPORTE_TIENDA_VER, sin depender del
// central. Red: nodo central, REPORTE_CONSOLIDADO_VER; sin conexión responde 503 con la última sincronización.
export default function reportes(router) {
  router.get("/api/local/reportes/tienda", async (req, res, { url }) => {
    await autorizar(tokenDe(req), "local", "REPORTE_TIENDA_VER");
    return send(res, 200, await reporteTienda(Object.fromEntries(url.searchParams)));
  });

  router.get("/api/central/reportes/comparativo", async (req, res, { url }) => {
    if (estadoReal() === "offline") {
      throw new ErrorNegocio(503, "SIN_CONEXION", "sin conexión con el nodo central", {
        estado_real: "offline",
        forzado: link.force,
        ultima_sync: link.ultimaSync,
      });
    }
    await autorizar(tokenDe(req), "central", "REPORTE_CONSOLIDADO_VER");
    return send(res, 200, await comparativoRed(Object.fromEntries(url.searchParams)));
  });
}
