// Pruebas de HU-02 (lotes, movimientos, recepción, ajustes). ESCRIBE en las bases del .env:
// ejecutar contra un clon o una rama de Neon, nunca contra la base principal.
import crypto from "crypto";
import { central, local, runtime, withTx } from "../apps/api/db.mjs";
import { migrate } from "../apps/api/migrate.mjs";
import { login, autorizar } from "../apps/api/auth.mjs";
import { link, flushOutbox, pullReplica } from "../apps/api/sync.mjs";
import { seedLocalDemo } from "../apps/api/demo.mjs";
import { conIdempotencia } from "../apps/api/idempotencia.mjs";
import { registrarMovimiento } from "../apps/api/inventario/movimientos.mjs";
import {
  ajustarLote,
  historialLote,
  listarPedidosPendientes,
  recibirPedido,
  registrarLote,
} from "../apps/api/inventario/lotes.mjs";

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}
async function error(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const sufijo = Date.now().toString(36).toUpperCase();
const enDias = async (dias) => (await local.query("select (current_date + $1::int)::text as f", [dias])).rows[0].f;
const contar = async (sql, valores = []) => Number((await local.query(sql, valores)).rows[0].n);

await migrate();
await pullReplica();
await seedLocalDemo(runtime.tiendaId);
const idTienda = runtime.tiendaId;

const sesionAdmin = await login({ nodo: "local", usuario: "admin.tienda", password: "Farma123", idempotencyKey: crypto.randomUUID() });
const sesionCajero = await login({ nodo: "local", usuario: "cajero1", password: "Farma123", idempotencyKey: crypto.randomUUID() });
check("login admin.tienda", sesionAdmin.status === 200, String(sesionAdmin.status));
const admin = await autorizar(sesionAdmin.body.token, "local", "INVENTARIO_GESTIONAR");
const ctx = { idEmpleado: admin.id_empleado, idTienda };

const med = async (codigo) => (await local.query("select id_medicamento from medicamento_ref where codigo_interno = $1", [codigo])).rows[0].id_medicamento;
const ibuprofeno = await med("MED-002");
const insulina = await med("MED-008");
const proveedor = (await local.query("select id_proveedor from proveedor_ref order by id_proveedor limit 1")).rows[0].id_proveedor;
const caducidad = await enDias(365);
const tx = (fn) => withTx(local, fn);

// --- Registro manual ---
const numero = `L-${sufijo}-1`;
const lote = await tx((c) => registrarLote(c, { id_medicamento: ibuprofeno, id_proveedor: proveedor, numero_lote: numero, fecha_caducidad: caducidad, cantidad: 100 }, ctx));
check("lote nuevo DISPONIBLE con 100", lote.nuevo && lote.estado === "DISPONIBLE" && lote.cantidad_disponible === 100, JSON.stringify({ e: lote.estado, c: lote.cantidad_disponible }));
const mov1 = (await local.query("select * from movimiento_inventario where id_lote = $1", [lote.id_lote])).rows;
check("movimiento ENTRADA +100 con responsable y hora", mov1.length === 1 && mov1[0].tipo_movimiento === "ENTRADA" && mov1[0].sentido === 1 && mov1[0].cantidad === 100 && mov1[0].id_empleado === admin.id_empleado && mov1[0].fecha_hora instanceof Date);
check("auditoría LOTE_REGISTRAR", (await contar("select count(*) as n from registro_actividad where accion = 'LOTE_REGISTRAR' and id_entidad_afectada = $1", [lote.id_lote])) === 1);

// --- Obligatorios (criterios 1 y 5) ---
const lotesAntes = await contar("select count(*) as n from lote");
const base = { id_medicamento: ibuprofeno, id_proveedor: proveedor, numero_lote: `L-${sufijo}-X`, fecha_caducidad: caducidad, cantidad: 5 };
for (const [campo, cambio] of [
  ["numero_lote", { numero_lote: "" }],
  ["numero_lote", { numero_lote: "   " }],
  ["fecha_caducidad", { fecha_caducidad: "" }],
  ["id_proveedor", { id_proveedor: null }],
]) {
  const e = await error(() => tx((c) => registrarLote(c, { ...base, ...cambio }, ctx)));
  check(`obligatorio ${campo} (${JSON.stringify(cambio)})`, e?.status === 400 && e.codigo === "CAMPO_OBLIGATORIO" && e.extra.campo === campo, e?.message);
}
const vencido = await error(() => tx(async (c) => registrarLote(c, { ...base, fecha_caducidad: await enDias(-1) }, ctx)));
check("lote vencido rechazado", vencido?.status === 400 && vencido.message.includes("posterior a hoy"), vencido?.message);
const fechaMala = await error(() => tx((c) => registrarLote(c, { ...base, fecha_caducidad: "2027-02-31" }, ctx)));
check("fecha imposible rechazada", fechaMala?.status === 400, fechaMala?.message);
check("rechazos sin escrituras", (await contar("select count(*) as n from lote")) === lotesAntes);

// --- Mismo lote ---
const inconsistente = await error(() => tx(async (c) => registrarLote(c, { ...base, numero_lote: numero, fecha_caducidad: await enDias(400) }, ctx)));
check("mismo lote con otra caducidad: 409 LOTE_INCONSISTENTE", inconsistente?.status === 409 && inconsistente.codigo === "LOTE_INCONSISTENTE");
const suma = await tx((c) => registrarLote(c, { ...base, numero_lote: numero, cantidad: 20 }, ctx));
check("mismo lote y caducidad suma 20", !suma.nuevo && suma.cantidad_disponible === 120, String(suma.cantidad_disponible));

// --- Ajustes (columna sentido) ---
const resta = await tx((c) => ajustarLote(c, lote.id_lote, { sentido: "RESTA", cantidad: 5, motivo: "Blísteres dañados" }, ctx));
check("ajuste resta 5 → 115", resta.cantidad_disponible === 115 && resta.movimiento.saldo === 115);
const sumaAj = await tx((c) => ajustarLote(c, lote.id_lote, { sentido: "SUMA", cantidad: 2, motivo: "Sobrante en conteo físico" }, ctx));
check("ajuste suma 2 → 117", sumaAj.cantidad_disponible === 117);
const sinMotivo = await error(() => tx((c) => ajustarLote(c, lote.id_lote, { sentido: "RESTA", cantidad: 1, motivo: "" }, ctx)));
check("ajuste sin motivo rechazado", sinMotivo?.status === 400 && sinMotivo.extra.campo === "motivo");
const sinSentido = await error(() => tx((c) => ajustarLote(c, lote.id_lote, { cantidad: 1, motivo: "Prueba sin sentido" }, ctx)));
check("ajuste sin sentido rechazado", sinSentido?.status === 400 && sinSentido.extra.campo === "sentido");
const checkBase = await error(() =>
  local.query(
    "insert into movimiento_inventario (id_lote, tipo_movimiento, sentido, cantidad, id_empleado) values ($1, 'VENTA', 1, 1, $2)",
    [lote.id_lote, admin.id_empleado],
  ),
);
check("la base rechaza VENTA con sentido +1", checkBase?.constraint === "movimiento_sentido_check", checkBase?.message);

// --- Stock insuficiente y concurrencia (RNF-06) ---
const chico = await tx((c) => registrarLote(c, { ...base, numero_lote: `L-${sufijo}-C`, cantidad: 10 }, ctx));
const insuf = await error(() => tx((c) => ajustarLote(c, chico.id_lote, { sentido: "RESTA", cantidad: 11, motivo: "Prueba de exceso" }, ctx)));
check("salida mayor al saldo: 409 STOCK_INSUFICIENTE", insuf?.status === 409 && insuf.codigo === "STOCK_INSUFICIENTE");
const concurrentes = await Promise.allSettled([
  tx((c) => ajustarLote(c, chico.id_lote, { sentido: "RESTA", cantidad: 6, motivo: "Concurrente A" }, ctx)),
  tx((c) => ajustarLote(c, chico.id_lote, { sentido: "RESTA", cantidad: 6, motivo: "Concurrente B" }, ctx)),
]);
const okConc = concurrentes.filter((r) => r.status === "fulfilled").length;
const saldoConc = (await local.query("select cantidad_disponible from lote where id_lote = $1", [chico.id_lote])).rows[0].cantidad_disponible;
check("dos ajustes concurrentes de 6 sobre 10: uno pasa, saldo 4", okConc === 1 && saldoConc === 4 && concurrentes.some((r) => r.reason?.codigo === "STOCK_INSUFICIENTE"), `ok=${okConc} saldo=${saldoConc}`);

// --- Historial (criterio 4) ---
const hist = await historialLote(local, lote.id_lote);
check(
  "historial con saldos 100, 120, 115, 117 y consistente",
  JSON.stringify(hist.movimientos.map((m) => m.saldo)) === JSON.stringify([100, 120, 115, 117]) && hist.consistente && hist.movimientos.every((m) => m.empleado),
  JSON.stringify(hist.movimientos.map((m) => m.saldo)),
);

// --- Lote vencido: solo AJUSTE ---
const loteVencido = (
  await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date - 1, 8, 8, 'DISPONIBLE') returning id_lote`,
    [ibuprofeno, proveedor, `L-${sufijo}-V`],
  )
).rows[0].id_lote;
const ventaVencida = await error(() => tx((c) => registrarMovimiento(c, { idLote: loteVencido, tipo: "VENTA", cantidad: 1, idEmpleado: admin.id_empleado, idTienda })));
check("no se vende de un lote vencido", ventaVencida?.status === 409 && ventaVencida.codigo === "LOTE_NO_DISPONIBLE");
const bajaVencido = await tx((c) => ajustarLote(c, loteVencido, { sentido: "RESTA", cantidad: 8, motivo: "Vencido" }, ctx));
check("un AJUSTE da de baja el vencido", bajaVencido.cantidad_disponible === 0 && bajaVencido.estado === "AGOTADO");

// --- Recepción de pedido (RF-23) ---
const pendientes = await listarPedidosPendientes(local);
let pedido = pendientes.find((p) => p.lineas.some((l) => l.cantidad_recibida < l.cantidad_solicitada));
if (!pedido) {
  const nuevo = await local.query(
    `insert into pedido (id_proveedor, id_empleado_solicitante, origen_solicitud) values ($1, $2, 'MANUAL') returning id_pedido`,
    [proveedor, admin.id_empleado],
  );
  await local.query("insert into detalle_pedido (id_pedido, id_medicamento, cantidad_solicitada) values ($1, $2, 30), ($1, $3, 20)", [
    nuevo.rows[0].id_pedido,
    ibuprofeno,
    insulina,
  ]);
  pedido = (await listarPedidosPendientes(local)).find((p) => p.id_pedido === nuevo.rows[0].id_pedido);
}
const [l1, l2] = pedido.lineas;
const exceso = await error(() =>
  tx((c) => recibirPedido(c, pedido.id_pedido, { lineas: [{ id_medicamento: l1.id_medicamento, numero_lote: `P-${sufijo}-1`, fecha_caducidad: caducidad, cantidad: l1.cantidad_solicitada + 1 }] }, ctx)),
);
check("no se recibe más de lo pedido", exceso?.status === 400 && exceso.message.includes("pendientes"));
const parcial = await tx((c) =>
  recibirPedido(c, pedido.id_pedido, { lineas: [{ id_medicamento: l1.id_medicamento, numero_lote: `P-${sufijo}-1`, fecha_caducidad: caducidad, cantidad: l1.cantidad_solicitada }] }, ctx),
);
check("recepción parcial", parcial.estado === "RECIBIDO_PARCIAL");
const total = await tx((c) =>
  recibirPedido(c, pedido.id_pedido, { lineas: [{ id_medicamento: l2.id_medicamento, numero_lote: `P-${sufijo}-2`, fecha_caducidad: caducidad, cantidad: l2.cantidad_solicitada }] }, ctx),
);
const pedidoFinal = (await local.query("select estado, fecha_recepcion from pedido where id_pedido = $1", [pedido.id_pedido])).rows[0];
check("recepción total con fecha", total.estado === "RECIBIDO_TOTAL" && pedidoFinal.fecha_recepcion != null);
const lotesPedido = (await local.query("select l.id_proveedor, m.referencia_documento from lote l join movimiento_inventario m using (id_lote) where l.id_lote = any($1)", [total.lotes.concat(parcial.lotes)])).rows;
const provPedido = (await local.query("select id_proveedor from pedido where id_pedido = $1", [pedido.id_pedido])).rows[0].id_proveedor;
check("lotes del pedido con su proveedor y referencia", lotesPedido.every((r) => r.id_proveedor === provPedido && r.referencia_documento === `PEDIDO-${pedido.id_pedido}`));
const cerrado = await error(() => tx((c) => recibirPedido(c, pedido.id_pedido, { lineas: [{ id_medicamento: l2.id_medicamento, numero_lote: "Z", fecha_caducidad: caducidad, cantidad: 1 }] }, ctx)));
check("pedido cerrado no admite recepción", cerrado?.status === 409 && cerrado.codigo === "PEDIDO_CERRADO");

// --- Idempotencia (doble clic) ---
const key = crypto.randomUUID();
const cuerpo = { id_medicamento: ibuprofeno, id_proveedor: proveedor, numero_lote: `L-${sufijo}-I`, fecha_caducidad: caducidad, cantidad: 7 };
const operar = (k, b) => conIdempotencia(local, { key: k, operacion: "LOTE_REGISTRAR", idEmpleado: admin.id_empleado, body: b }, async (c) => ({ status: 201, body: await registrarLote(c, b, ctx) }));
const [d1, d2] = await Promise.all([operar(key, cuerpo), operar(key, cuerpo)]);
const movsIdem = await contar("select count(*) as n from movimiento_inventario m join lote l using (id_lote) where l.numero_lote = $1", [cuerpo.numero_lote]);
check("doble clic simultáneo: una sola entrada", movsIdem === 1 && d1.body.id_lote === d2.body.id_lote, `movimientos=${movsIdem}`);
const d3 = await operar(key, cuerpo);
check("reintento devuelve la misma respuesta", d3.repetido === true && d3.status === 201 && d3.body.id_lote === d1.body.id_lote);
const otraCarga = await error(() => operar(key, { ...cuerpo, cantidad: 8 }));
check("misma clave con otros datos: 409", otraCarga?.status === 409 && otraCarga.codigo === "IDEMPOTENCY_CONFLICT");

// --- Permisos (RNF-01) ---
const denegadosAntes = await contar("select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'INVENTARIO_GESTIONAR'");
const cajeroEscribe = await error(() => autorizar(sesionCajero.body.token, "local", "INVENTARIO_GESTIONAR"));
const denegadosDespues = await contar("select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'INVENTARIO_GESTIONAR'");
check("cajero no registra lotes: 403 y queda ACCESO_DENEGADO", cajeroEscribe?.status === 403 && denegadosDespues === denegadosAntes + 1);
const cajeroLee = await autorizar(sesionCajero.body.token, "local", "INVENTARIO_CONSULTAR");
check("cajero sí consulta historial", cajeroLee.id_empleado != null);
const sinSesion = await error(() => autorizar("token-falso", "local", "INVENTARIO_CONSULTAR"));
check("sin sesión: 401", sinSesion?.status === 401);

// --- Offline (RNF-04) y publicación de stock (HU-01) ---
const estadoPrevio = link.estado;
link.estado = "offline";
const offline = await tx((c) => registrarLote(c, { ...base, numero_lote: `L-${sufijo}-O`, cantidad: 3 }, ctx));
const pendienteOutbox = await contar("select count(*) as n from outbox_sync where tipo_evento = 'STOCK_SNAPSHOT' and estado = 'PENDIENTE'");
check("sin central el lote se registra y el stock queda en el outbox", offline.cantidad_disponible === 3 && pendienteOutbox > 0);
const sinEnvio = await flushOutbox();
check("offline no envía", sinEnvio.sent === 0);
link.estado = estadoPrevio === "offline" ? "online" : estadoPrevio;
await flushOutbox();
const stockLocal = await contar(
  `select coalesce(sum(cantidad_disponible), 0) as n from lote
   where id_medicamento = $1 and estado = 'DISPONIBLE' and fecha_caducidad >= current_date`,
  [ibuprofeno],
);
const consolidado = await central.query("select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [idTienda, ibuprofeno]);
check("al reconectar el central tiene el stock vendible de la tienda", Number(consolidado.rows[0]?.cantidad_disponible) === stockLocal, `central=${consolidado.rows[0]?.cantidad_disponible} local=${stockLocal}`);

// --- Bitácora solo de inserción (RNF-10): el API no expone rutas de edición ---
const { crearRouter } = await import("../apps/api/http.mjs");
const lotesRutas = (await import("../apps/api/routes/lotes.mjs")).default;
const router = crearRouter().usar(lotesRutas);
const escritura = ["PUT", "PATCH", "DELETE"].some((m) => router.buscar(m, `/api/local/lotes/${lote.id_lote}/movimientos`));
check("no hay rutas para editar o borrar movimientos", !escritura);

console.log(fallos.length ? `\n${fallos.length} FALLO(S)\n- ${fallos.join("\n- ")}` : "\nTODO OK");
await central.end();
await local.end();
process.exit(fallos.length ? 1 : 0);
