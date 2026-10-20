import { central, local } from "../apps/api/db.mjs";

const c = await central.query(
  "select id_empleado, epoch, intentos_en_epoch, estado, bloqueado_hasta, provisional, id_snapshot from control_acceso where id_empleado in (1,2,3)",
);
const canon = await central.query("select * from bloqueo_canonico order by id_empleado, epoch");
const inbox = await central.query(
  "select id_tienda_origen, tipo_evento, payload->>'epoch_observado' as epoch_obs, payload->>'observo_expiracion' as observo, payload->>'version_credencial_observada' as vc, payload->>'id_empleado' as id_emp from inbox_sync where tipo_evento in ('FAIL','SUCCESS','EXPIRADO') order by aplicado_en",
);
const evs = await central.query(
  "select id_evento, tipo_evento, id_tienda_destino, version_credencial, payload->>'estado' as estado, payload->>'epoch' as epoch, payload->>'id_snapshot' as snap from replica_evento order by id_evento desc limit 15",
);
const l = await local.query(
  "select id_empleado, epoch, intentos_en_epoch, estado, bloqueado_hasta, provisional, id_snapshot from control_acceso where id_empleado in (1,2,3)",
);
const conflicto = await local.query("select * from sync_conflicto order by id_conflicto desc limit 5");
const outbox = await local.query(
  "select id_outbox, id_empleado, tipo_evento, estado, intentos, payload->>'epoch_observado' as epoch_obs, idempotency_key from outbox_sync order by id_outbox desc limit 12",
);
const cursor = await local.query("select * from replica_cursor");

console.log("CENTRAL control_acceso", JSON.stringify(c.rows, null, 1));
console.log("CANONICO", JSON.stringify(canon.rows, null, 1));
console.log("INBOX", JSON.stringify(inbox.rows, null, 1));
console.log("EVENTOS RECIENTES", JSON.stringify(evs.rows, null, 1));
console.log("LOCAL control_acceso", JSON.stringify(l.rows, null, 1));
console.log("CONFLICTOS", JSON.stringify(conflicto.rows, null, 1));
console.log("OUTBOX RECIENTE", JSON.stringify(outbox.rows, null, 1));
console.log("CURSOR", JSON.stringify(cursor.rows, null, 1));

await central.end();
await local.end();
