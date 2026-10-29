import { local } from "../db.mjs";
import { config } from "../config.mjs";
import { readBody, send } from "../http.mjs";
import { pullReplica, flushOutbox, link, conectividad, inyectarProbe } from "../sync.mjs";

// Salud, conectividad con el central y sincronización manual.
export default function sistema(router) {
  router.get("/api/health", (req, res) => send(res, 200, { ok: true }));

  router.get("/api/conectividad", async (req, res) => {
    const conflictos = await local.query("select count(*)::int as n from sync_conflicto where resuelto = false");
    return send(res, 200, { ...conectividad(), conflictos: conflictos.rows[0].n });
  });

  // Herramienta de demo para simular caídas del central. Deshabilitada con FARMAHUB_SIMULACION=0.
  router.post("/api/conectividad/simular", async (req, res) => {
    if (!config.simulacion) return send(res, 404, { mensaje: "Ruta no encontrada" });
    const body = await readBody(req);
    if (body.probe != null) {
      const veces = Number(body.veces || 1);
      if (!["ok", "lento", "timeout"].includes(body.probe) || !Number.isInteger(veces) || veces < 1 || veces > 20) {
        return send(res, 400, { mensaje: "Probe no válido" });
      }
      inyectarProbe(body.probe, veces);
    }
    if (body.estado !== undefined) {
      if (![null, "online", "degradado", "offline"].includes(body.estado)) {
        return send(res, 400, { mensaje: "Estado no válido" });
      }
      link.force = body.estado === "online" || body.estado == null ? null : body.estado;
    }
    if (body.probe == null && body.estado === undefined) {
      return send(res, 400, { mensaje: "Nada que simular" });
    }
    return send(res, 200, conectividad());
  });

  router.post("/api/sync/ahora", async (req, res) => {
    const enviados = (await flushOutbox())?.sent ?? 0;
    const pull = await pullReplica().catch((error) => ({ applied: 0, skipped: true, error: error.message }));
    const cursor = await local.query("select coalesce(max(ultimo_evento_visto), 0)::bigint as cursor from replica_cursor");
    return send(res, 200, {
      enviados,
      aplicados: pull.applied ?? 0,
      skipped: Boolean(pull.skipped),
      cursor: Number(cursor.rows[0]?.cursor || 0),
    });
  });
}
