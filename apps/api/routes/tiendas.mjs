import { readBody, send, tokenDe } from "../http.mjs";
import {
  crearTienda,
  desactivarTienda,
  disponibilidad,
  editarTienda,
  guardarUmbral,
  listarMedicamentos,
  listarTiendas,
  listarUmbrales,
  reporteConsolidado,
} from "../tiendas.mjs";

// HU-15: administración de tiendas de la red (RF-10). Solo nodo central; el POS no las llama.
// Gestionar: TIENDA_GESTIONAR + Idempotency-Key en las escrituras. Cruce de red: RED_VISIBILIDAD.
export default function tiendas(router) {
  const responder = (res, resultado) => send(res, resultado.status, resultado.body);
  const claveDe = (req) => req.headers["idempotency-key"];

  router.get("/api/central/tiendas", async (req, res) => responder(res, await listarTiendas(tokenDe(req))));

  router.post("/api/central/tiendas", async (req, res) => {
    const body = await readBody(req);
    return responder(res, await crearTienda(tokenDe(req), claveDe(req), body));
  });

  router.patch(/^\/api\/central\/tiendas\/(\d+)$/, async (req, res, { params }) => {
    const body = await readBody(req);
    return responder(res, await editarTienda(tokenDe(req), claveDe(req), Number(params[0]), body));
  });

  router.post(/^\/api\/central\/tiendas\/(\d+)\/desactivar$/, async (req, res, { params }) => {
    const body = await readBody(req);
    return responder(res, await desactivarTienda(tokenDe(req), claveDe(req), Number(params[0]), body));
  });

  router.get(/^\/api\/central\/tiendas\/(\d+)\/umbrales$/, async (req, res, { params }) =>
    responder(res, await listarUmbrales(tokenDe(req), Number(params[0]))),
  );

  router.put(/^\/api\/central\/tiendas\/(\d+)\/umbrales$/, async (req, res, { params }) => {
    const body = await readBody(req);
    return responder(res, await guardarUmbral(tokenDe(req), claveDe(req), Number(params[0]), body));
  });

  router.get("/api/central/medicamentos", async (req, res) => responder(res, await listarMedicamentos(tokenDe(req))));

  // Criterio 4: lo que ve la red excluye tiendas desactivadas.
  router.get("/api/central/disponibilidad", async (req, res, { url }) =>
    responder(res, await disponibilidad(tokenDe(req), url.searchParams)),
  );

  router.get("/api/central/reportes/consolidado", async (req, res) =>
    responder(res, await reporteConsolidado(tokenDe(req))),
  );
}
