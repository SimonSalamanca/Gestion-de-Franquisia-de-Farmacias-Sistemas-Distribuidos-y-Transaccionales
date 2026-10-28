import { central, local, runtime, withTx } from "./db.mjs";
import { config } from "./config.mjs";
import { aplicarEvento } from "./sync/handlers/index.mjs";
import { aplicarEnCentral } from "./sync/central.mjs";

export const link = {
  force: null,
  estado: "online",
  failures: 0,
  openedUntil: 0,
  ultimaSync: null,
  probing: false,
  ultimoProbe: null,
};

export function estadoReal() {
  return link.estado;
}

export function centralAlcanzable() {
  return link.estado !== "offline";
}

export function conectividad() {
  return {
    estado_real: estadoReal(),
    estado: estadoReal(),
    forzado: link.force,
    breaker_abierto: Date.now() < link.openedUntil,
    ultima_sync: link.ultimaSync,
    probe_fallos: link.failures,
    ultimo_probe: link.ultimoProbe,
  };
}

function aplicarResultadoProbe(resultado) {
  if (resultado === "ok" || resultado === "lento") {
    link.failures = 0;
    link.openedUntil = 0;
    link.estado = resultado === "lento" ? "degradado" : "online";
    link.ultimoProbe = link.estado;
    link.ultimaSync = new Date().toISOString();
    return;
  }
  link.failures += 1;
  link.ultimoProbe = "timeout";
  if (link.failures >= 5 || link.estado === "offline") {
    link.estado = "offline";
    link.openedUntil = Date.now() + 30000;
    if (link.failures >= 5) link.failures = 0;
  }
}

export function inyectarProbe(resultado, veces = 1) {
  for (let i = 0; i < veces; i += 1) aplicarResultadoProbe(resultado);
  return conectividad();
}

export async function probeCentral() {
  if (link.probing || Date.now() < link.openedUntil) return estadoReal();
  link.probing = true;
  const started = Date.now();
  const query = central.query("select 1");
  try {
    const first = await Promise.race([
      query.then(() => "ok"),
      new Promise((resolve) => setTimeout(() => resolve("slow"), 3000)),
    ]);
    if (first === "slow") {
      await Promise.race([
        query,
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { timeout: true })), 5000)),
      ]);
      aplicarResultadoProbe("lento");
    } else {
      aplicarResultadoProbe(Date.now() - started > 3000 ? "lento" : "ok");
    }
  } catch {
    aplicarResultadoProbe("timeout");
  } finally {
    link.probing = false;
  }
  return estadoReal();
}

// Máximo de lotes por llamada: acota el tiempo de un ciclo cuando el nodo viene muy atrasado.
const MAX_LOTES = 20;

async function aplicarLote(idTienda, seen) {
  const events = await central.query(
    `select id_evento, id_tienda_destino, tipo_evento, version_credencial, payload
     from replica_evento
     where id_evento > $1
     order by id_evento
     limit $2`,
    [seen, config.syncLote],
  );
  const client = await local.connect();
  let applied = 0;
  let hueco = false;
  try {
    await client.query("begin");
    for (const event of events.rows) {
      // El log es contiguo; un hueco significa una escritura aún no visible: se reintenta en el próximo ciclo.
      if (Number(event.id_evento) !== seen + 1) {
        hueco = true;
        break;
      }
      const destino = event.id_tienda_destino;
      if (destino == null || Number(destino) === Number(idTienda)) {
        await aplicarEvento(client, event, idTienda);
        applied += 1;
      }
      seen = Number(event.id_evento);
    }
    await client.query(
      `insert into replica_cursor (id_tienda, ultimo_evento_visto, ultimo_ack_en)
       values ($1, $2, now())
       on conflict (id_tienda) do update
       set ultimo_evento_visto = excluded.ultimo_evento_visto, ultimo_ack_en = now()`,
      [idTienda, seen],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  const completo = !hueco && events.rowCount === config.syncLote;
  return { applied, seen, otroLote: completo };
}

export async function pullReplica(idTienda = runtime.tiendaId) {
  if (!centralAlcanzable()) return { applied: 0, skipped: true };
  const cursor = await local.query("select ultimo_evento_visto from replica_cursor where id_tienda = $1", [idTienda]);
  let seen = Number(cursor.rows[0]?.ultimo_evento_visto || 0);
  let applied = 0;
  for (let lote = 0; lote < MAX_LOTES; lote += 1) {
    const result = await aplicarLote(idTienda, seen);
    applied += result.applied;
    seen = result.seen;
    if (!result.otroLote) break;
  }
  link.ultimaSync = new Date().toISOString();
  return { applied, cursor: seen };
}

export async function flushOutbox(idTienda = runtime.tiendaId) {
  if (!centralAlcanzable()) return { sent: 0 };
  const allPending = await local.query(
    `select id_outbox, id_empleado, tipo_evento, idempotency_key, payload, (proximo_intento <= now()) as vencio
     from outbox_sync
     where estado in ('PENDIENTE', 'ERROR')
     order by id_outbox`,
  );
  const headManejado = new Set();
  const continuable = new Set();
  const enviables = [];
  for (const event of allPending.rows) {
    const empKey = event.id_empleado == null ? "null" : String(event.id_empleado);
    const due = event.vencio === true;
    if (!headManejado.has(empKey)) {
      headManejado.add(empKey);
      if (due) {
        enviables.push(event);
        continuable.add(empKey);
      }
    } else if (continuable.has(empKey) && due) {
      enviables.push(event);
    } else {
      continuable.delete(empKey);
    }
  }
  if (enviables.length === 0) return { sent: 0 };
  try {
    // Todo el lote en una transacción del central, en orden y con parámetros.
    await withTx(central, async (client) => {
      for (const event of enviables) await aplicarEnCentral(client, idTienda, event);
    });
    await local.query(
      "update outbox_sync set estado = 'ENVIADO' where id_outbox = any($1::bigint[])",
      [enviables.map((event) => Number(event.id_outbox))],
    );
    return { sent: enviables.length };
  } catch {
    const bloqueados = new Set();
    let sent = 0;
    for (const event of enviables) {
      const empKey = event.id_empleado == null ? "null" : String(event.id_empleado);
      if (bloqueados.has(empKey)) continue;
      try {
        await withTx(central, (client) => aplicarEnCentral(client, idTienda, event));
        await local.query("update outbox_sync set estado = 'ENVIADO' where id_outbox = $1", [event.id_outbox]);
        sent += 1;
      } catch {
        await local.query(
          `update outbox_sync
           set intentos = intentos + 1,
               proximo_intento = now() + (least(60, power(2, intentos))::int * interval '1 second'),
               estado = case when intentos + 1 >= 20 then 'ERROR' else 'PENDIENTE' end
           where id_outbox = $1`,
          [event.id_outbox],
        );
        bloqueados.add(empKey);
      }
    }
    return { sent };
  }
}
