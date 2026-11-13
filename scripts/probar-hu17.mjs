import "./lib/owner.mjs";
import { aplicarRespuestaCentral, desactivarMedicamentos, publicarAltaMedicamento } from "./lib/central.mjs";
// Pruebas de HU-17 con DOS tiendas reales: esta (la del .env, destino) y una segunda tienda creada para la corrida (origen),
// que corre el mismo código del API en otro proceso con su base en un esquema propio (scripts/hu17-nodo.mjs). Se prueba la
// saga completa por los mismos canales que en producción (eventos dirigidos del central, outbox de cada tienda):
// solicitud, validación de disponibilidad, descuento, ingreso, compensación automática, rechazo en origen, entregas
// duplicadas, concurrencia, auditoría en ambas tiendas y comportamiento sin conexión.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido y UNA sola corrida a la vez. Al final la tienda de la corrida queda desactivada y su esquema
// se borra; el medicamento de prueba queda inactivo (sus movimientos y traslados son permanentes).
import crypto from "crypto";
import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { aplicarEnCentral } = await import("../apps/api/sync/central.mjs");

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

const TIENDA = config.tiendaId; // esta tienda: destino
await migrate();
link.estado = "online";
link.openedUntil = 0;
await pullReplica();

const server = crearServidor();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function pedir(ruta, { method = "GET", token, key, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + ruta, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const entrar = async (nodo, usuario) =>
  (await pedir(`/api/${nodo}/auth/login`, { method: "POST", key: crypto.randomUUID(), body: { usuario, password: "Farma123" } })).data.token;
const nuevaKey = () => crypto.randomUUID();
const uno = async (pool, sql, valores = []) => (await pool.query(sql, valores)).rows[0];
const S = Date.now().toString(36);

const general = await entrar("central", "admin.general");
const adminTienda = await entrar("local", "admin.tienda");
const cajero = await entrar("local", "cajero1");

// --- La segunda tienda (origen) de esta corrida
const tiendaNueva = await pedir("/api/central/tiendas", {
  method: "POST",
  token: general,
  key: nuevaKey(),
  body: { nombre: `Tienda HU-17 ${S}`, direccion: "Calle de prueba 17", ciudad: "Bogotá" },
});
if (tiendaNueva.status !== 201) {
  console.error("No se pudo crear la tienda de la corrida", tiendaNueva.status, tiendaNueva.data);
  process.exit(2);
}
const ORIGEN = tiendaNueva.data.tienda.id_tienda;
const ESQUEMA = `hu17_${S}`;

// Medicamento de la corrida (umbral en cada tienda activa, incluida la nueva).
const idMed = (await uno(
  central,
  `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'prueba de traslados') returning id_medicamento),
        u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
   select id_medicamento from m`,
  [`HU17-${S}`.toUpperCase(), `Prueba Traslado ${S}`],
)).id_medicamento;
await publicarAltaMedicamento(idMed);
await migrate();
await pullReplica();

const hijo = fork(path.join(path.dirname(fileURLToPath(import.meta.url)), "hu17-nodo.mjs"), [], {
  env: { ...process.env, LOCAL_TIENDA_ID: String(ORIGEN), HU17_ESQUEMA: ESQUEMA, SEED_DEMO: "0" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
let siguiente = 0;
const esperando = new Map();
await new Promise((resolve) => hijo.once("message", resolve));
hijo.on("message", (m) => {
  if (m.id == null) return;
  const p = esperando.get(m.id);
  esperando.delete(m.id);
  if (m.ok) p.resolve(m.resultado);
  else p.reject(new Error(m.error));
});
const origen = (cmd, args) =>
  new Promise((resolve, reject) => {
    const id = ++siguiente;
    esperando.set(id, { resolve, reject });
    hijo.send({ id, cmd, args });
  });
const sqlOrigen = (text, params) => origen("sql", { text, params });

// Avanza la saga: cada tienda envía sus respuestas y recibe sus órdenes, hasta que nada cambie.
async function avanzar(veces = 3) {
  for (let i = 0; i < veces; i += 1) {
    await origen("pull");
    await origen("flush");
    await pullReplica();
    await flushOutbox();
  }
  await origen("pull");
  await pullReplica();
}

const estadoCentral = async (id) => (await uno(central, "select estado, motivo from traslado where id_traslado = $1", [id]));
const localDe = (pool, rol) => async (id) => {
  const sql = "select estado_local, estado_red, motivo from traslado_local where id_traslado = $1 and rol_tienda = $2";
  return pool === "origen" ? (await sqlOrigen(sql, [id, rol]))[0] : (await local.query(sql, [id, rol])).rows[0];
};
const enOrigen = localDe("origen", "ORIGEN");
const enDestino = localDe("destino", "DESTINO");
const stockOrigen = async (idLote) => Number((await sqlOrigen("select cantidad_disponible from lote where id_lote = $1", [idLote]))[0].cantidad_disponible);
const lotesDestino = async () => (await local.query("select id_lote, numero_lote, fecha_caducidad, id_proveedor, cantidad_disponible from lote where id_medicamento = $1 order by id_lote", [idMed])).rows;

try {
  check("logins demo y tienda origen creada", Boolean(general && adminTienda && cajero && ORIGEN));
  const migrada = await origen("migrar");
  check("la tienda origen se pone al día con la red (mismo código, otra base)", migrada.aplicados > 0, `eventos aplicados ${migrada.aplicados}`);
  check("la tienda origen tiene el medicamento de la corrida", (await sqlOrigen("select count(*)::int as n from medicamento_ref where id_medicamento = $1 and activo", [idMed]))[0].n === 1);
  const proveedor = (await sqlOrigen("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1"))[0]?.id_proveedor;
  check("la tienda origen tiene proveedores replicados", Boolean(proveedor));

  // Stock en la tienda origen: lote L1 con 50 unidades, publicado al central.
  const caduca = async (dias) => (await uno(local, "select (current_date + $1::int)::text as f", [dias])).f;
  const fechaL1 = await caduca(300);
  const L1 = (await sqlOrigen(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, $4, 50, 50, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `T17-${S}-1`, fechaL1],
  ))[0].id_lote;
  await origen("stock", { ids: [idMed] });
  await origen("flush");
  check("el central conoce el stock de la tienda origen", Number((await uno(central, "select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [ORIGEN, idMed]))?.cantidad_disponible) === 50);

  // --- Permisos y validaciones
  const ruta = "/api/local/traslados";
  check("sin sesión 401", (await pedir(ruta)).status === 401);
  check("el cajero no solicita traslados 403", (await pedir(ruta, { method: "POST", token: cajero, key: nuevaKey(), body: { id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 1 } })).status === 403);
  check("el cajero no ve los traslados 403", (await pedir(ruta, { token: cajero })).status === 403);
  const solicitud = (body, key = nuevaKey()) => pedir(ruta, { method: "POST", token: adminTienda, key, body });
  check("sin Idempotency-Key 400", (await pedir(ruta, { method: "POST", token: adminTienda, body: { id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 1 } })).status === 400);
  check("pedir a la propia tienda 400", (await solicitud({ id_tienda_origen: TIENDA, id_medicamento: idMed, cantidad: 1 })).status === 400);
  for (const mala of [0, -2, 1.5, "x", 10001]) check(`cantidad inválida (${mala}) 400`, (await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: mala })).status === 400);
  check("tienda origen inexistente 400", (await solicitud({ id_tienda_origen: 99999999, id_medicamento: idMed, cantidad: 1 })).status === 400);
  check("medicamento inexistente 400", (await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: 99999999, cantidad: 1 })).status === 400);
  const demasiado = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 60 });
  check("criterio 5: más de lo disponible en el origen 409 STOCK_INSUFICIENTE_ORIGEN", demasiado.status === 409 && demasiado.data.codigo === "STOCK_INSUFICIENTE_ORIGEN" && demasiado.data.disponible === 50);
  const origenes = await pedir(`${ruta}/origenes?id_medicamento=${idMed}`, { token: adminTienda });
  check("criterio 1: la tienda origen aparece con su stock disponible", origenes.status === 200 && origenes.data.origenes.some((o) => o.id_tienda === ORIGEN && o.disponible === 50));

  // --- Criterios 1 y 2: traslado completo de 20 unidades
  const key1 = nuevaKey();
  const t1 = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 20 }, key1);
  check("solicitar un traslado 201 SOLICITADO", t1.status === 201 && t1.data.estado === "SOLICITADO" && t1.data.id_tienda_destino === TIENDA, `${t1.status} ${t1.data.mensaje || ""}`);
  const id1 = t1.data.id_traslado;
  check("reintento con la misma clave: el mismo traslado", (await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 20 }, key1)).data.id_traslado === id1);
  check("un solo traslado tras el reintento", Number((await uno(central, "select count(*) as n from traslado where idempotency_key = $1", [key1])).n) === 1);
  check("la tienda destino guarda su copia PENDIENTE", (await enDestino(id1))?.estado_local === "PENDIENTE");
  check("lo comprometido descuenta la disponibilidad: quedan 30", (await pedir(`${ruta}/origenes?id_medicamento=${idMed}`, { token: adminTienda })).data.origenes.find((o) => o.id_tienda === ORIGEN)?.disponible === 30);
  check("otra solicitud que ya no cabe (40 de 30) 409", (await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 40 })).data.codigo === "STOCK_INSUFICIENTE_ORIGEN");

  await origen("pull");
  check("criterio 2: la tienda origen descontó 20 (50 → 30)", (await stockOrigen(L1)) === 30);
  check("la tienda origen marca el traslado DESCONTADO", (await enOrigen(id1))?.estado_local === "DESCONTADO");
  const movSalida = await sqlOrigen("select tipo_movimiento, cantidad, id_empleado, rol_tienda_traslado, referencia_documento from movimiento_inventario where id_traslado = $1", [id1]);
  check("movimiento TRASLADO_SALIDA ligado al traslado, hecho por el sistema", movSalida.length === 1 && movSalida[0].tipo_movimiento === "TRASLADO_SALIDA" && movSalida[0].cantidad === 20 && movSalida[0].id_empleado === null && movSalida[0].rol_tienda_traslado === "ORIGEN" && movSalida[0].referencia_documento === `TR-${id1}`);
  // Entrega duplicada de la orden (un pull que se reintenta): no descuenta otra vez.
  const evDescontar = (await uno(central, "select id_evento from replica_evento where tipo_evento = 'TRASLADO_DESCONTAR' and id_tienda_destino = $1 and (payload ->> 'id_traslado')::int = $2", [ORIGEN, id1])).id_evento;
  await origen("reaplicar", { idEvento: evDescontar });
  check("la orden repetida no descuenta dos veces", (await stockOrigen(L1)) === 30 && (await sqlOrigen("select count(*)::int as n from movimiento_inventario where id_traslado = $1", [id1]))[0].n === 1);

  check("hasta que la tienda origen responde, el central espera (SOLICITADO)", (await estadoCentral(id1)).estado === "SOLICITADO");
  await origen("flush");
  check("el central pasa a EN_TRANSITO con los lotes que salieron", (await estadoCentral(id1)).estado === "EN_TRANSITO" && (await uno(central, "select lotes from detalle_traslado where id_traslado = $1", [id1])).lotes?.[0]?.numero_lote === `T17-${S}-1`);
  await pullReplica();
  const lotesD = await lotesDestino();
  check("criterio 2: la tienda destino ingresó 20 en el mismo lote, caducidad y proveedor", lotesD.length === 1 && lotesD[0].numero_lote === `T17-${S}-1` && lotesD[0].fecha_caducidad === fechaL1 && lotesD[0].id_proveedor === proveedor && lotesD[0].cantidad_disponible === 20, JSON.stringify(lotesD));
  check("la tienda destino marca el traslado RECIBIDO", (await enDestino(id1))?.estado_local === "RECIBIDO");
  await flushOutbox();
  check("el central lo completa (COMPLETADO)", (await estadoCentral(id1)).estado === "COMPLETADO");
  // Entrega duplicada de la respuesta del destino al central: no cambia nada.
  const respuesta = (await local.query("select idempotency_key, tipo_evento, payload from outbox_sync where tipo_evento = 'TRASLADO_RECIBIDO' and (payload ->> 'id_traslado')::int = $1", [id1])).rows[0];
  await aplicarRespuestaCentral(TIENDA, respuesta);
  check("la respuesta repetida no altera el traslado", (await estadoCentral(id1)).estado === "COMPLETADO");
  await avanzar(1);
  check("las dos tiendas explican lo mismo (estado de red COMPLETADO)", (await enOrigen(id1))?.estado_red === "COMPLETADO" && (await enDestino(id1))?.estado_red === "COMPLETADO");

  // --- Criterio 4: auditable en ambas tiendas (y en el central)
  const audD = (await local.query("select accion, id_empleado from registro_actividad where entidad_afectada = 'traslado' and id_entidad_afectada = $1 order by id_registro", [id1])).rows;
  const audO = await sqlOrigen("select accion, detalle from registro_actividad where entidad_afectada = 'traslado' and id_entidad_afectada = $1 order by id_registro", [id1]);
  const audC = (await central.query("select accion from registro_actividad_central where entidad_afectada = 'traslado' and id_entidad_afectada = $1 order by id_registro", [id1])).rows.map((r) => r.accion);
  check("auditoría en la tienda destino: solicitud (por el administrador) e ingreso", audD.some((a) => a.accion === "TRASLADO_SOLICITAR" && a.id_empleado != null) && audD.some((a) => a.accion === "TRASLADO_ENTRADA"), JSON.stringify(audD));
  check("auditoría en la tienda origen: la salida, con quién la pidió", audO.some((a) => a.accion === "TRASLADO_SALIDA" && a.detalle.includes("Luis Mora")), JSON.stringify(audO));
  check("auditoría en el central: solicitud, en tránsito y completado", ["TRASLADO_SOLICITAR", "TRASLADO_EN_TRANSITO", "TRASLADO_COMPLETADO"].every((a) => audC.includes(a)), audC.join(","));

  // --- Criterio 3: el ingreso falla en destino y el origen se compensa solo
  const fechaL2 = await caduca(100); // vence antes que L1: por FEFO sale primero
  const L2 = (await sqlOrigen(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, $4, 10, 10, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `T17-${S}-2`, fechaL2],
  ))[0].id_lote;
  await origen("stock", { ids: [idMed] });
  await origen("flush");
  // En la tienda destino ya existe un lote con ese número y otra caducidad: el ingreso no puede hacerse.
  const conflictivo = (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + 50, 3, 3, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `T17-${S}-2`],
  )).rows[0].id_lote;
  const t2 = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 5 });
  const id2 = t2.data.id_traslado;
  check("segundo traslado solicitado (5)", t2.status === 201);
  await origen("pull");
  check("FEFO: sale del lote que vence antes (L2: 10 → 5)", (await stockOrigen(L2)) === 5 && (await stockOrigen(L1)) === 30);
  await origen("flush");
  await pullReplica();
  const fallo = await enDestino(id2);
  check("el ingreso falla en la tienda destino (FALLIDO, con el motivo)", fallo?.estado_local === "FALLIDO" && /LOTE|lote/.test(fallo.motivo ?? ""), JSON.stringify(fallo));
  check("y no deja nada a medias: el lote del destino no cambió", Number((await uno(local, "select cantidad_disponible from lote where id_lote = $1", [conflictivo])).cantidad_disponible) === 3 && (await local.query("select 1 from movimiento_inventario where id_traslado = $1", [id2])).rowCount === 0);
  await flushOutbox();
  check("el central pasa a COMPENSANDO y ordena la compensación", (await estadoCentral(id2)).estado === "COMPENSANDO" && Number((await uno(central, "select count(*) as n from replica_evento where tipo_evento = 'TRASLADO_COMPENSAR' and (payload ->> 'id_traslado')::int = $1", [id2])).n) === 1);
  await origen("pull");
  check("criterio 3: la tienda origen repuso automáticamente las 5 unidades al mismo lote (L2: 5 → 10)", (await stockOrigen(L2)) === 10);
  check("la tienda origen marca el traslado COMPENSADO", (await enOrigen(id2))?.estado_local === "COMPENSADO");
  const evComp = (await uno(central, "select id_evento from replica_evento where tipo_evento = 'TRASLADO_COMPENSAR' and (payload ->> 'id_traslado')::int = $1", [id2])).id_evento;
  await origen("reaplicar", { idEvento: evComp });
  check("la compensación repetida no repone dos veces", (await stockOrigen(L2)) === 10);
  await origen("flush");
  check("el central cierra la saga en COMPENSADO", (await estadoCentral(id2)).estado === "COMPENSADO");
  await avanzar(1);
  check("las dos tiendas explican lo mismo (COMPENSADO)", (await enOrigen(id2))?.estado_red === "COMPENSADO" && (await enDestino(id2))?.estado_red === "COMPENSADO");
  const movs2 = await sqlOrigen("select tipo_movimiento, sum(cantidad)::int as c from movimiento_inventario where id_traslado = $1 group by 1 order by 1", [id2]);
  check("en el origen la salida y la compensación se anulan (5 y 5)", JSON.stringify(movs2) === JSON.stringify([{ tipo_movimiento: "TRASLADO_ENTRADA", c: 5 }, { tipo_movimiento: "TRASLADO_SALIDA", c: 5 }]), JSON.stringify(movs2));
  check("auditoría de la compensación en el origen y del fallo en el destino",
    (await sqlOrigen("select 1 from registro_actividad where accion = 'TRASLADO_COMPENSADO' and id_entidad_afectada = $1", [id2])).length === 1 &&
      (await local.query("select 1 from registro_actividad where accion = 'TRASLADO_INGRESO_FALLIDO' and id_entidad_afectada = $1", [id2])).rowCount === 1);

  // El lote en conflicto se retira de la tienda destino (no tiene movimientos) para que los traslados siguientes ingresen.
  await local.query("delete from lote where id_lote = $1", [conflictivo]);

  // --- Criterio 5: el central creía que había stock, pero la tienda origen ya no lo tiene (dato del consolidado viejo)
  await sqlOrigen("update lote set cantidad_disponible = 0, estado = 'AGOTADO' where id_lote = $1", [L1]); // se vendió sin publicarlo aún
  const t3 = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 25 });
  const id3 = t3.data.id_traslado;
  check("con el consolidado viejo el central acepta la solicitud", t3.status === 201, `${t3.status} ${t3.data.mensaje || ""}`);
  await origen("pull");
  const rechazo = await enOrigen(id3);
  check("la tienda origen la rechaza: no queda en negativo ni descuenta nada", rechazo?.estado_local === "RECHAZADO" && (await stockOrigen(L2)) === 10 && (await stockOrigen(L1)) === 0 && (await sqlOrigen("select count(*)::int as n from movimiento_inventario where id_traslado = $1", [id3]))[0].n === 0, JSON.stringify(rechazo));
  await origen("flush");
  check("el central marca FALLIDO con el motivo", (await estadoCentral(id3)).estado === "FALLIDO" && /10 unidades/.test((await estadoCentral(id3)).motivo ?? ""));
  await pullReplica();
  check("la tienda destino deja de esperarlo (RECHAZADO)", (await enDestino(id3))?.estado_local === "RECHAZADO" && (await enDestino(id3))?.estado_red === "FALLIDO");
  check("ningún lote de la tienda origen quedó negativo", (await sqlOrigen("select count(*)::int as n from lote where cantidad_disponible < 0"))[0].n === 0);

  // --- Dos solicitudes a la vez que juntas no caben
  await origen("stock", { ids: [idMed] }); // el consolidado vuelve a la realidad: 10 unidades
  await origen("flush");
  const [a, b] = await Promise.all([
    solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 6 }),
    solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 6 }),
  ]);
  check("dos solicitudes simultáneas de 6 sobre 10: una entra y la otra 409", [a.status, b.status].sort().join(",") === "201,409", `${a.status},${b.status}`);
  const id4 = (a.status === 201 ? a : b).data.id_traslado;
  await avanzar(2);
  check("la que entró se completa", (await estadoCentral(id4)).estado === "COMPLETADO" && (await stockOrigen(L2)) === 4);

  // --- Sin conexión
  link.estado = "offline";
  const sinRed = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 1 });
  check("sin central: solicitar 503 SIN_CONEXION", sinRed.status === 503 && sinRed.data.codigo === "SIN_CONEXION");
  const listaOffline = await pedir(ruta, { token: adminTienda });
  check("sin central: la tienda consulta sus traslados", listaOffline.status === 200 && listaOffline.data.traslados.some((t) => t.id_traslado === id1 && t.rol_tienda === "DESTINO"));
  link.estado = "online";
  // La tienda origen sin conexión: la orden espera en el central y se ejecuta al reconectar.
  await origen("conectividad", { estado: "offline" });
  const t5 = await solicitud({ id_tienda_origen: ORIGEN, id_medicamento: idMed, cantidad: 2 });
  const id5 = t5.data.id_traslado;
  await origen("pull");
  check("con la tienda origen sin conexión el traslado espera (SOLICITADO) y no se descuenta", (await estadoCentral(id5)).estado === "SOLICITADO" && (await stockOrigen(L2)) === 4);
  await origen("conectividad", { estado: "online" });
  await avanzar(2);
  check("al reconectar la saga sigue y se completa", (await estadoCentral(id5)).estado === "COMPLETADO" && (await stockOrigen(L2)) === 2);

  // --- Resultado final comparable en las tres bases
  const totalSalido = (await sqlOrigen("select coalesce(sum(case when tipo_movimiento = 'TRASLADO_SALIDA' then cantidad else -cantidad end), 0)::int as n from movimiento_inventario where id_traslado is not null and rol_tienda_traslado = 'ORIGEN'"))[0].n;
  const totalEntrado = Number((await uno(local, "select coalesce(sum(m.cantidad), 0) as n from movimiento_inventario m join lote l on l.id_lote = m.id_lote where l.id_medicamento = $1 and m.tipo_movimiento = 'TRASLADO_ENTRADA'", [idMed])).n);
  check("lo que salió neto del origen (20 + 6 + 2) es lo que entró al destino", totalSalido === 28 && totalEntrado === 28, `${totalSalido} / ${totalEntrado}`);
  const consola = await pedir("/api/central/traslados", { token: general });
  check("la consola de red ve todos los traslados de la corrida con su estado", consola.status === 200 && [id1, id2, id3].every((id) => consola.data.traslados.some((t) => t.id_traslado === id)));
  const listaDestino = await pedir(ruta, { token: adminTienda });
  check("la lista de la tienda muestra el estado de red de cada traslado", listaDestino.data.traslados.find((t) => t.id_traslado === id2)?.estado_red === "COMPENSADO");
} finally {
  link.estado = "online";
  await origen("fin").catch(() => {});
  hijo.kill();
  // La tienda de la corrida se desactiva (no se puede borrar: tiene traslados) y su base de prueba se borra.
  const t = await uno(central, "select version_tienda from tienda where id_tienda = $1", [ORIGEN]).catch(() => null);
  if (t) await pedir(`/api/central/tiendas/${ORIGEN}/desactivar`, { method: "POST", token: general, key: nuevaKey(), body: { version_tienda: Number(t.version_tienda) } });
  await local.query(`drop schema if exists ${ESQUEMA} cascade`).catch((error) => console.error("esquema", error.message));
  await desactivarMedicamentos("id_medicamento = $1", [idMed]);
  await local.query("update medicamento_ref set activo = false where id_medicamento = $1", [idMed]);
  await flushOutbox().catch(() => {});
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
