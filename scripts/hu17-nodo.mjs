import "./lib/owner.mjs";
// Segunda tienda para la prueba de HU-17 (scripts/probar-hu17.mjs). Es el MISMO código del API (migración, réplica, outbox,
// handlers), en otro proceso y con otra identidad (LOCAL_TIENDA_ID), y con su base en un esquema propio (HU17_ESQUEMA) de la
// misma base local: así la prueba tiene dos tiendas reales sin crear otra base en Neon. La prueba la maneja por IPC.
// No usar fuera de la prueba.
import pg from "pg";

const esquema = process.env.HU17_ESQUEMA;
if (!/^hu17_[a-z0-9_]+$/.test(esquema || "")) {
  console.error("HU17_ESQUEMA no válido");
  process.exit(2);
}

const { config } = await import("../apps/api/config.mjs");
// El esquema se crea antes de que el pool de la tienda abra su primera conexión.
const admin = new pg.Client({ connectionString: config.localUrl, ssl: { rejectUnauthorized: false } });
await admin.connect();
await admin.query(`create schema if not exists ${esquema}`);
await admin.end();

const { local, central, localMigracion, withTx } = await import("../apps/api/db.mjs");
// Toda conexión de esta tienda trabaja en su esquema (y solo en él: pg_catalog siempre está disponible).
local.on("connect", (client) => client.query(`set search_path to ${esquema}`).catch(() => {}));
// Las migraciones de este nodo usan el mismo esquema.
localMigracion.on("connect", (client) => client.query(`set search_path to ${esquema}`).catch(() => {}));

const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { aplicarEvento } = await import("../apps/api/sync/handlers/index.mjs");
const { encolarStockSnapshot } = await import("../apps/api/inventario/stock.mjs");

const comandos = {
  migrar: async () => {
    await migrate();
    // Se pone al día con todo el log (la tienda nueva lee desde el evento 1).
    let total = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = await pullReplica(config.tiendaId);
      total += r.applied;
      if (r.applied === 0) break;
    }
    return { aplicados: total };
  },
  pull: () => pullReplica(config.tiendaId),
  flush: () => flushOutbox(config.tiendaId),
  sql: async ({ text, params = [] }) => (await local.query(text, params)).rows,
  stock: ({ ids }) => withTx(local, (client) => encolarStockSnapshot(client, { idTienda: config.tiendaId, idsMedicamento: ids })),
  // Reaplica un evento ya visto (simula una entrega duplicada tras un corte): debe ser idempotente.
  reaplicar: async ({ idEvento }) => {
    const ev = (await central.query("select id_evento, id_tienda_destino, tipo_evento, version_credencial, payload from replica_evento where id_evento = $1", [idEvento])).rows[0];
    await withTx(local, (client) => aplicarEvento(client, ev, config.tiendaId));
    return { tipo: ev.tipo_evento };
  },
  conectividad: ({ estado }) => {
    link.estado = estado;
    link.openedUntil = 0;
    return { estado };
  },
  fin: async () => {
    await local.end();
    await central.end();
    setTimeout(() => process.exit(0), 50);
    return {};
  },
};

process.on("message", async ({ id, cmd, args }) => {
  try {
    const resultado = await comandos[cmd](args ?? {});
    process.send({ id, ok: true, resultado });
  } catch (error) {
    process.send({ id, ok: false, error: `${error.code ?? ""} ${error.message}` });
  }
});
process.send({ listo: true });
