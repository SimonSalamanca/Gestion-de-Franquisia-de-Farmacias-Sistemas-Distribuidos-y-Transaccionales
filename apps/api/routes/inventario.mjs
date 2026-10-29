import { runtime } from "../db.mjs";
import { send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { buscar, existenciasEnRed, listarCategorias, listarTiendas } from "../inventario/busqueda.mjs";

// HU-01: búsqueda y localización de existencias (RF-01, RF-03). Permiso INVENTARIO_CONSULTAR.
export default function inventario(router) {
  const contexto = async (req) => {
    const sesion = await autorizar(tokenDe(req), "local", "INVENTARIO_CONSULTAR");
    return { idTienda: runtime.tiendaId, idEmpleado: sesion.id_empleado };
  };

  router.get("/api/local/inventario/buscar", async (req, res, { url }) => {
    const ctx = await contexto(req);
    return send(res, 200, await buscar(Object.fromEntries(url.searchParams), ctx));
  });

  router.get(/^\/api\/local\/inventario\/red\/(\d+)$/, async (req, res, { url, params }) => {
    const ctx = await contexto(req);
    return send(res, 200, await existenciasEnRed(params[0], Object.fromEntries(url.searchParams), ctx));
  });

  router.get("/api/local/inventario/tiendas", async (req, res) => {
    const ctx = await contexto(req);
    return send(res, 200, await listarTiendas(ctx));
  });

  router.get("/api/local/inventario/categorias", async (req, res) => {
    await contexto(req);
    return send(res, 200, await listarCategorias());
  });
}
