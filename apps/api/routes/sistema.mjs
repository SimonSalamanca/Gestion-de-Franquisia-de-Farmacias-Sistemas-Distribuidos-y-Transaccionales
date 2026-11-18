import { local, runtime } from "../db.mjs";
import { config } from "../config.mjs";
import { readBody, send, tokenDe } from "../http.mjs";
import { pullReplica, flushOutbox, conectividad } from "../sync.mjs";
import { autorizar } from "../auth.mjs";
import { PERMISO_ADMIN, estadoSimulacion, iniciarSimulacion, restablecerSimulacion } from "../simulacion.mjs";

// Nombre de la tienda de este nodo (tienda_ref llega por réplica). Se consulta hasta obtenerlo y luego queda en memoria.
let tiendaCache = null;
async function tiendaDelNodo() {
  if (tiendaCache) return tiendaCache;
  const r = await local
    .query("select nombre from tienda_ref where id_tienda = $1", [runtime.tiendaId])
    .catch(() => ({ rows: [] }));
  const tienda = { id: runtime.tiendaId, nombre: r.rows[0]?.nombre ?? null };
  if (tienda.nombre) tiendaCache = tienda;
  return tienda;
}

// Salud, conectividad con el central y sincronización manual.
export default function sistema(router) {
  router.get("/api/health", (req, res) => send(res, 200, { ok: true }));

  router.get("/api/conectividad", async (req, res) => {
    const conflictos = await local.query("select count(*)::int as n from sync_conflicto where resuelto = false");
    // simulacion: la web ofrece la demostración de conectividad (a administradores) solo si está habilitada (no en el despliegue).
    // tienda: identidad de este nodo; la web la usa desde el login para el color y las cuentas de la tienda.
    return send(res, 200, {
      ...conectividad(),
      conflictos: conflictos.rows[0].n,
      simulacion: config.simulacion,
      tienda: await tiendaDelNodo(),
    });
  });

  // Demostración de conectividad (simulacion.mjs): solo administradores con sesión, y solo con FARMAHUB_SIMULACION.
  // Reemplaza al antiguo /api/conectividad/simular, que no pedía sesión y permitía a cualquiera afectar a toda la tienda.
  const NODO = "(local|central)";
  const admin = (req, nodo) => autorizar(tokenDe(req), nodo, PERMISO_ADMIN);

  router.get(new RegExp(`^/api/${NODO}/simulacion$`), async (req, res, { params }) => {
    await admin(req, params[0]);
    return send(res, 200, await estadoSimulacion());
  });

  router.post(new RegExp(`^/api/${NODO}/simulacion$`), async (req, res, { params }) => {
    const sesion = await admin(req, params[0]);
    const body = await readBody(req);
    if (body.restablecer) return send(res, 200, await restablecerSimulacion(sesion));
    return send(res, 200, await iniciarSimulacion(sesion, body.escenario));
  });

  router.post("/api/sync/ahora", async (req, res) => {
    const enviados = (await flushOutbox())?.sent ?? 0;
    const pull = await pullReplica().catch((error) => ({ applied: 0, skipped: true, error: error.message }));
    const cursor = await local.query("select coalesce(max(ultimo_evento_visto), 0)::bigint as cursor from cursor_sync");
    return send(res, 200, {
      enviados,
      aplicados: pull.applied ?? 0,
      skipped: Boolean(pull.skipped),
      cursor: Number(cursor.rows[0]?.cursor || 0),
    });
  });
}
