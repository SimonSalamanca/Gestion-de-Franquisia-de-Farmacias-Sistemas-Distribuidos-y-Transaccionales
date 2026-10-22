// Aplica los scripts de db/central y db/local a las bases del .env y hace la primera sincronización,
// lo mismo que hace la API al arrancar.
import { central, local } from "../apps/api/db.mjs";
import { config } from "../apps/api/config.mjs";
import { migrate } from "../apps/api/migrate.mjs";
import { pullReplica } from "../apps/api/sync.mjs";

const host = (url) => new URL(url).host;
console.log(`central: ${host(config.centralUrl)}\nlocal:   ${host(config.localUrl)}`);
try {
  const tienda = await migrate({ log: (mensaje) => console.log(mensaje) });
  const pull = await pullReplica();
  console.log(`Listo. Tienda local: ${tienda}. Eventos aplicados: ${pull.applied}, cursor: ${pull.cursor}`);
} finally {
  await central.end();
  await local.end();
}
