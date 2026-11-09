import { central, local, runtime, withTx } from "./db.mjs";
import { seedLocalDemo } from "./demo.mjs";
import { encolarStockCompleto } from "./inventario/stock.mjs";
import { config, avisos } from "./config.mjs";
import { migrate } from "./migrate.mjs";
import { pullReplica, flushOutbox, probeCentral, estadoReal } from "./sync.mjs";
import { crearServidor } from "./app.mjs";
import { subirAuditoria } from "./auditoria.mjs";
import { evaluarAlertas } from "./alertas.mjs";

// Las rutas se registran en app.mjs.
const server = crearServidor();

// HU-01 y HU-16: foto completa del stock cada CONSOLIDACION_INTERVALO_MS (2 min por defecto). Corrige cualquier deriva
// del consolidado y es el latido con que la vista de red sabe si la tienda está al día.
const RECONCILIACION_MS = config.consolidacionIntervaloMs;
let ultimaReconciliacion = 0;

async function reconciliarStock() {
  await withTx(local, (client) => encolarStockCompleto(client, runtime.tiendaId));
  ultimaReconciliacion = Date.now();
}

// HU-04: las alertas se evalúan cada 30 s, aunque no haya conexión con el central (RNF-04).
const ALERTAS_MS = 30 * 1000;
let ultimaEvaluacion = 0;

async function evaluar() {
  ultimaEvaluacion = Date.now();
  await evaluarAlertas().catch((error) => console.error("alertas", error.message));
}

async function ciclo() {
  if (Date.now() - ultimaEvaluacion >= ALERTAS_MS) await evaluar();
  // Se encola aunque el central esté caído: el outbox lo envía al reconectar.
  if (Date.now() - ultimaReconciliacion >= RECONCILIACION_MS) await reconciliarStock();
  await probeCentral();
  if (estadoReal() === "offline") return;
  await flushOutbox();
  await pullReplica();
  // HU-07: la auditoría sube aparte; si falla, se reintenta en el próximo ciclo sin frenar la réplica.
  await subirAuditoria(runtime.tiendaId).catch((error) => console.error("auditoría", error.message));
}

for (const aviso of avisos) console.warn(`aviso: ${aviso}`);
await migrate({ log: (mensaje) => console.log(mensaje) });
await pullReplica().catch((error) => console.error("sync inicial", error.message));
if (config.seedDemo) {
  await seedLocalDemo(runtime.tiendaId).catch((error) => console.error("demo local", error.message));
}
await reconciliarStock().catch((error) => console.error("reconciliación de stock", error.message));
await evaluar();
await Promise.all([central.query("select 1"), local.query("select 1")]).catch((error) =>
  console.error("pre-warm", error.message),
);
server.listen(config.port, () => {
  console.log(`API FarmaHub en http://localhost:${config.port} (tienda ${config.tiendaId})`);
});
setInterval(() => {
  ciclo().catch((error) => console.error("sync", error.message));
}, config.syncIntervaloMs);

process.on("SIGINT", async () => {
  server.close();
  await central.end();
  await local.end();
  process.exit(0);
});
