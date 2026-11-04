import { send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { evaluarAlertas, listarAlertas, marcarVista, resumenAlertas } from "../alertas.mjs";

// HU-04: panel de alertas (RF-03). Solo nodo local; funciona sin conexión con el central. Lo ve todo empleado que pueda
// consultar el inventario (cajero, administradores): no hay permiso nuevo.
export default function alertas(router) {
  const sesionDe = (req) => autorizar(tokenDe(req), "local", "INVENTARIO_CONSULTAR");

  // Al abrir el panel se evalúa antes de listar, para que nunca muestre datos viejos. Un fallo de la evaluación no
  // tumba la consulta: se muestra lo último calculado.
  router.get("/api/local/alertas", async (req, res, { url }) => {
    await sesionDe(req);
    await evaluarAlertas().catch((error) => console.error("alertas", error.message));
    return send(res, 200, await listarAlertas(Object.fromEntries(url.searchParams)));
  });

  router.get("/api/local/alertas/resumen", async (req, res) => {
    await sesionDe(req);
    return send(res, 200, await resumenAlertas());
  });

  router.post(/^\/api\/local\/alertas\/(\d+)\/vista$/, async (req, res, { params }) => {
    const sesion = await sesionDe(req);
    return send(res, 200, await marcarVista(sesion, Number(params[0])));
  });
}
