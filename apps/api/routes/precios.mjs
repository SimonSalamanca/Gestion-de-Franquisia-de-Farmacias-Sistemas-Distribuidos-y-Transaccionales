import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { central, local } from "../db.mjs";
import { enCentral } from "../empleados.mjs";
import { corregirPrecio, historial, idMedicamentoDe, idPrecioDe, listarPrecios, registrarPrecio } from "../precios.mjs";

// HU-03: precios de red con historial (RF-02). Mismas rutas en los dos nodos.
// Consultar: INVENTARIO_CONSULTAR (también el cajero). En el POS se lee la réplica local: funciona offline.
// Registrar y corregir: PRECIO_GESTIONAR + Idempotency-Key; van al central (503 sin conexión).
export default function precios(router) {
  const NODO = "(local|central)";
  const claveDe = (req) => req.headers["idempotency-key"];

  async function sesionPara(req, nodo, codigo) {
    if (nodo === "local") return autorizar(tokenDe(req), "local", codigo);
    return enCentral(() => autorizar(tokenDe(req), "central", codigo));
  }
  // Lecturas: el POS usa su base; la consola, el central (que entonces debe estar alcanzable).
  const leer = (nodo, fn) => (nodo === "local" ? fn(local) : enCentral(() => fn(central)));
  const responder = (res, resultado) => send(res, resultado.status ?? 200, resultado.body ?? resultado);

  router.get(new RegExp(`^/api/${NODO}/precios$`), async (req, res, { params, url }) => {
    await sesionPara(req, params[0], "INVENTARIO_CONSULTAR");
    return responder(res, await leer(params[0], (db) => listarPrecios(db, Object.fromEntries(url.searchParams))));
  });

  router.get(new RegExp(`^/api/${NODO}/precios/(\\d+)$`), async (req, res, { params }) => {
    await sesionPara(req, params[0], "INVENTARIO_CONSULTAR");
    return responder(res, await leer(params[0], (db) => historial(db, idMedicamentoDe(params[1]))));
  });

  router.post(new RegExp(`^/api/${NODO}/precios/(\\d+)$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "PRECIO_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => registrarPrecio(sesion.id_empleado, claveDe(req), idMedicamentoDe(params[1]), body)));
  });

  router.patch(new RegExp(`^/api/${NODO}/precios/registro/(\\d+)$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "PRECIO_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => corregirPrecio(sesion.id_empleado, claveDe(req), idPrecioDe(params[1]), body)));
  });
}
