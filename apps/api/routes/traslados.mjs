import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { local, runtime, withTx } from "../db.mjs";
import { invalido } from "../errores.mjs";
import { enCentral } from "../empleados.mjs";
import { detalleTraslado, idTrasladoDe, listarTraslados, origenesPara, solicitarTraslado } from "../traslados.mjs";
import { listarTrasladosLocales, registrarSolicitudLocal } from "../traslados-tienda.mjs";

// HU-17: traslados entre tiendas (RF-26). El administrador de la tienda (INVENTARIO_GESTIONAR) solicita desde el POS.
// Solicitar y ver de qué tiendas se puede pedir exigen conexión con el central (503 sin ella): es quien coordina la
// operación entre las dos tiendas. La lista de traslados de la tienda se lee de su base y funciona sin conexión.
export default function traslados(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "INVENTARIO_GESTIONAR");

  router.get("/api/local/traslados", async (req, res) => {
    await sesionDe(req);
    return send(res, 200, await listarTrasladosLocales(local));
  });

  router.get("/api/local/traslados/origenes", async (req, res, { url }) => {
    await sesionDe(req);
    const id = Number(url.searchParams.get("id_medicamento"));
    if (!Number.isInteger(id) || id < 1) throw invalido("Indique el medicamento", { campo: "id_medicamento" });
    return send(res, 200, await enCentral(() => origenesPara(runtime.tiendaId, id)));
  });

  router.post("/api/local/traslados", async (req, res) => {
    const sesion = await sesionDe(req);
    const body = await readBody(req);
    const resultado = await enCentral(() => solicitarTraslado(sesion, req.headers["idempotency-key"], body));
    // El central ya aceptó: la tienda guarda su copia (rol DESTINO, PENDIENTE) y su auditoría. Si esto fallara, el primer
    // TRASLADO_ESTADO del central la crea igual.
    await withTx(local, (client) => registrarSolicitudLocal(client, resultado.body, sesion.id_empleado)).catch((error) =>
      console.error("traslado local", error.message),
    );
    return send(res, resultado.status, resultado.body);
  });

  // El estado según el central (quien coordina), para ver el detalle con los lotes.
  router.get(/^\/api\/local\/traslados\/(\d+)\/red$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await enCentral(() => detalleTraslado(idTrasladoDe(params[0]))));
  });

  // Consola de red: todos los traslados de la cadena.
  router.get("/api/central/traslados", async (req, res) => {
    await enCentral(() => autorizar(tokenDe(req), "central", "RED_VISIBILIDAD"));
    return send(res, 200, await enCentral(() => listarTraslados()));
  });
}
