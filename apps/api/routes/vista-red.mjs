import { send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { ErrorNegocio } from "../errores.mjs";
import { estadoReal, link } from "../sync.mjs";
import { inventarioRed, listarCategoriasRed, listarTiendasRed, vistaConsolidada } from "../vista-red.mjs";

// HU-16: vista consolidada de la red. Solo nodo central, permiso RED_VISIBILIDAD; solo lectura (sin Idempotency-Key).
// Sin conexión con el central responde 503 con la última sincronización.
export default function vistaRed(router) {
  const sesion = async (req) => {
    if (estadoReal() === "offline") {
      throw new ErrorNegocio(503, "SIN_CONEXION", "sin conexión con el nodo central", {
        estado_real: "offline",
        forzado: link.force,
        ultima_sync: link.ultimaSync,
      });
    }
    return autorizar(tokenDe(req), "central", "RED_VISIBILIDAD");
  };
  const consulta = (url) => Object.fromEntries(url.searchParams);

  router.get("/api/central/red/consolidado", async (req, res, { url }) => {
    await sesion(req);
    return send(res, 200, await vistaConsolidada(consulta(url)));
  });

  router.get("/api/central/red/inventario", async (req, res, { url }) => {
    await sesion(req);
    return send(res, 200, await inventarioRed(consulta(url)));
  });

  router.get("/api/central/red/filtros", async (req, res) => {
    await sesion(req);
    const [categorias, tiendas] = await Promise.all([listarCategoriasRed(), listarTiendasRed()]);
    return send(res, 200, { ...categorias, ...tiendas });
  });
}
