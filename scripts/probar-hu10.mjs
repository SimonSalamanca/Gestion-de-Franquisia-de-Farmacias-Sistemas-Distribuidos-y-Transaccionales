// Pruebas de HU-10 por las rutas reales de app.mjs: motivo obligatorio, reingreso al lote de origen, distinción entre
// anulación total y devolución parcial, auditoría, y los límites (una sola anulación, nunca más de lo vendido), con
// concurrencia, garantías de la base, operación sin conexión y consolidado en el central.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las facturas y notas son permanentes (los medicamentos de prueba quedan inactivos).
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

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
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);
const centavos = (t) => Math.round(Number(t) * 100);
const S = Date.now().toString(36).toUpperCase();
const TIENDA = 1;

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}
async function crearMedicamento(sufijo, { precio, tasa }) {
  const r = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto)
               values ($1, $2, 'prueba de devoluciones', false, $3) returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
    [`HU10-${S}-${sufijo}`, `Prueba Devoluciones ${S}-${sufijo}`, tasa],
  );
  await central.query("insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, $2, now()::timestamp - interval '1 hour')", [r.rows[0].id_medicamento, precio]);
  return r.rows[0].id_medicamento;
}
const idB = await crearMedicamento("B", { precio: "2500.00", tasa: 19 });
const idE = await crearMedicamento("E", { precio: "1000.50", tasa: 19 });
await migrate();
await pullReplica();
async function crearLote(idMed, sufijo, cantidad) {
  return (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + 200, $4, $4, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `L10-${S}-${sufijo}`, cantidad],
  )).rows[0].id_lote;
}
const loteB = await crearLote(idB, "B1", 100);
const loteE = await crearLote(idE, "E1", 100);
const stock = async (idLote) => (await local.query("select cantidad_disponible::int as n from lote where id_lote = $1", [idLote])).rows[0].n;

