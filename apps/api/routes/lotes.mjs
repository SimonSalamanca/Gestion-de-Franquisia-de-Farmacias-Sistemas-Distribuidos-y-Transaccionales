import { local, runtime } from "../db.mjs";
import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { conIdempotencia } from "../idempotencia.mjs";
import {
  ajustarLote,
  detalleMedicamento,
  historialLote,
  listarLotes,
  listarPedidosPendientes,
  listarProveedores,
  recibirPedido,
  registrarLote,
} from "../inventario/lotes.mjs";

// HU-02: lotes, recepción, ajustes e historial (RF-02, RF-04, RF-23).
// Consultar: INVENTARIO_CONSULTAR. Escribir: INVENTARIO_GESTIONAR + Idempotency-Key.
export default function lotes(router) {
  const sesionCon = (req, codigo) => autorizar(tokenDe(req), "local", codigo);

  // Escritura idempotente: la operación, su auditoría y el registro de la clave van en la misma transacción.
  async function escribir(req, res, operacion, status, fn) {
    const sesion = await sesionCon(req, "INVENTARIO_GESTIONAR");
    const body = await readBody(req);
    const ctx = { idEmpleado: sesion.id_empleado, idTienda: runtime.tiendaId };
    const resultado = await conIdempotencia(
      local,
      { key: req.headers["idempotency-key"], operacion, idEmpleado: sesion.id_empleado, body },
      async (client) => ({ status, body: await fn(client, body, ctx) }),
    );
    return send(res, resultado.status, resultado.body);
  }

  router.post("/api/local/lotes", (req, res) =>
    escribir(req, res, "LOTE_REGISTRAR", 201, (client, body, ctx) => registrarLote(client, body, ctx)),
  );

  router.post(/^\/api\/local\/lotes\/(\d+)\/ajustes$/, (req, res, { params }) =>
    escribir(req, res, `LOTE_AJUSTAR:${params[0]}`, 200, (client, body, ctx) => ajustarLote(client, Number(params[0]), body, ctx)),
  );

  router.post(/^\/api\/local\/pedidos\/(\d+)\/recepcion$/, (req, res, { params }) =>
    escribir(req, res, `PEDIDO_RECIBIR:${params[0]}`, 200, (client, body, ctx) => recibirPedido(client, Number(params[0]), body, ctx)),
  );

  router.get("/api/local/lotes", async (req, res, { url }) => {
    await sesionCon(req, "INVENTARIO_CONSULTAR");
    return send(res, 200, await listarLotes(local, Object.fromEntries(url.searchParams)));
  });

  router.get(/^\/api\/local\/lotes\/(\d+)\/movimientos$/, async (req, res, { params }) => {
    await sesionCon(req, "INVENTARIO_CONSULTAR");
    return send(res, 200, await historialLote(local, Number(params[0])));
  });

  router.get(/^\/api\/local\/medicamentos\/(\d+)$/, async (req, res, { params }) => {
    await sesionCon(req, "INVENTARIO_CONSULTAR");
    return send(res, 200, await detalleMedicamento(local, Number(params[0])));
  });

  router.get("/api/local/proveedores", async (req, res) => {
    await sesionCon(req, "INVENTARIO_GESTIONAR");
    return send(res, 200, await listarProveedores(local));
  });

  router.get("/api/local/pedidos", async (req, res) => {
    await sesionCon(req, "INVENTARIO_GESTIONAR");
    return send(res, 200, await listarPedidosPendientes(local));
  });
}
