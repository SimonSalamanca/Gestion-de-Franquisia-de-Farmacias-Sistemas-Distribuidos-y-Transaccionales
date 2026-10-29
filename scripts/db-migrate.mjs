// Aplica los scripts de db/central y db/local a las bases del .env y hace la primera sincronización,
// lo mismo que hace la API al arrancar (incluidos los datos demo si SEED_DEMO está activo).
import { central, local } from "../apps/api/db.mjs";
import { config } from "../apps/api/config.mjs";
import { migrate } from "../apps/api/migrate.mjs";
import { flushOutbox, pullReplica } from "../apps/api/sync.mjs";
import { seedLocalDemo } from "../apps/api/demo.mjs";

const host = (url) => new URL(url).host;
console.log(`central: ${host(config.centralUrl)}\nlocal:   ${host(config.localUrl)}`);
try {
  const tienda = await migrate({ log: (mensaje) => console.log(mensaje) });
  const pull = await pullReplica();
  console.log(`Tienda local: ${tienda}. Eventos aplicados: ${pull.applied}, cursor: ${pull.cursor}`);
  if (config.seedDemo && (await seedLocalDemo(tienda))) {
    const enviados = await flushOutbox();
    console.log(`Datos demo locales creados; stock enviado al central (${enviados.sent} evento(s)).`);
  }
  console.log("Listo.");
} finally {
  await central.end();
  await local.end();
}
