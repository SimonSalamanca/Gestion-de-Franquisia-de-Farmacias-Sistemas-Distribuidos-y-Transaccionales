import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { anularFactura, consultarDevoluciones, devolverParcial } from "../devoluciones.mjs";

// HU-10: anulación total y devolución parcial. Solo nodo local: funciona con o sin conexión con el central.
// Todas exigen FACTURA_ANULAR (el permiso se relee en cada request); sin él, 403 y queda ACCESO_DENEGADO en la auditoría.
// Anular y devolver llevan Idempotency-Key y motivo obligatorio.
export default function devoluciones(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "FACTURA_ANULAR");

  router.get(/^\/api\/local\/facturas\/(\d+)\/devoluciones$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await consultarDevoluciones(Number(params[0])));
  });

  router.post(/^\/api\/local\/facturas\/(\d+)\/anular$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    const r = await anularFactura(sesion, req.headers["idempotency-key"], Number(params[0]), await readBody(req));
    return send(res, r.status, r.body);
  });

  router.post(/^\/api\/local\/facturas\/(\d+)\/devolver$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    const r = await devolverParcial(sesion, req.headers["idempotency-key"], Number(params[0]), await readBody(req));
    return send(res, r.status, r.body);
  });
}
