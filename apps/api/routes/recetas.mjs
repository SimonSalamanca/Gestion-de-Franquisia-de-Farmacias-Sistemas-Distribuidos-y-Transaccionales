import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { local } from "../db.mjs";
import { enCentral } from "../empleados.mjs";
import { emitirReceta, liberarReceta, listarRecetasEmitidas, medicamentosControlados, politicaReceta, validarCodigo } from "../recetas-red.mjs";
import { evaluarReceta, listarRecetas, medicamentosConReceta, obtenerReceta, recetasDeFactura, registrarReceta } from "../recetas.mjs";

// HU-12: recetas médicas (RF-08). Solo en el nodo local: funcionan igual con o sin conexión al central.
// Todas exigen VENTA_REGISTRAR (el cajero registra la receta al vender). Registrar lleva Idempotency-Key.
// El documento y el contacto del paciente solo salen completos para quien tiene AUDITORIA_CONSULTAR.
// Un medicamento controlado se valida con el código de la receta contra el central (POST /recetas/codigo): sin
// conexión responde 503 y no se despacha. El registro manual (POST /recetas) queda apagado por política.
// Central: la consola (RED_CONTROL) emite recetas simuladas, como si las enviara la EPS.
export default function recetas(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "VENTA_REGISTRAR");
  const sesionRed = (req) => enCentral(() => autorizar(tokenDe(req), "central", "RED_CONTROL"));

  router.get("/api/local/recetas/politica", async (req, res) => {
    await sesionDe(req);
    return send(res, 200, await politicaReceta());
  });

  router.post("/api/local/recetas/codigo", async (req, res) => {
    const sesion = await sesionDe(req);
    const body = await readBody(req);
    const resultado = await validarCodigo(sesion, body.codigo);
    return send(res, resultado.status, resultado.body);
  });

  router.post(/^\/api\/local\/recetas\/(\d+)\/liberar$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    const resultado = await liberarReceta(sesion, Number(params[0]));
    return send(res, resultado.status, resultado.body);
  });

  router.post("/api/central/recetas-emitidas", async (req, res) => {
    const sesion = await sesionRed(req);
    const body = await readBody(req);
    const resultado = await enCentral(() => emitirReceta(sesion, req.headers["idempotency-key"], body));
    return send(res, resultado.status, resultado.body);
  });

  router.get("/api/central/recetas-emitidas/medicamentos", async (req, res) => {
    await sesionRed(req);
    return send(res, 200, await enCentral(() => medicamentosControlados()));
  });

  router.get("/api/central/recetas-emitidas", async (req, res, { url }) => {
    await sesionRed(req);
    return send(res, 200, await enCentral(() => listarRecetasEmitidas(Object.fromEntries(url.searchParams))));
  });

  router.get("/api/local/recetas/medicamentos", async (req, res, { url }) => {
    await sesionDe(req);
    return send(res, 200, await medicamentosConReceta(Object.fromEntries(url.searchParams)));
  });

  // Qué líneas de una venta piden receta y si la indicada sirve; no modifica nada.
  router.post("/api/local/recetas/validar", async (req, res) => {
    await sesionDe(req);
    const body = await readBody(req);
    return send(res, 200, await evaluarReceta(local, { idReceta: body.id_receta, idCliente: body.id_cliente, lineas: body.lineas }));
  });

  router.get(/^\/api\/local\/recetas\/factura\/(\d+)$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await recetasDeFactura(sesion, Number(params[0])));
  });

  router.get("/api/local/recetas", async (req, res, { url }) => {
    await sesionDe(req);
    return send(res, 200, await listarRecetas(Object.fromEntries(url.searchParams)));
  });

  router.get(/^\/api\/local\/recetas\/(\d+)$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await obtenerReceta(sesion, Number(params[0])));
  });

  router.post("/api/local/recetas", async (req, res) => {
    const sesion = await sesionDe(req);
    const body = await readBody(req);
    const resultado = await registrarReceta(sesion, req.headers["idempotency-key"], body);
    return send(res, resultado.status, resultado.body);
  });
}
