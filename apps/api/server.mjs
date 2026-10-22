import http from "http";
import { central, local } from "./db.mjs";
import { config, avisos } from "./config.mjs";
import { migrate } from "./migrate.mjs";
import { pullReplica, flushOutbox, probeCentral, estadoReal } from "./sync.mjs";
import { crearRouter, send } from "./http.mjs";
import sistema from "./routes/sistema.mjs";
import auth from "./routes/auth.mjs";

// Cada módulo de rutas registra las suyas. Para una HU nueva: routes/<dominio>.mjs y agregarlo aquí.
const router = crearRouter().usar(sistema).usar(auth);

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const url = new URL(req.url, "http://localhost");
  try {
    const ruta = router.buscar(req.method, url.pathname);
    if (!ruta) return send(res, 404, { mensaje: "Ruta no encontrada" });
    return await ruta.handler(req, res, { url, params: ruta.params });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return send(res, status, { mensaje: status === 400 ? "JSON inválido" : "Error interno" });
  }
});

async function ciclo() {
  await probeCentral();
  if (estadoReal() === "offline") return;
  await flushOutbox();
  await pullReplica();
}

for (const aviso of avisos) console.warn(`aviso: ${aviso}`);
await migrate({ log: (mensaje) => console.log(mensaje) });
await pullReplica().catch((error) => console.error("sync inicial", error.message));
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
