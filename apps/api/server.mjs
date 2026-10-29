import http from "http";
import { central, local, runtime, withTx } from "./db.mjs";
import { seedLocalDemo } from "./demo.mjs";
import { encolarStockCompleto } from "./inventario/stock.mjs";
import { config, avisos } from "./config.mjs";
import { migrate } from "./migrate.mjs";
import { pullReplica, flushOutbox, probeCentral, estadoReal } from "./sync.mjs";
import { crearRouter, send } from "./http.mjs";
import sistema from "./routes/sistema.mjs";
import auth from "./routes/auth.mjs";
import inventario from "./routes/inventario.mjs";
import lotes from "./routes/lotes.mjs";
import { ErrorNegocio } from "./errores.mjs";

// Cada módulo de rutas registra las suyas. Para una HU nueva: routes/<dominio>.mjs y agregarlo aquí.
const router = crearRouter().usar(sistema).usar(auth).usar(inventario).usar(lotes);

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const url = new URL(req.url, "http://localhost");
  try {
    const ruta = router.buscar(req.method, url.pathname);
    if (!ruta) return send(res, 404, { mensaje: "Ruta no encontrada" });
    return await ruta.handler(req, res, { url, params: ruta.params });
  } catch (error) {
    if (error instanceof ErrorNegocio) return send(res, error.status, error.body);
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return send(res, status, { mensaje: status === 400 ? "JSON inválido" : "Error interno" });
  }
});

// HU-01: cada 15 minutos se encola una foto completa del stock para corregir cualquier deriva del consolidado.
const RECONCILIACION_MS = 15 * 60 * 1000;
let ultimaReconciliacion = 0;

async function reconciliarStock() {
  await withTx(local, (client) => encolarStockCompleto(client, runtime.tiendaId));
  ultimaReconciliacion = Date.now();
}

async function ciclo() {
  // Se encola aunque el central esté caído: el outbox lo envía al reconectar.
  if (Date.now() - ultimaReconciliacion >= RECONCILIACION_MS) await reconciliarStock();
  await probeCentral();
  if (estadoReal() === "offline") return;
  await flushOutbox();
  await pullReplica();
}

for (const aviso of avisos) console.warn(`aviso: ${aviso}`);
await migrate({ log: (mensaje) => console.log(mensaje) });
await pullReplica().catch((error) => console.error("sync inicial", error.message));
if (config.seedDemo) {
  await seedLocalDemo(runtime.tiendaId).catch((error) => console.error("demo local", error.message));
}
await reconciliarStock().catch((error) => console.error("reconciliación de stock", error.message));
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
