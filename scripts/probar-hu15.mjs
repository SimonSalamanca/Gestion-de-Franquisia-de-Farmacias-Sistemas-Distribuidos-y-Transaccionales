import "./lib/owner.mjs";
import { concederPermisoRol, desactivarMedicamentos, desactivarTiendaCentral, fijarConsolidadoTienda, limpiarConsolidadoTienda, publicarAltaMedicamento, quitarPermisoRol } from "./lib/central.mjs";
import crypto from "crypto";
import { central, local } from "../apps/api/db.mjs";
import { migrate } from "../apps/api/migrate.mjs";
import { login } from "../apps/api/auth.mjs";
import { link } from "../apps/api/sync.mjs";
import { crearTienda, editarTienda, desactivarTienda, guardarUmbral, disponibilidad, reporteConsolidado, listarTiendas } from "../apps/api/tiendas.mjs";
import { pullReplica } from "../apps/api/sync.mjs";

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

await migrate();
link.estado = "online";
link.openedUntil = 0;
const sobras = await central.query("select id_tienda from tienda where nombre like 'HU15 %' or nombre = 'No debe crearse' or nombre = 'No autorizada'");
for (const row of sobras.rows) {
  await limpiarConsolidadoTienda(row.id_tienda);
  await local.query("delete from tienda_ref where id_tienda = $1", [row.id_tienda]);
  await desactivarTiendaCentral(row.id_tienda);
}

const antes = await central.query("select id_tienda, nombre, version_tienda, activa from tienda order by id_tienda");
const umbralAntes = await central.query("select id_tienda, count(*)::int as n from umbral_stock group by id_tienda");
const admin = await login({
  nodo: "central",
  usuario: "admin.general",
  password: "Farma123",
  idempotencyKey: crypto.randomUUID(),
});
check("admin entra", admin.status === 200, String(admin.status));
const token = admin.body.token;

const key = crypto.randomUUID();
const creada = await crearTienda(token, key, {
  nombre: "HU15 Temporal",
  direccion: "Calle 1",
  ciudad: "Medellín",
  telefono: "604000",
});
check("alta 201", creada.status === 201, `${creada.status} ${creada.body.mensaje || ""}`);
const id = creada.body.tienda?.id_tienda;
const otra = await crearTienda(token, key, {
  nombre: "HU15 Temporal",
  direccion: "Calle 1",
  ciudad: "Medellín",
  telefono: "604000",
});
check("reintento no duplica", otra.status === 201 && otra.body.tienda.id_tienda === id);
const cuentas = await central.query("select count(*)::int as n from tienda where nombre = 'HU15 Temporal'");
check("una sola fila", cuentas.rows[0].n === 1, String(cuentas.rows[0].n));

const despues = await central.query("select id_tienda, nombre, version_tienda, activa from tienda where id_tienda <> $1 order by id_tienda", [id]);
check("tiendas existentes intactas", JSON.stringify(despues.rows) === JSON.stringify(antes.rows));

const editada = await editarTienda(token, crypto.randomUUID(), id, {
  nombre: "HU15 Temporal Editada",
  direccion: "Calle 2",
  ciudad: "Cali",
  version_tienda: creada.body.tienda.version_tienda,
});
check("edicion 200", editada.status === 200 && editada.body.tienda.ciudad === "Cali", editada.body.mensaje || "");
const vieja = await editarTienda(token, crypto.randomUUID(), id, {
  nombre: "HU15 Temporal Editada",
  direccion: "Calle 2",
  ciudad: "Cali",
  version_tienda: creada.body.tienda.version_tienda,
});
check("version vieja 409", vieja.status === 409, String(vieja.status));
const ciudad = await central.query("select ciudad from tienda where id_tienda = $1", [id]);
check("409 no pisa", ciudad.rows[0].ciudad === "Cali");

