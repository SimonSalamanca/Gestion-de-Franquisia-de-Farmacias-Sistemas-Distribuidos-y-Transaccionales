import { send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { buscarClientes, buscarFacturas, reimprimirFactura, resumenCliente, verFactura } from "../historial.mjs";

// HU-09: historial de compras y reimpresión. Solo nodo local (las facturas viven en la tienda), así que funciona
// sin conexión con el central. Exigen VENTA_REGISTRAR: lo tienen el cajero y los administradores; sin él, 403 y
// queda ACCESO_DENEGADO en la auditoría. El permiso se relee en cada request.
export default function historial(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "VENTA_REGISTRAR");

  router.get("/api/local/historial/clientes", async (req, res, { url }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await buscarClientes(sesion, Object.fromEntries(url.searchParams)));
  });

  router.get(/^\/api\/local\/historial\/clientes\/(\d+)$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await resumenCliente(sesion, Number(params[0])));
  });

  router.get("/api/local/historial/facturas", async (req, res, { url }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await buscarFacturas(sesion, Object.fromEntries(url.searchParams)));
  });

  router.get(/^\/api\/local\/historial\/facturas\/(\d+)$/, async (req, res, { params }) => {
    await sesionDe(req);
    return send(res, 200, await verFactura(Number(params[0])));
  });

  // POST porque deja huella en la auditoría; no modifica la factura.
  router.post(/^\/api\/local\/historial\/facturas\/(\d+)\/reimprimir$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await reimprimirFactura(sesion, Number(params[0])));
  });
}
