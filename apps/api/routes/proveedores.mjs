import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar, sesionDe } from "../auth.mjs";
import { ErrorNegocio } from "../errores.mjs";
import { central, local } from "../db.mjs";
import { enCentral } from "../empleados.mjs";
import { crearProveedor, detalleProveedor, editarProveedor, idProveedorDe, listarProveedores } from "../proveedores.mjs";

// HU-13: registro de proveedores (RF-09). Mismas rutas en los dos nodos.
// Consultar: PROVEEDOR_GESTIONAR. En el POS se lee la réplica local: funciona sin conexión. El selector de proveedores de
// Lotes y recepción (HU-02) sigue funcionando con INVENTARIO_GESTIONAR y solo ve los activos.
// Registrar y editar: PROVEEDOR_GESTIONAR + Idempotency-Key; van al central (503 sin conexión).
export default function proveedores(router) {
  const NODO = "(local|central)";
  const claveDe = (req) => req.headers["idempotency-key"];

  async function sesionPara(req, nodo, codigo) {
    if (nodo === "local") return autorizar(tokenDe(req), "local", codigo);
    return enCentral(() => autorizar(tokenDe(req), "central", codigo));
  }
  const leer = (nodo, fn) => (nodo === "local" ? fn(local) : enCentral(() => fn(central)));
  const responder = (res, resultado) => send(res, resultado.status ?? 200, resultado.body ?? resultado);

  router.get(new RegExp(`^/api/${NODO}/proveedores$`), async (req, res, { params, url }) => {
    const nodo = params[0];
    const query = Object.fromEntries(url.searchParams);
    if (nodo === "local") {
      // Sin `detalle` es la lista de HU-02 (selector de Lotes y recepción): un arreglo con los proveedores activos, para
      // quien gestiona inventario o proveedores. Con `detalle=1` es el registro completo de HU-13 (PROVEEDOR_GESTIONAR).
      if (query.detalle === "1") {
        await sesionPara(req, nodo, "PROVEEDOR_GESTIONAR");
        return responder(res, await listarProveedores(local, query));
      }
      const sesion = await sesionDe(tokenDe(req), "local");
      if (!sesion) throw new ErrorNegocio(401, "SESION", "Sesión inválida o expirada");
      if (!sesion.permisos.includes("PROVEEDOR_GESTIONAR")) await autorizar(tokenDe(req), "local", "INVENTARIO_GESTIONAR");
      return send(res, 200, (await listarProveedores(local, { ...query, incluir_inactivos: "" })).proveedores);
    }
    await sesionPara(req, nodo, "PROVEEDOR_GESTIONAR");
    return responder(res, await leer(nodo, (db) => listarProveedores(db, query)));
  });

  router.get(new RegExp(`^/api/${NODO}/proveedores/(\\d+)$`), async (req, res, { params }) => {
    await sesionPara(req, params[0], "PROVEEDOR_GESTIONAR");
    return responder(res, await leer(params[0], (db) => detalleProveedor(db, idProveedorDe(params[1]))));
  });

  router.post(new RegExp(`^/api/${NODO}/proveedores$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "PROVEEDOR_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => crearProveedor(sesion.id_empleado, claveDe(req), body)));
  });

  router.patch(new RegExp(`^/api/${NODO}/proveedores/(\\d+)$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "PROVEEDOR_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => editarProveedor(sesion.id_empleado, claveDe(req), idProveedorDe(params[1]), body)));
  });
}