let med = await central.query("select id_medicamento from medicamento order by id_medicamento limit 1");
let medCreado = false;
if (med.rowCount === 0) {
  med = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo)
               values ('HU15-TEST', 'Prueba HU15', 'prueba') returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
  );
  await publicarAltaMedicamento(med.rows[0].id_medicamento);
  medCreado = true;
}
const idMed = med.rows[0].id_medicamento;
const umbral = await guardarUmbral(token, crypto.randomUUID(), id, {
  id_medicamento: idMed,
  stock_minimo: 7,
  dias_alerta_caducidad: 12,
});
check("umbral propio", umbral.status === 200, umbral.body.mensaje || "");
const umbralDespues = await central.query("select id_tienda, count(*)::int as n from umbral_stock group by id_tienda");
const ajenos = umbralAntes.rows.every((row) => {
  const now = umbralDespues.rows.find((item) => item.id_tienda === row.id_tienda);
  return now && now.n === row.n;
});
check("umbrales de otras tiendas intactos", ajenos);

const off = link.estado;
link.estado = "offline";
const antesCount = await central.query("select count(*)::int as n from tienda");
const caido = await crearTienda(token, crypto.randomUUID(), {
  nombre: "No debe crearse",
  direccion: "Calle 9",
  ciudad: "Bogotá",
});
const despuesCount = await central.query("select count(*)::int as n from tienda");
check("offline 503 sin alta", caido.status === 503 && antesCount.rows[0].n === despuesCount.rows[0].n, caido.body.mensaje);
link.estado = off;

const permiso = await central.query(
  `select id_permiso from permiso where codigo = 'TIENDA_GESTIONAR'`,
);
await quitarPermisoRol(3, permiso.rows[0].id_permiso);
try {
  const negado = await crearTienda(token, crypto.randomUUID(), {
    nombre: "No autorizada",
    direccion: "Calle 3",
    ciudad: "Bogotá",
  });
  check("sin permiso 403", negado.status === 403, String(negado.status));
  const noCreada = await central.query("select 1 from tienda where nombre = 'No autorizada'");
  check("403 no inserta", noCreada.rowCount === 0);
} finally {
  await concederPermisoRol(3, permiso.rows[0].id_permiso);
}

const baja = await desactivarTienda(token, crypto.randomUUID(), id, { version_tienda: editada.body.tienda.version_tienda });
check("desactivar", baja.status === 200 && baja.body.tienda.activa === false, baja.body.mensaje || "");

await fijarConsolidadoTienda(id, idMed, 4);
const cruce = await disponibilidad(token, new URLSearchParams());
check(
  "desactivada fuera de cruce",
  cruce.status === 200 && !cruce.body.disponibilidad.some((row) => row.id_tienda === id),
);
const reporte = await reporteConsolidado(token);
check(
  "desactivada fuera de reporte",
  reporte.status === 200 && !reporte.body.reporte.some((row) => row.id_tienda === id),
);
const lista = await listarTiendas(token);
check("admin aun la ve", lista.body.tiendas.some((row) => row.id_tienda === id && row.activa === false));

await pullReplica();
const localRef = await local.query("select activa from tienda_ref where id_tienda = $1", [id]);
check("replica local", localRef.rowCount === 1 && localRef.rows[0].activa === false);

await limpiarConsolidadoTienda(id);
await local.query("delete from tienda_ref where id_tienda = $1", [id]);
await desactivarTiendaCentral(id);
if (medCreado) await desactivarMedicamentos("id_medicamento = $1", [idMed]);

const final = await central.query("select id_tienda, nombre, version_tienda, activa from tienda order by id_tienda");
// Las tiendas HU15 no se borran (la baja es lógica y queda en el log de réplica): se comparan solo las demás.
const sinHu15 = (rows) => JSON.stringify(rows.filter((t) => !t.nombre.startsWith("HU15 ")));
check("estado original restaurado", sinHu15(final.rows) === sinHu15(antes.rows));

console.log(fallos.length ? `FALLOS ${fallos.length}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