try {
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  check("logins demo", Boolean(cajero && adminTienda));
  const metodos = (await pedir("/api/local/ventas/metodos-pago", { token: cajero })).data.metodos;
  const idMetodo = (n) => metodos.find((m) => m.nombre === n).id_metodo_pago;
  const [efectivo, debito] = [idMetodo("efectivo"), idMetodo("tarjeta_debito")];
  const venta = (lineas, pagos) => pedir("/api/local/ventas", { method: "POST", token: cajero, key: nuevaKey(), body: { lineas, pagos } });
  const anular = (id, body, token = cajero, key = nuevaKey()) => pedir(`/api/local/facturas/${id}/anular`, { method: "POST", token, key, body });
  const devolver = (id, body, token = cajero, key = nuevaKey()) => pedir(`/api/local/facturas/${id}/devolver`, { method: "POST", token, key, body });

  check("el cajero recibió FACTURA_ANULAR por la réplica", (await local.query(
    "select 1 from empleado_ref e join rol_permiso_ref rp on rp.id_rol = e.id_rol join permiso_ref p on p.id_permiso = rp.id_permiso where e.usuario = 'cajero1' and p.codigo = 'FACTURA_ANULAR'")).rowCount === 1);

  // --- Ventas de prueba
  // V1: 3 x B (7500 + 19 % = 8925.00) + 3 x E (3001.50 + 570.29 = 3571.79) = 12496.79 pagado en efectivo y débito.
  const v1 = await venta([{ id_medicamento: idB, cantidad: 3 }, { id_medicamento: idE, cantidad: 3 }], [{ id_metodo_pago: efectivo, monto: "5000.00" }, { id_metodo_pago: debito, monto: "7496.79" }]);
  check("venta V1 201 por 12496.79", v1.status === 201 && v1.data.total === "12496.79", `${v1.status} ${v1.data.total}`);
  const v2 = await venta([{ id_medicamento: idB, cantidad: 2 }], [{ id_metodo_pago: efectivo, monto: "5950.00" }]);
  check("venta V2 201", v2.status === 201);
  const stockB0 = await stock(loteB);
  const stockE0 = await stock(loteE);
  check("las líneas de la factura traen su lote", v1.data.lineas.every((l) => Number.isInteger(l.id_lote)));
  const lote = (f, id) => f.lineas.find((l) => l.id_medicamento === id).id_lote;
  check("el lote de la línea es el de origen", lote(v1.data, idB) === loteB && lote(v1.data, idE) === loteE);

  // --- Acceso
  check("sin sesión 401", (await pedir(`/api/local/facturas/${v2.data.id_factura}/devoluciones`)).status === 401);
  check("sin sesión no se anula 401", (await pedir(`/api/local/facturas/${v2.data.id_factura}/anular`, { method: "POST", key: nuevaKey(), body: { motivo: "prueba de acceso" } })).status === 401);

  // --- Criterio 1: motivo obligatorio
  const sinMotivo = await anular(v2.data.id_factura, {});
  check("anular sin motivo 400 MOTIVO_OBLIGATORIO", sinMotivo.status === 400 && sinMotivo.data.codigo === "MOTIVO_OBLIGATORIO", `${sinMotivo.status} ${sinMotivo.data.codigo}`);
  const motivoCorto = await anular(v2.data.id_factura, { motivo: "  ab " });
  check("motivo demasiado corto 400", motivoCorto.status === 400 && motivoCorto.data.codigo === "MOTIVO_OBLIGATORIO");
  const devSinMotivo = await devolver(v1.data.id_factura, { lineas: [{ id_lote: loteB, cantidad: 1 }] });
  check("devolver sin motivo 400 MOTIVO_OBLIGATORIO", devSinMotivo.status === 400 && devSinMotivo.data.codigo === "MOTIVO_OBLIGATORIO");
  check("devolver sin líneas 400", (await devolver(v1.data.id_factura, { motivo: "producto equivocado" })).status === 400);
  const largo = await anular(v2.data.id_factura, { motivo: "x".repeat(301) });
  check("motivo de más de 300 caracteres 400", largo.status === 400);
  check("los rechazos no tocaron nada", (await stock(loteB)) === stockB0 && (await contar(local, "select count(*) as n from anulacion_devolucion where id_factura = $1", [v2.data.id_factura])) === 0 && (await local.query("select estado from factura where id_factura = $1", [v2.data.id_factura])).rows[0].estado === "EMITIDA");

  // --- Devolución parcial (criterios 2, 3, 4)
  const consulta = await pedir(`/api/local/facturas/${v1.data.id_factura}/devoluciones`, { token: cajero });
  check("consulta: 2 líneas, nada devuelto, anulable y devolvible", consulta.status === 200 && consulta.data.lineas.length === 2 && consulta.data.lineas.every((l) => l.devuelta === 0 && l.disponible === l.cantidad) && consulta.data.anulable && consulta.data.devolvible);
  const exceso = await devolver(v1.data.id_factura, { motivo: "devuelve de más", lineas: [{ id_lote: loteB, cantidad: 4 }] });
  check("devolver más de lo vendido 409 DEVOLUCION_EXCEDE", exceso.status === 409 && exceso.data.codigo === "DEVOLUCION_EXCEDE", `${exceso.status} ${exceso.data.codigo}`);
  check("el exceso no tocó el stock", (await stock(loteB)) === stockB0);
  const ajeno = await devolver(v1.data.id_factura, { motivo: "lote de otra factura", lineas: [{ id_lote: 99999999, cantidad: 1 }] });
  check("devolver un lote que no es de la factura 400", ajeno.status === 400, `${ajeno.status} ${ajeno.data.codigo}`);
  check("cantidades inválidas 400", (await devolver(v1.data.id_factura, { motivo: "cantidad rara", lineas: [{ id_lote: loteB, cantidad: 0 }] })).status === 400 && (await devolver(v1.data.id_factura, { motivo: "cantidad rara", lineas: [{ id_lote: loteB, cantidad: 1.5 }] })).status === 400);

  const key1 = nuevaKey();
  const p1 = await devolver(v1.data.id_factura, { motivo: "Cliente devuelve 1 de B y 2 de E", lineas: [{ id_lote: loteB, cantidad: 1 }, { id_lote: loteE, cantidad: 2 }] }, cajero, key1);
  check("devolución parcial 201", p1.status === 201, `${p1.status} ${p1.data.codigo || ""} ${p1.data.mensaje || ""}`);
  // 1 B: 2500.00 + 475.00. 2 E: 2001.00 + round(570.29 * 2/3) = 380.19. Total 5356.19.
  check("distingue devolución parcial", p1.data.nota?.tipo === "DEVOLUCION_PARCIAL" && p1.data.factura.estado === "DEVOLUCION_PARCIAL");
  check("importes de la devolución (subtotal, impuesto, total)", p1.data.nota?.subtotal_devuelto === "4501.00" && p1.data.nota?.impuestos_devueltos === "855.19" && p1.data.nota?.total_devuelto === "5356.19", JSON.stringify(p1.data.nota));
  check("el reingreso va al lote de origen", (await stock(loteB)) === stockB0 + 1 && (await stock(loteE)) === stockE0 + 2);
  const nota1 = p1.data.nota.numero_nota;
  check("la nota está numerada", /^NC-T1-\d{6}$/.test(nota1), nota1);
  const movs = (await local.query("select id_lote, sentido, cantidad, observaciones, id_empleado from movimiento_inventario where tipo_movimiento = 'DEVOLUCION' and referencia_documento = $1 order by id_lote", [nota1])).rows;
  check("un movimiento DEVOLUCION de entrada por lote, con el motivo", movs.length === 2 && movs.every((m) => m.sentido === 1 && m.observaciones.startsWith("Cliente devuelve")) && movs.find((m) => m.id_lote === loteE).cantidad === 2);
  const reint = p1.data.nota.pagos;
  const sumaReint = reint.reduce((s, p) => s + centavos(p.monto), 0);
  check("el reintegro por método suma el total y es proporcional a lo pagado", sumaReint === 535619 && reint.length === 2 && Math.abs(centavos(reint.find((p) => p.id_metodo_pago === efectivo).monto) - Math.round((535619 * 5000) / 12496.79)) <= 1, JSON.stringify(reint));

  // --- Criterio 4: auditoría con usuario, fecha y motivo
  const aud = (await local.query("select r.accion, r.detalle, r.fecha_hora, e.usuario from registro_actividad r join empleado_ref e on e.id_empleado = r.id_empleado where r.accion = 'FACTURA_DEVOLVER' and r.id_entidad_afectada = $1", [v1.data.id_factura])).rows;
  check("la devolución quedó auditada con usuario, fecha y motivo", aud.length === 1 && aud[0].usuario === "cajero1" && aud[0].fecha_hora && aud[0].detalle.includes("Cliente devuelve 1 de B y 2 de E") && aud[0].detalle.includes(nota1), JSON.stringify(aud));
  const audApi = await pedir("/api/local/auditoria?accion=FACTURA_DEVOLVER", { token: adminTienda });
  check("la auditoría de la tienda la lista", audApi.status === 200 && JSON.stringify(audApi.data).includes(nota1), `${audApi.status}`);

  // --- Criterio 5: límites
  const anularConDev = await anular(v1.data.id_factura, { motivo: "intento anular con devoluciones" });
  check("no se anula completa una factura con devoluciones 409", anularConDev.status === 409 && anularConDev.data.codigo === "FACTURA_CON_DEVOLUCIONES", `${anularConDev.status} ${anularConDev.data.codigo}`);
  const repetida = await devolver(v1.data.id_factura, { motivo: "Cliente devuelve 1 de B y 2 de E", lineas: [{ id_lote: loteB, cantidad: 1 }, { id_lote: loteE, cantidad: 2 }] }, cajero, key1);
  check("el reintento con la misma clave devuelve la misma nota sin duplicar", repetida.status === 201 && repetida.data.nota.numero_nota === nota1 && (await stock(loteB)) === stockB0 + 1 && (await contar(local, "select count(*) as n from anulacion_devolucion where id_factura = $1", [v1.data.id_factura])) === 1);
  const excesoAcum = await devolver(v1.data.id_factura, { motivo: "excede lo que queda", lineas: [{ id_lote: loteE, cantidad: 2 }] });
  check("lo ya devuelto cuenta: 2 más de E (queda 1) 409", excesoAcum.status === 409 && excesoAcum.data.disponible === 1);
  const p2 = await devolver(v1.data.id_factura, { motivo: "Devuelve el resto de la factura", lineas: [{ id_lote: loteB, cantidad: 2 }, { id_lote: loteE, cantidad: 1 }] });
  check("la segunda devolución cubre el resto 201", p2.status === 201, `${p2.status} ${p2.data.codigo || ""}`);
  const notas = (await local.query("select impuestos_devueltos::text as i, total_devuelto::text as t from anulacion_devolucion where id_factura = $1", [v1.data.id_factura])).rows;
  check("el impuesto devuelto en partes suma exactamente el de la factura", notas.reduce((s, n) => s + centavos(n.i), 0) === centavos(v1.data.impuestos) && notas.reduce((s, n) => s + centavos(n.t), 0) === centavos(v1.data.total), JSON.stringify(notas));
  const pagosV1 = (await local.query("select id_metodo_pago, sum(monto)::text as m from devolucion_pago r join anulacion_devolucion a using (id_anulacion) where a.id_factura = $1 group by 1 order by 1", [v1.data.id_factura])).rows;
  check("lo reintegrado por método coincide con lo pagado", pagosV1.length === 2 && pagosV1.find((p) => p.id_metodo_pago === efectivo).m === "5000.00" && pagosV1.find((p) => p.id_metodo_pago === debito).m === "7496.79", JSON.stringify(pagosV1));
  check("todo el stock de V1 volvió a sus lotes", (await stock(loteB)) === stockB0 + 3 && (await stock(loteE)) === stockE0 + 3);
  const tercera = await devolver(v1.data.id_factura, { motivo: "ya no queda nada", lineas: [{ id_lote: loteB, cantidad: 1 }] });
  check("nada más se puede devolver 409", tercera.status === 409 && tercera.data.codigo === "DEVOLUCION_EXCEDE");
  const despues = await pedir(`/api/local/facturas/${v1.data.id_factura}/devoluciones`, { token: cajero });
  check("la consulta refleja las 2 notas y que ya no es devolvible", despues.data.notas.length === 2 && despues.data.devolvible === false && despues.data.anulable === false);

  // --- Anulación total
  const v3 = await venta([{ id_medicamento: idB, cantidad: 1 }], [{ id_metodo_pago: efectivo, monto: "2975.00" }]);
  const todo = await devolver(v3.data.id_factura, { motivo: "devolución de todo", lineas: [{ id_lote: loteB, cantidad: 1 }] });
  check("una 'devolución parcial' que cubre toda la factura 409: use anulación", todo.status === 409 && todo.data.codigo === "DEVOLUCION_TOTAL", `${todo.status} ${todo.data.codigo}`);
  const stockAntesAn = await stock(loteB);
  const keyAn = nuevaKey();
  const an = await anular(v2.data.id_factura, { motivo: "Factura emitida por error" }, cajero, keyAn);
  check("anulación total 201", an.status === 201, `${an.status} ${an.data.codigo || ""} ${an.data.mensaje || ""}`);
  check("distingue anulación total", an.data.nota?.tipo === "ANULACION_TOTAL" && an.data.factura.estado === "ANULADA" && an.data.anulable === false && an.data.devolvible === false);
  check("la anulación devuelve el total exacto de la factura", an.data.nota.total_devuelto === v2.data.total && an.data.nota.subtotal_devuelto === v2.data.subtotal && an.data.nota.impuestos_devueltos === v2.data.impuestos);
  check("el stock vuelve a su lote de origen", (await stock(loteB)) === stockAntesAn + 2);
  check("el reintegro es el pago original", an.data.nota.pagos.length === 1 && an.data.nota.pagos[0].id_metodo_pago === efectivo && an.data.nota.pagos[0].monto === "5950.00");
  check("la anulación quedó auditada con el motivo", (await contar(local, "select count(*) as n from registro_actividad where accion = 'FACTURA_ANULAR' and id_entidad_afectada = $1 and detalle like '%Factura emitida por error%'", [v2.data.id_factura])) === 1);
  const otraVez = await anular(v2.data.id_factura, { motivo: "segundo intento de anular" });
  check("no se anula dos veces 409 FACTURA_ANULADA", otraVez.status === 409 && otraVez.data.codigo === "FACTURA_ANULADA", `${otraVez.status} ${otraVez.data.codigo}`);
  const devAnulada = await devolver(v2.data.id_factura, { motivo: "devolver una anulada", lineas: [{ id_lote: loteB, cantidad: 1 }] });
  check("no se devuelve una factura anulada 409", devAnulada.status === 409 && devAnulada.data.codigo === "FACTURA_ANULADA");
  const replayAn = await anular(v2.data.id_factura, { motivo: "Factura emitida por error" }, cajero, keyAn);
  check("reintento de la anulación con la misma clave: misma nota, sin duplicar", replayAn.status === 201 && replayAn.data.nota.numero_nota === an.data.nota.numero_nota && (await stock(loteB)) === stockAntesAn + 2);
  const reimp = await pedir(`/api/local/historial/facturas/${v2.data.id_factura}`, { token: cajero });
  check("la factura anulada se sigue viendo con sus líneas originales y estado ANULADA", reimp.status === 200 && reimp.data.estado === "ANULADA" && JSON.stringify(reimp.data.lineas) === JSON.stringify(v2.data.lineas) && reimp.data.total === v2.data.total);
  check("anular factura inexistente 404", (await anular(99999999, { motivo: "no existe esa factura" })).status === 404);

  // --- Concurrencia: dos cajeros sobre la misma factura
  const v4 = await venta([{ id_medicamento: idB, cantidad: 4 }], [{ id_metodo_pago: efectivo, monto: "11900.00" }]);
  const stockC0 = await stock(loteB);
  const carreraAn = await Promise.all([anular(v4.data.id_factura, { motivo: "primer cajero anula" }, cajero), anular(v4.data.id_factura, { motivo: "segundo cajero anula" }, adminTienda)]);
  const ok = carreraAn.filter((r) => r.status === 201).length;
  check("dos anulaciones simultáneas: una gana y la otra recibe 409", ok === 1 && carreraAn.filter((r) => r.status === 409).length === 1, carreraAn.map((r) => r.status).join(","));
  check("el stock se reingresó una sola vez", (await stock(loteB)) === stockC0 + 4 && (await contar(local, "select count(*) as n from anulacion_devolucion where id_factura = $1", [v4.data.id_factura])) === 1);
  const v5 = await venta([{ id_medicamento: idB, cantidad: 4 }], [{ id_metodo_pago: efectivo, monto: "11900.00" }]);
  const stockD0 = await stock(loteB);
  const carreraDev = await Promise.all([1, 2].map((i) => devolver(v5.data.id_factura, { motivo: `cajero ${i} devuelve 3`, lineas: [{ id_lote: loteB, cantidad: 3 }] })));
  check("dos devoluciones de 3 sobre 4 vendidas: una gana y la otra 409", carreraDev.filter((r) => r.status === 201).length === 1 && carreraDev.filter((r) => r.status === 409).length === 1, carreraDev.map((r) => `${r.status}/${r.data.codigo || ""}`).join(","));
  check("nunca se devolvió más de lo vendido", (await stock(loteB)) === stockD0 + 3);

  // --- Garantías de la base (aunque alguien se salte el API)
  const sql = async (consulta, valores = []) => {
    try {
      await local.query(consulta, valores);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  const idNota = (await local.query("select id_anulacion from anulacion_devolucion where id_factura = $1", [v1.data.id_factura])).rows[0].id_anulacion;
  check("la base impide editar una nota", /no se puede modificar/.test((await sql("update anulacion_devolucion set motivo = 'cambiado a la fuerza' where id_anulacion = $1", [idNota])) ?? ""));
  check("la base impide borrar una nota", /no se puede modificar/.test((await sql("delete from detalle_devolucion where id_anulacion = $1", [idNota])) ?? ""));
  check("la base rechaza un motivo vacío", /motivo_check/.test((await sql("insert into anulacion_devolucion (id_factura, tipo, motivo, id_empleado, numero_nota) values ($1, 'DEVOLUCION_PARCIAL', ' ', 1, 'X')", [v5.data.id_factura])) ?? ""));
  check("la base rechaza anular una factura ya anulada", /FACTURA_ANULADA/.test((await sql("insert into anulacion_devolucion (id_factura, tipo, motivo, id_empleado, numero_nota) values ($1, 'ANULACION_TOTAL', 'segunda anulación directa', 1, 'X')", [v2.data.id_factura])) ?? ""));
  check("la base rechaza devolver más de lo vendido", /DEVOLUCION_EXCEDE/.test((await sql("insert into detalle_devolucion (id_anulacion, id_lote, cantidad_devuelta) select a.id_anulacion, $2, 5 from anulacion_devolucion a where a.id_factura = $1 limit 1", [v5.data.id_factura, loteB])) ?? ""));
  const huerfana = await (async () => {
    const c = await local.connect();
    try {
      await c.query("begin");
      await c.query("insert into anulacion_devolucion (id_factura, tipo, motivo, id_empleado, numero_nota) values ($1, 'DEVOLUCION_PARCIAL', 'nota sin líneas', 1, 'NC-HUERFANA')", [v3.data.id_factura]);
      await c.query("commit");
      return null;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      return e.message;
    } finally {
      c.release();
    }
  })();
  check("la base no deja hacer commit de una nota sin líneas ni inventario", /NOTA_INCOMPLETA/.test(huerfana ?? ""), String(huerfana));
  check("una factura anulada no vuelve a emitida", /ya fue anulada/.test((await sql("update factura set estado = 'EMITIDA' where id_factura = $1", [v2.data.id_factura])) ?? ""));

  // --- Sin conexión con el central, y luego consolidado
  const consolidado = async (metodo) => {
    const r = await central.query("select coalesce(sum(total_vendido), 0)::text as total from venta_consolidada where id_tienda = $1 and id_metodo_pago = $2", [TIENDA, metodo]);
    return centavos(r.rows[0].total);
  };
  await flushOutbox(TIENDA);
  const antesEf = await consolidado(efectivo);
  link.estado = "offline";
  const v6 = await venta([{ id_medicamento: idB, cantidad: 1 }], [{ id_metodo_pago: efectivo, monto: "2975.00" }]);
  const stockF0 = await stock(loteB);
  const off = await anular(v6.data.id_factura, { motivo: "anulada sin conexión" });
  check("sin conexión con el central se anula igual", v6.status === 201 && off.status === 201 && (await stock(loteB)) === stockF0 + 1, `${v6.status} ${off.status}`);
  check("la operación quedó en el outbox", (await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'DEVOLUCION_REGISTRADA' and payload ->> 'numero_nota' = $1", [off.data.nota.numero_nota])) === 1);
  link.estado = "online";
  link.openedUntil = 0;
  const envio = await flushOutbox(TIENDA);
  check("al volver la red el outbox se envía", envio.sent >= 1, String(envio.sent));
  const despuesEf = await consolidado(efectivo);
  // Desde antesEf: la venta v6 suma 2975.00 y su anulación resta 2975.00 (más las notas de V2, V4 y V5 pendientes de envío).
  const pendientes = (await local.query("select payload from outbox_sync where tipo_evento = 'DEVOLUCION_REGISTRADA' and payload ->> 'numero_nota' = $1", [off.data.nota.numero_nota])).rowCount;
  check("el central restó lo reintegrado (la venta y su anulación se compensan)", pendientes === 1 && despuesEf === antesEf, `${antesEf} -> ${despuesEf}`);
  const { aplicarEnCentral } = await import("../apps/api/sync/central.mjs");
  // Evento sin nota detrás: dentro de una transacción que se revierte, para no dejar en venta_consolidada una devolución
  // que no existe (los reportes de HU-05 y la vista de red de HU-16 la mostrarían).
  const evento = { idempotency_key: nuevaKey(), tipo_evento: "DEVOLUCION_REGISTRADA", payload: { fecha: "2026-01-03", total: "10.00", pagos: [{ id_metodo_pago: efectivo, monto: "10.00" }] } };
  const leerEf = async (c) => (await c.query(
    "select coalesce(sum(total_vendido), 0)::text as total, coalesce(sum(total_facturas), 0)::int as facturas from venta_consolidada where id_tienda = $1 and id_metodo_pago = $2",
    [TIENDA, efectivo],
  )).rows[0];
  const cDup = await central.connect();
  try {
    await cDup.query("begin");
    const antesDup = centavos((await leerEf(cDup)).total);
    await aplicarEnCentral(cDup, TIENDA, evento);
    await aplicarEnCentral(cDup, TIENDA, evento);
    check("un evento de devolución duplicado resta una sola vez", antesDup - centavos((await leerEf(cDup)).total) === 1000);
  } finally {
    await cDup.query("rollback");
    cDup.release();
  }
} finally {
  link.estado = "online";
  await central.query("update medicamento set activo = false where codigo_interno like $1", [`HU10-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU10-${S}-%`]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
