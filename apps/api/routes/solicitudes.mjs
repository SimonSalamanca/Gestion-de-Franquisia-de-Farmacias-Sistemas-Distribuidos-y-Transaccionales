import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import {
  buscarMedicamentos,
  cambiarEstado,
  crearSolicitud,
  detalleSolicitud,
  idAlertaDe,
  idSolicitudDe,
  listarSolicitudes,
  sugerenciaDeAlerta,
} from "../solicitudes.mjs";
import { local } from "../db.mjs";
import { listarRecepciones } from "../inventario/lotes.mjs";

// HU-13: solicitudes de reabastecimiento (RF-09). Solo nodo local: se generan y se consultan sin conexión con el central.
// Todas exigen PROVEEDOR_GESTIONAR (administrador de tienda). Las escrituras llevan Idempotency-Key.
export default function solicitudes(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "PROVEEDOR_GESTIONAR");
  const claveDe = (req) => req.headers["idempotency-key"];

  router.get("/api/local/solicitudes", async (req, res, { url }) => {
    await sesionDe(req);
    return send(res, 200, await listarSolicitudes(Object.fromEntries(url.searchParams)));
  });

  router.get("/api/local/solicitudes/medicamentos", async (req, res, { url }) => {
    await sesionDe(req);
    return send(res, 200, await buscarMedicamentos(Object.fromEntries(url.searchParams)));
  });

  router.get(/^\/api\/local\/solicitudes\/(\d+)$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await detalleSolicitud(local, idSolicitudDe(params[0])));
  });

  // HU-14: la recepción queda vinculada a la solicitud original: sus recepciones, lotes, responsables y diferencias.
  router.get(/^\/api\/local\/solicitudes\/(\d+)\/recepciones$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await listarRecepciones(local, idSolicitudDe(params[0])));
  });

  // Criterio 2: lo que sale de la alerta (producto, cantidad sugerida, proveedor habitual) para no volver a ingresarlo.
  router.get(/^\/api\/local\/alertas\/(\d+)\/solicitud$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await sugerenciaDeAlerta(idAlertaDe(params[0])));
  });

  router.post("/api/local/solicitudes", async (req, res) => {
    const sesion = await sesionDe(req);
    const resultado = await crearSolicitud(sesion, claveDe(req), await readBody(req));
    return send(res, resultado.status, resultado.body);
  });

  router.post(/^\/api\/local\/solicitudes\/(\d+)\/(enviar|cancelar)$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    const resultado = await cambiarEstado(sesion, claveDe(req), idSolicitudDe(params[0]), params[1], await readBody(req));
    return send(res, resultado.status, resultado.body);
  });
}
