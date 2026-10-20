import crypto from "crypto";
import { central, local } from "../apps/api/db.mjs";
import { migrate } from "../apps/api/migrate.mjs";
import { hashPassword } from "../apps/api/crypto.mjs";
import { login, abrirModulo } from "../apps/api/auth.mjs";
import { link, estadoReal, pullReplica, flushOutbox, inyectarProbe } from "../apps/api/sync.mjs";

const fallos = [];

function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

await migrate();
await central.query("update politica_acceso set intentos_maximos = 5, minutos_bloqueo = 15 where id = 1");
await local.query("update politica_acceso set intentos_maximos = 5, minutos_bloqueo = 15 where id = 1");

const nullable = await local.query(
  "select is_nullable from information_schema.columns where table_name = 'empleado_ref' and column_name = 'id_tienda'",
);
check("id_tienda NOT NULL", nullable.rows[0]?.is_nullable === "NO", nullable.rows[0]?.is_nullable);

const seq = await central.query("select last_value from control_acceso_snapshot_seq");
check("secuencia snapshot", seq.rowCount === 1);

const originalQuery = central.query.bind(central);
let centralCalls = 0;
central.query = async (...args) => {
  centralCalls += 1;
  return originalQuery(...args);
};
const cajero = await login({
  nodo: "local",
  usuario: "cajero1",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("login local no llama al central", centralCalls === 0, String(centralCalls));
central.query = originalQuery;
check("cajero 200", cajero.status === 200, String(cajero.status));
check("cajero tienda", cajero.body.id_tienda === 1, String(cajero.body.id_tienda));
check("cajero rol", cajero.body.rol === "cajero", cajero.body.rol);
check(
  "cajero permisos",
  JSON.stringify(cajero.body.permisos) === JSON.stringify(["INVENTARIO_CONSULTAR", "VENTA_REGISTRAR"]),
  (cajero.body.permisos || []).join(","),
);

const caja = await abrirModulo(cajero.body.token, "local", "CAJA_CERRAR");
check("cajero caja 403", caja.status === 403 && caja.body.codigo === "ACCESO_DENEGADO", `${caja.status} ${caja.body.codigo}`);
const inventario = await abrirModulo(cajero.body.token, "local", "INVENTARIO_CONSULTAR");
check("cajero inventario 200", inventario.status === 200, String(inventario.status));
const anon = await abrirModulo("", "local", "VENTA_REGISTRAR");
check("sin sesion 401", anon.status === 401, String(anon.status));

const cajeroRed = await login({
  nodo: "central",
  usuario: "cajero1",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("cajero red 403", cajeroRed.status === 403, `${cajeroRed.status} ${cajeroRed.body.codigo}`);
const sesionesCajeroRed = await central.query(
  "select count(*)::int as n from sesion_activa where id_empleado = 1 and nodo_emisor = 'central' and revocada = false and expira_en > now()",
);
check("cajero red sin sesion", sesionesCajeroRed.rows[0].n === 0, String(sesionesCajeroRed.rows[0].n));

const general = await login({
  nodo: "central",
  usuario: "admin.general",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("admin red 200", general.status === 200, `${general.status} ${general.body.mensaje || ""}`);
check("admin tienda hogar", general.body.id_tienda === 1);
check("admin red permisos", (general.body.permisos || []).includes("RED_CONTROL"));

const key = crypto.randomUUID();
const first = await login({ nodo: "local", usuario: "admin.tienda", password: "Farma123", idempotencyKey: key });
const second = await login({ nodo: "local", usuario: "admin.tienda", password: "Farma123", idempotencyKey: key });
check("reintento misma sesion", first.status === 200 && first.body.token === second.body.token);
const sesionesAntes = await local.query("select count(*)::int as n from sesion_activa");
const conflicto = await login({ nodo: "local", usuario: "admin.tienda", password: "otra", idempotencyKey: key });
const sesionesDespues = await local.query("select count(*)::int as n from sesion_activa");
check("hmac distinto 409", conflicto.status === 409, String(conflicto.status));
check("409 sin escrituras de sesion", sesionesAntes.rows[0].n === sesionesDespues.rows[0].n);

const real = estadoReal();
link.force = "offline";
const conForzado = await login({
  nodo: "central",
  usuario: "admin.general",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("forzado no pisa estado real", estadoReal() === real && conForzado.status === 200, `${estadoReal()} ${conForzado.status}`);
link.force = null;
link.estado = "offline";
const caido = await login({
  nodo: "central",
  usuario: "admin.general",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("central offline 503", caido.status === 503 && caido.body.mensaje === "sin conexión con el nodo central", caido.body.mensaje);
check("503 trae ultima sync", Object.prototype.hasOwnProperty.call(caido.body, "ultima_sync"));
link.estado = "online";

const hash = hashPassword("Farma123");
const creado = await central.query(
  `insert into empleado (id_tienda, id_rol, nombre_completo, usuario, contrasena_hash, correo, activo, version_credencial)
   values (1, 1, 'Lock Test', 'hu06.lock', $1, 'lock@farmahub.local', true, 1)
   returning id_empleado`,
  [hash],
);
const id = creado.rows[0].id_empleado;
await local.query(
  `insert into empleado_ref (id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash, version_credencial)
   values ($1, 1, 1, 'Lock Test', 'hu06.lock', true, $2, 1)`,
  [id, hash],
);
const antes = await local.query("select epoch, intentos_en_epoch from control_acceso where id_empleado = $1", [id]);
for (let i = 0; i < 5; i += 1) {
  await login({ nodo: "local", usuario: "hu06.lock", password: "mala", idempotencyKey: crypto.randomUUID() });
}
const despues = await local.query(
  `select c.epoch, c.intentos_en_epoch, c.estado, c.provisional,
          c.bloqueado_hasta > now() as vigente,
          c.bloqueado_hasta <= now() + make_interval(mins => p.minutos_bloqueo) as tope,
          c.bloqueado_hasta > now() + make_interval(mins => p.minutos_bloqueo - 1) as minimo
   from control_acceso c
   cross join politica_acceso p
   where c.id_empleado = $1 and p.id = 1`,
  [id],
);
const lock = despues.rows[0];
check("quinto fallo bloquea", lock?.estado === "BLOQUEADO" && lock.provisional && lock.vigente, JSON.stringify(lock));
check("bloqueo usa reloj SQL", lock?.tope && lock.minimo, JSON.stringify(lock));
check(
  "login local no muta epoch ni contador",
  Number(lock.epoch) === Number(antes.rows[0]?.epoch || 1) && Number(lock.intentos_en_epoch) === Number(antes.rows[0]?.intentos_en_epoch || 0),
  JSON.stringify({ antes: antes.rows[0], despues: lock }),
);

await central.query("delete from bloqueo_canonico where id_empleado = $1", [id]);
await central.query("delete from control_acceso where id_empleado = $1", [id]);
await central.query("insert into control_acceso (id_empleado, epoch, intentos_en_epoch, estado) values ($1, 3, 0, 'ACTIVO')", [id]);
for (let i = 0; i < 3; i += 1) {
  await central.query("select fold_evento(1, $1, 'FAIL', $2::jsonb)", [
    crypto.randomUUID(),
    JSON.stringify({ id_empleado: id, version_credencial_observada: 1, epoch_observado: 3 }),
  ]);
}
for (let i = 0; i < 2; i += 1) {
  await central.query("select fold_evento(1, $1, 'FAIL', $2::jsonb)", [
    crypto.randomUUID(),
    JSON.stringify({ id_empleado: id, version_credencial_observada: 1, epoch_observado: 3 }),
  ]);
}
const canon = await central.query(
  "select count(*)::int as n from bloqueo_canonico where id_empleado = $1 and epoch = 3",
  [id],
);
const estadoCanon = await central.query("select estado, intentos_en_epoch from control_acceso where id_empleado = $1", [id]);
check("3+2 un solo bloqueo", canon.rows[0].n === 1 && estadoCanon.rows[0].estado === "BLOQUEADO", JSON.stringify(estadoCanon.rows[0]));

await central.query(
  "update control_acceso set bloqueado_hasta = now() - interval '1 minute' where id_empleado = $1",
  [id],
);
await central.query("select fold_evento(1, $1, 'EXPIRADO', $2::jsonb)", [
  crypto.randomUUID(),
  JSON.stringify({ id_empleado: id, version_credencial_observada: 1, epoch_observado: 3 }),
]);
const trasExp = await central.query("select epoch, intentos_en_epoch, estado from control_acceso where id_empleado = $1", [id]);
check("EXPIRADO cierra epoca", Number(trasExp.rows[0].epoch) === 4 && Number(trasExp.rows[0].intentos_en_epoch) === 0 && trasExp.rows[0].estado === "ACTIVO", JSON.stringify(trasExp.rows[0]));
await central.query("select fold_evento(1, $1, 'FAIL', $2::jsonb)", [
  crypto.randomUUID(),
  JSON.stringify({ id_empleado: id, version_credencial_observada: 1, epoch_observado: 3 }),
]);
const viejo = await central.query("select intentos_en_epoch from control_acceso where id_empleado = $1", [id]);
check("fallo viejo no suma", Number(viejo.rows[0].intentos_en_epoch) === 0, String(viejo.rows[0].intentos_en_epoch));

const insertado = await central.query(
  "select append_replica_evento(99, 'CURSOR_OMITIR', 1, '{\"id_tienda\":99}'::jsonb) as id",
);
const idAjeno = Number(insertado.rows[0].id);
await pullReplica(1);
const cursorDespues = await local.query("select ultimo_evento_visto from replica_cursor where id_tienda = 1");
const otraTienda = await local.query("select 1 from tienda_ref where id_tienda = 99");
check("evento de otra tienda no se aplica", otraTienda.rowCount === 0);
check(
  "evento de otra tienda no atasca el cursor",
  Number(cursorDespues.rows[0].ultimo_evento_visto) >= idAjeno,
  `cursor ${cursorDespues.rows[0].ultimo_evento_visto} evento ${idAjeno}`,
);

const snapLocal = await local.query("select id_snapshot, estado from control_acceso where id_empleado = 1");
await central.query(
  "select append_replica_evento(1, 'CONTROL_ACCESO_SNAPSHOT', 1, $1::jsonb)",
  [JSON.stringify({
    id_empleado: 1,
    epoch: 1,
    intentos_en_epoch: 5,
    estado: "BLOQUEADO",
    bloqueado_hasta: new Date(Date.now() + 600000).toISOString(),
    id_snapshot: 1,
  })],
);
await pullReplica(1);
const snapTras = await local.query("select id_snapshot, estado from control_acceso where id_empleado = 1");
check(
  "snapshot viejo no rebloquea",
  snapTras.rows[0].estado === snapLocal.rows[0].estado && Number(snapTras.rows[0].id_snapshot) === Number(snapLocal.rows[0].id_snapshot),
  JSON.stringify(snapTras.rows[0]),
);

await central.query("update empleado set version_credencial = 2 where id_empleado = $1", [id]);
const epochAntesObs = await central.query("select epoch, intentos_en_epoch from control_acceso where id_empleado = $1", [id]);
await central.query("select fold_evento(1, $1, 'SUCCESS', $2::jsonb)", [
  crypto.randomUUID(),
  JSON.stringify({ id_empleado: id, version_credencial_observada: 1, epoch_observado: Number(epochAntesObs.rows[0].epoch) }),
]);
const epochTrasObs = await central.query("select epoch, intentos_en_epoch from control_acceso where id_empleado = $1", [id]);
const auditoria = await central.query(
  "select count(*)::int as n from registro_actividad_central where id_empleado = $1 and accion = 'CREDENCIAL_OBSOLETA'",
  [id],
);
check(
  "version vieja no resetea",
  Number(epochTrasObs.rows[0].epoch) === Number(epochAntesObs.rows[0].epoch)
    && Number(epochTrasObs.rows[0].intentos_en_epoch) === Number(epochAntesObs.rows[0].intentos_en_epoch)
    && auditoria.rows[0].n >= 1,
  JSON.stringify(epochTrasObs.rows[0]),
);

link.estado = "online";
link.failures = 0;
link.openedUntil = 0;
link.force = null;
const lento = inyectarProbe("lento");
check("latencia alta es degradado", lento.estado_real === "degradado" && lento.breaker_abierto === false, lento.estado_real);
link.force = "offline";
const trasForzado = inyectarProbe("ok");
check("forzado no pisa el probe", trasForzado.estado_real === "online" && trasForzado.forzado === "offline");
link.force = null;
inyectarProbe("timeout", 4);
check("4 timeouts no son offline", estadoReal() !== "offline", estadoReal());
const cinco = inyectarProbe("timeout");
check("5 timeouts abren offline", cinco.estado_real === "offline" && cinco.breaker_abierto === true, cinco.estado_real);
inyectarProbe("ok");
link.estado = "online";
link.openedUntil = 0;

try {
  await central.query("update politica_acceso set intentos_maximos = 2, minutos_bloqueo = 9 where id = 1");
  await local.query("update politica_acceso set intentos_maximos = 2, minutos_bloqueo = 9 where id = 1");
  await central.query("delete from bloqueo_canonico where id_empleado = $1", [id]);
  await central.query(
    "update control_acceso set epoch = 9, intentos_en_epoch = 0, estado = 'ACTIVO', bloqueado_hasta = null where id_empleado = $1",
    [id],
  );
  await central.query("select fold_evento(1, $1, 'FAIL', $2::jsonb)", [
    crypto.randomUUID(),
    JSON.stringify({ id_empleado: id, version_credencial_observada: 2, epoch_observado: 9 }),
  ]);
  const uno = await central.query("select estado from control_acceso where id_empleado = $1", [id]);
  await central.query("select fold_evento(1, $1, 'FAIL', $2::jsonb)", [
    crypto.randomUUID(),
    JSON.stringify({ id_empleado: id, version_credencial_observada: 2, epoch_observado: 9 }),
  ]);
  const dos = await central.query(
    `select estado, intentos_en_epoch,
            bloqueado_hasta <= now() + make_interval(mins => 9) as tope,
            bloqueado_hasta > now() + make_interval(mins => 8) as minimo
     from control_acceso where id_empleado = $1`,
    [id],
  );
  check(
    "politica 2 bloquea en el fold",
    uno.rows[0].estado === "ACTIVO" && dos.rows[0].estado === "BLOQUEADO" && Number(dos.rows[0].intentos_en_epoch) === 2 && dos.rows[0].tope && dos.rows[0].minimo,
    JSON.stringify(dos.rows[0]),
  );
  await local.query("delete from outbox_sync where id_empleado = $1", [id]);
  await local.query(
    "update control_acceso set epoch = 1, intentos_en_epoch = 0, estado = 'ACTIVO', bloqueado_hasta = null, provisional = false where id_empleado = $1",
    [id],
  );
  await login({ nodo: "local", usuario: "hu06.lock", password: "mala", idempotencyKey: crypto.randomUUID() });
  const localUno = await local.query("select estado from control_acceso where id_empleado = $1", [id]);
  await login({ nodo: "local", usuario: "hu06.lock", password: "mala", idempotencyKey: crypto.randomUUID() });
  const localDos = await local.query(
    `select estado, provisional,
            bloqueado_hasta <= now() + make_interval(mins => 9) as tope,
            bloqueado_hasta > now() + make_interval(mins => 8) as minimo
     from control_acceso where id_empleado = $1`,
    [id],
  );
  check(
    "politica 2 bloquea en el login local",
    localUno.rows[0].estado === "ACTIVO" && localDos.rows[0].estado === "BLOQUEADO" && localDos.rows[0].provisional && localDos.rows[0].tope && localDos.rows[0].minimo,
    JSON.stringify(localDos.rows[0]),
  );
} finally {
  await central.query("update politica_acceso set intentos_maximos = 5, minutos_bloqueo = 15 where id = 1");
  await local.query("update politica_acceso set intentos_maximos = 5, minutos_bloqueo = 15 where id = 1");
}

await flushOutbox();
await pullReplica(1);

await local.query("delete from sesion_activa where id_empleado = $1", [id]);
await local.query("delete from control_acceso where id_empleado = $1", [id]);
await local.query("delete from outbox_sync where id_empleado = $1", [id]);
await local.query("delete from registro_actividad where id_empleado = $1", [id]);
await local.query("delete from empleado_ref where id_empleado = $1", [id]);
await central.query("delete from sesion_activa where id_empleado = $1", [id]);
await central.query("delete from bloqueo_canonico where id_empleado = $1", [id]);
await central.query("delete from control_acceso where id_empleado = $1", [id]);
await central.query("delete from registro_actividad_central where id_empleado = $1", [id]);
await central.query("delete from empleado where id_empleado = $1", [id]);

console.log(fallos.length ? `FALLOS ${fallos.length}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
