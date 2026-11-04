import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { local } from "../db.mjs";
import { calcularVenta, facturaDe, metodosDePago, registrarVenta } from "../ventas.mjs";

// HU-08: venta y factura (RF-06). Solo nodo local: funciona igual con o sin conexión con el central (RNF-04).
// Todas exigen VENTA_REGISTRAR; el permiso se relee en cada request. Registrar lleva Idempotency-Key.
export default function ventas(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "VENTA_REGISTRAR");

  router.get("/api/local/ventas/metodos-pago", async (req, res) => {
    await sesionDe(req);
    return send(res, 200, await metodosDePago());
  });

  // Vista previa con el mismo cálculo de la venta: no escribe ni bloquea lotes.
  router.post("/api/local/ventas/calcular", async (req, res) => {
    await sesionDe(req);
    const resultado = await calcularVenta(await readBody(req));
    return send(res, resultado.status, resultado.body);
  });

  router.post("/api/local/ventas", async (req, res) => {
    const sesion = await sesionDe(req);
    const body = await readBody(req);
    const resultado = await registrarVenta(sesion, req.headers["idempotency-key"], body);
    return send(res, resultado.status, resultado.body);
  });

  router.get(/^\/api\/local\/ventas\/(\d+)$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await facturaDe(local, Number(params[0])));
  });
}
