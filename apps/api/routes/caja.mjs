import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar, sesionDe } from "../auth.mjs";
import { ErrorNegocio } from "../errores.mjs";
import { local } from "../db.mjs";
import { abrirCaja, cerrarCaja, detalleCierre, estadoCaja, idCierreDe, listarCierres, resumenCaja } from "../caja.mjs";

// HU-11: cierre de caja (RF-07). Solo nodo local: funciona igual con o sin conexión con el central (RNF-04).
// Cerrar, abrir, resumir y consultar cierres exigen CAJA_CERRAR (administrador de tienda). El estado de la caja
// (abierta o cerrada) también lo ve quien registra ventas, para avisar antes de intentar vender. Cerrar y abrir llevan
// Idempotency-Key.
export default function caja(router) {
  const sesionAdmin = (req) => autorizar(tokenDe(req), "local", "CAJA_CERRAR");
  const claveDe = (req) => req.headers["idempotency-key"];

  router.get("/api/local/caja/estado", async (req, res) => {
    const sesion = await sesionDe(tokenDe(req), "local");
    if (!sesion) throw new ErrorNegocio(401, "SESION", "Sesión inválida o expirada");
    if (!sesion.permisos.includes("VENTA_REGISTRAR") && !sesion.permisos.includes("CAJA_CERRAR")) {
      await autorizar(tokenDe(req), "local", "CAJA_CERRAR");
    }
    return send(res, 200, await estadoCaja(local));
  });

  // Criterio 1: el total del periodo por método de pago y por empleado, antes de contar.
  router.get("/api/local/caja/resumen", async (req, res) => {
    await sesionAdmin(req);
    return send(res, 200, await resumenCaja());
  });

  router.post("/api/local/caja/cierre", async (req, res) => {
    const sesion = await sesionAdmin(req);
    const resultado = await cerrarCaja(sesion, claveDe(req), await readBody(req));
    return send(res, resultado.status, resultado.body);
  });

  router.post("/api/local/caja/apertura", async (req, res) => {
    const sesion = await sesionAdmin(req);
    const resultado = await abrirCaja(sesion, claveDe(req), await readBody(req));
    return send(res, resultado.status, resultado.body);
  });

  router.get("/api/local/caja/cierres", async (req, res) => {
    await sesionAdmin(req);
    return send(res, 200, await listarCierres());
  });

  router.get(/^\/api\/local\/caja\/cierres\/(\d+)$/, async (req, res, { params }) => {
    await sesionAdmin(req);
    return send(res, 200, await detalleCierre(local, idCierreDe(params[0])));
  });
}
