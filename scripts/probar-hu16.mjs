import "./lib/owner.mjs";
import { crearEmpleadoPrueba, desactivarEmpleado, desactivarMedicamentos, publicarAltaMedicamento, registrarPrecioCentral } from "./lib/central.mjs";
// Pruebas de HU-16 (vista consolidada de la red) por las rutas reales de app.mjs: consolidación periódica (foto completa,
// sin acumular sin conexión, aplicación idempotente y monótona), frescura por tienda (al día, desactualizada, sin datos),
// ventas por categoría con ventas y devoluciones, filtros por tienda, fechas y categoría, inventario por producto,
// permisos y auditoría, sin conexión y rendimiento con volumen alto (dentro de transacciones que se revierten).
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las facturas y notas son permanentes (los medicamentos de prueba quedan inactivos).
// SIN_VOLUMEN=1 omite la prueba de rendimiento.
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local, withTx } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { aplicarEnCentral } = await import("../apps/api/sync/central.mjs");
const { encolarStockCompleto } = await import("../apps/api/inventario/stock.mjs");
const { vistaConsolidada, inventarioRed } = await import("../apps/api/vista-red.mjs");
const { hashPassword } = await import("../apps/api/crypto.mjs");

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
const S = Date.now().toString(36).toUpperCase();
const TIENDA = 1;
const HOY = (await central.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const pendientesCompletas = async () =>
  Number((await local.query("select count(*) as n from outbox_sync where estado in ('PENDIENTE', 'ERROR') and (payload ->> 'completo')::boolean is true")).rows[0].n);
const en = async (pool, fn) => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
};

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
const [cat1, cat2] = (await central.query("select id_categoria from categoria order by id_categoria limit 2")).rows.map((r) => r.id_categoria);
if (!proveedor || cat2 == null) {
  console.error("Faltan datos demo (proveedor y dos categorías): SEED_DEMO=1");
  process.exit(2);
}
async function crearMedicamento(sufijo, { precio, tasa, categoria }) {
  const r = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo, id_categoria, requiere_receta, tasa_impuesto)
               values ($1, $2, 'prueba de vista de red', $3, false, $4) returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
                select t.id_tienda, m.id_medicamento, 5, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
    [`HU16-${S}-${sufijo}`, `Prueba Vista ${S}-${sufijo}`, categoria, tasa],
  );
  await publicarAltaMedicamento(r.rows[0].id_medicamento);
  await registrarPrecioCentral({ idMedicamento: r.rows[0].id_medicamento, precio: precio });
  return r.rows[0].id_medicamento;
}
const crearLote = async (idMed, sufijo, cantidad) =>
  (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + 200, $4, $4, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `L16-${S}-${sufijo}`, cantidad],
  )).rows[0].id_lote;

let idCuentaControl = null;
try {
  const adminGeneral = await entrar("central", "admin.general");
  const adminTienda = await entrar("local", "admin.tienda");
  const cajero = await entrar("local", "cajero1");
  check("logins demo", Boolean(adminGeneral && adminTienda && cajero));
  const vista = (q = "") => pedir(`/api/central/red/consolidado${q}`, { token: adminGeneral });

  // --- Acceso
  for (const ruta of ["/api/central/red/consolidado", "/api/central/red/inventario", "/api/central/red/filtros"]) {
    check(`${ruta} sin sesión 401`, (await pedir(ruta)).status === 401);
  }
  check("un token del POS no sirve en la vista de red 401", (await pedir("/api/central/red/consolidado", { token: adminTienda })).status === 401);
  // Cuenta de consola con RED_CONTROL pero sin RED_VISIBILIDAD: entra a la consola y la vista le responde 403.
  const rolControl = (await central.query(
    `with r as (insert into rol (nombre) values ($1) returning id_rol),
          p as (insert into rol_permiso (id_rol, id_permiso) select r.id_rol, p.id_permiso from r, permiso p where p.codigo = 'RED_CONTROL' returning 1)
     select id_rol from r`,
    [`hu16_control_${S}`.toLowerCase()],
  )).rows[0].id_rol;
  // Como la app: el rol se publica a las tiendas antes que la cuenta que lo usa (si no, la réplica de la cuenta falla).
  await central.query("select append_replica_evento(null, 'ROL_UPSERT', 1, jsonb_build_object('id_rol', id_rol, 'nombre', nombre)) from rol where id_rol = $1", [rolControl]);
  const usuarioControl = `hu16.control.${S}`.toLowerCase();
  idCuentaControl = await crearEmpleadoPrueba({ usuario: usuarioControl, nombre: "Prueba Control HU16", idRol: rolControl, hash: hashPassword("Farma123") });
  const tokenControl = await entrar("central", usuarioControl);
  const denegadosAntes = Number((await central.query("select count(*) as n from registro_actividad_central where accion = 'ACCESO_DENEGADO' and id_empleado = $1", [idCuentaControl])).rows[0].n);
  const sinPermiso = await pedir("/api/central/red/consolidado", { token: tokenControl });
  check("sin RED_VISIBILIDAD 403", Boolean(tokenControl) && sinPermiso.status === 403 && sinPermiso.data.codigo === "ACCESO_DENEGADO", `${sinPermiso.status}`);
  const denegados = Number((await central.query("select count(*) as n from registro_actividad_central where accion = 'ACCESO_DENEGADO' and id_empleado = $1", [idCuentaControl])).rows[0].n);
  check("el 403 queda en la auditoría central", denegados === denegadosAntes + 1);

  // --- Validación de filtros
  check("periodo inválido 400", (await vista("?desde=2026-11-09&hasta=2026-11-01")).status === 400);
  check("más de 366 días 400", (await vista("?desde=2025-01-01&hasta=2026-01-02")).status === 400);
  check("tienda inexistente 404", (await vista("?tienda=999999")).status === 404);
  check("categoría inexistente 404", (await vista("?categoria=999999")).status === 404);
  check("tienda no numérica 400", (await vista("?tienda=abc")).status === 400);
  const filtros = (await pedir("/api/central/red/filtros", { token: adminGeneral })).data;
  check("filtros: tiendas activas y categorías con 'Sin categoría'", filtros.tiendas?.length > 0 && filtros.categorias?.some((c) => c.id_categoria === 0));

  // --- Tarea 1: consolidación periódica
  await withTx(local, (c) => encolarStockCompleto(c, TIENDA));
  await withTx(local, (c) => encolarStockCompleto(c, TIENDA));
  check("dos fotos completas seguidas: queda una sola pendiente", (await pendientesCompletas()) === 1);
  const foto = (await local.query("select payload from outbox_sync where estado = 'PENDIENTE' and (payload ->> 'completo')::boolean is true")).rows[0].payload;
  const activosLocal = Number((await local.query("select count(*) as n from medicamento_ref where activo")).rows[0].n);
  const idsFoto = new Set(foto.items.map((i) => i.id_medicamento));
  const activosEnFoto = Number((await local.query("select count(*) as n from medicamento_ref where activo and id_medicamento = any($1::int[])", [[...idsFoto]])).rows[0].n);
  check("la foto completa cubre todos los medicamentos activos", activosEnFoto === activosLocal, `${activosEnFoto}/${activosLocal}`);
  link.estado = "offline";
  for (let i = 0; i < 3; i += 1) await withTx(local, (c) => encolarStockCompleto(c, TIENDA));
  check("sin conexión no se acumulan fotos: sigue una sola pendiente", (await pendientesCompletas()) === 1);
  const caida = await vista();
  check("sin conexión la vista responde 503 con la última sincronización", caida.status === 503 && caida.data.codigo === "SIN_CONEXION" && "ultima_sync" in caida.data);
  check("sin conexión el inventario de red responde 503", (await pedir("/api/central/red/inventario", { token: adminGeneral })).status === 503);
  link.estado = "online";
  link.openedUntil = 0;
  await flushOutbox(TIENDA);
  check("al reconectar la foto sube y no queda pendiente", (await pendientesCompletas()) === 0);
  const v1 = (await vista(`?tienda=${TIENDA}`)).data;
  const t1 = v1.tiendas[0];
  check("la tienda queda al día con la hora de su foto", t1?.frescura.estado === "AL_DIA" && t1.frescura.minutos <= 1 && Boolean(t1.frescura.ultima_actualizacion), JSON.stringify(t1?.frescura));
  check("con la foto completa no quedan productos activos sin reporte", t1.inventario.sin_reporte === 0, String(t1.inventario.sin_reporte));
  check("filtro por tienda: solo esa tienda", v1.tiendas.length === 1 && v1.filtros.tienda === TIENDA);

  // Aplicación en el central: idempotente y monótona (una foto vieja no pisa una nueva). Dentro de una transacción revertida.
  await en(central, async (c) => {
    const idMed = foto.items[0].id_medicamento;
    const actual = (await c.query("select cantidad_disponible, fecha_sincronizacion from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [TIENDA, idMed])).rows[0];
    const vieja = { idempotency_key: nuevaKey(), tipo_evento: "STOCK_SNAPSHOT", payload: { calculado_en: "2020-01-01T00:00:00.000Z", items: [{ id_medicamento: idMed, cantidad: 987654 }] } };
    await aplicarEnCentral(c, TIENDA, vieja);
    const tras = (await c.query("select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [TIENDA, idMed])).rows[0];
    check("una foto vieja no pisa una más nueva", tras.cantidad_disponible === actual.cantidad_disponible);
    const nueva = { idempotency_key: nuevaKey(), tipo_evento: "STOCK_SNAPSHOT", payload: { calculado_en: new Date(Date.now() + 60000).toISOString(), items: [{ id_medicamento: idMed, cantidad: 4321 }, { id_medicamento: idMed, cantidad: 4321 }] } };
    await aplicarEnCentral(c, TIENDA, nueva);
    await aplicarEnCentral(c, TIENDA, nueva);
    const tras2 = (await c.query("select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [TIENDA, idMed])).rows[0];
    check("una foto nueva se aplica, también repetida y con ítems duplicados", tras2.cantidad_disponible === 4321);
  });

  // --- Criterio 5: frescura (dentro de transacciones revertidas)
  await en(central, async (c) => {
    await c.query("update inventario_consolidado set fecha_sincronizacion = now()::timestamp - interval '20 minutes' where id_tienda = $1", [TIENDA]);
    await c.query("update venta_consolidada set fecha_sincronizacion = now()::timestamp - interval '20 minutes' where id_tienda = $1", [TIENDA]);
    const r = await vistaConsolidada({}, c);
    const t = r.tiendas.find((x) => x.id_tienda === TIENDA);
    check("tienda sin información reciente: DESACTUALIZADA con sus 20 minutos", t.frescura.estado === "DESACTUALIZADA" && t.frescura.minutos >= 19 && t.frescura.minutos <= 21, JSON.stringify(t.frescura));
    check("el aviso de la red la nombra", r.frescura.estado === "DESACTUALIZADA" && r.frescura.desactualizadas.some((x) => x.id_tienda === TIENDA));
  });
  await en(central, async (c) => {
    const nueva = (await c.query("insert into tienda (nombre, direccion, ciudad, activa) values ($1, 'Calle 1', 'Prueba', true) returning id_tienda", [`Vista ${S}`])).rows[0].id_tienda;
    const r = await vistaConsolidada({}, c);
    const t = r.tiendas.find((x) => x.id_tienda === nueva);
    check("tienda que nunca envió información: SIN_DATOS, no ceros", t?.frescura.estado === "SIN_DATOS" && r.frescura.sin_datos.some((x) => x.id_tienda === nueva));
    // guardia-permitido: transacción que se revierte (no deja cambios)
    await c.query("update tienda set activa = false where id_tienda = $1", [TIENDA]);
    const sin = await vistaConsolidada({}, c);
    check("una tienda desactivada no aparece", !sin.tiendas.some((x) => x.id_tienda === TIENDA));
    let r404 = null;
    try {
      await vistaConsolidada({ tienda: TIENDA }, c);
    } catch (e) {
      r404 = e.status;
    }
    check("filtrar por una tienda desactivada 404", r404 === 404);
  });

  // --- Criterio 4: ventas por categoría, con venta y devolución
  const idX = await crearMedicamento("X", { precio: "1000.00", tasa: 19, categoria: cat1 });
  const idY = await crearMedicamento("Y", { precio: "2000.00", tasa: 0, categoria: cat2 });
  await migrate();
  await pullReplica();
  const loteX = await crearLote(idX, "X1", 50);
  await crearLote(idY, "Y1", 50);
  await flushOutbox(TIENDA);
  const deCategoria = async (cat) => (await vista(`?tienda=${TIENDA}&categoria=${cat}&desde=${HOY}&hasta=${HOY}`)).data.tiendas[0].ventas;
  const total = async () => (await vista(`?tienda=${TIENDA}&desde=${HOY}&hasta=${HOY}`)).data.tiendas[0].ventas;
  const [a1, a2, aT] = [await deCategoria(cat1), await deCategoria(cat2), await total()];

  const metodos = (await pedir("/api/local/ventas/metodos-pago", { token: cajero })).data.metodos;
  const efectivo = metodos.find((m) => m.nombre === "efectivo").id_metodo_pago;
  // 3 X (3000 + 19 % = 3570) y 2 Y (4000) = 7570 en efectivo.
  const venta = await pedir("/api/local/ventas", { method: "POST", token: cajero, key: nuevaKey(), body: { lineas: [{ id_medicamento: idX, cantidad: 3 }, { id_medicamento: idY, cantidad: 2 }], pagos: [{ id_metodo_pago: efectivo, monto: "7570.00" }] } });
  check("venta de prueba 201 por 7570", venta.status === 201 && venta.data.total === "7570.00", `${venta.status} ${venta.data.total ?? venta.data.codigo}`);
  const evento = (await local.query("select payload from outbox_sync where tipo_evento = 'VENTA_REGISTRADA' and payload ->> 'numero_factura' = $1", [venta.data.numero_factura])).rows[0]?.payload;
  check("el evento de venta lleva su resumen por categoría", evento?.categorias?.length === 2 && evento.categorias.find((c) => c.id_categoria === cat1)?.unidades === 3 && evento.categorias.find((c) => c.id_categoria === cat1)?.ingresos === "3570.00", JSON.stringify(evento?.categorias));
  await flushOutbox(TIENDA);
  const [b1, b2, bT] = [await deCategoria(cat1), await deCategoria(cat2), await total()];
  check("categoría 1: +3 unidades y +3570", b1.unidades - a1.unidades === 3 && cerca(b1.ingresos - a1.ingresos, 3570), `${b1.unidades - a1.unidades} ${b1.ingresos - a1.ingresos}`);
  check("categoría 2: +2 unidades y +4000", b2.unidades - a2.unidades === 2 && cerca(b2.ingresos - a2.ingresos, 4000));
  check("sin filtro de categoría: +7570 y +1 factura", cerca(bT.ingresos - aT.ingresos, 7570) && bT.facturas - aT.facturas === 1);
  check("con categoría no hay facturas ni métodos (una factura cruza categorías)", b1.facturas == null && b1.metodos.length === 0);

  const dev = await pedir(`/api/local/facturas/${venta.data.id_factura}/devolver`, { method: "POST", token: cajero, key: nuevaKey(), body: { motivo: "prueba de vista de red", lineas: [{ id_lote: loteX, cantidad: 1 }] } });
  check("devolución de 1 X 201 por 1190", dev.status === 201 && dev.data.nota.total_devuelto === "1190.00", `${dev.status}`);
  const evDev = (await local.query("select payload from outbox_sync where tipo_evento = 'DEVOLUCION_REGISTRADA' and payload ->> 'numero_nota' = $1", [dev.data.nota.numero_nota])).rows[0]?.payload;
  check("el evento de devolución lleva su resumen por categoría", evDev?.categorias?.length === 1 && evDev.categorias[0].id_categoria === cat1 && evDev.categorias[0].unidades === 1 && evDev.categorias[0].ingresos === "1190.00", JSON.stringify(evDev?.categorias));
  await flushOutbox(TIENDA);
  const [c1, c2, cT] = [await deCategoria(cat1), await deCategoria(cat2), await total()];
  check("categoría 1 tras la devolución: +2 unidades y +2380 netos", c1.unidades - a1.unidades === 2 && cerca(c1.ingresos - a1.ingresos, 2380), `${c1.unidades - a1.unidades} ${c1.ingresos - a1.ingresos}`);
  check("la devolución no toca la categoría 2", c2.unidades === b2.unidades && cerca(c2.ingresos, b2.ingresos));
  check("total sin categoría: +6380 netos", cerca(cT.ingresos - aT.ingresos, 6380));
  const red = (await vista(`?desde=${HOY}&hasta=${HOY}`)).data;
  check("la red lista ingresos por categoría", red.categorias.some((c) => c.id_categoria === cat1) && red.categorias.some((c) => c.id_categoria === cat2));
  check("totales de la red = suma de tiendas", cerca(red.totales.ingresos, red.tiendas.reduce((s, t) => s + t.ventas.ingresos, 0)));
  check("las unidades se registran desde hoy (HU-16)", Boolean(red.categorias_desde) && red.categorias_desde <= HOY);

  // Evento duplicado y evento viejo sin categorías (dentro de una transacción revertida).
  await en(central, async (c) => {
    const leer = async () => (await c.query("select coalesce(sum(unidades), 0)::int as u from venta_categoria_consolidada where id_tienda = $1 and fecha = '2020-01-01'", [TIENDA])).rows[0].u;
    const ev = { idempotency_key: nuevaKey(), tipo_evento: "VENTA_REGISTRADA", payload: { fecha: "2020-01-01", total: "10.00", pagos: [{ id_metodo_pago: efectivo, monto: "10.00" }], categorias: [{ id_categoria: cat1, unidades: 4, ingresos: "10.00" }] } };
    await aplicarEnCentral(c, TIENDA, ev);
    await aplicarEnCentral(c, TIENDA, ev);
    check("un evento de venta duplicado suma una sola vez por categoría", (await leer()) === 4);
    const viejo = { idempotency_key: nuevaKey(), tipo_evento: "VENTA_REGISTRADA", payload: { fecha: "2020-01-01", total: "10.00", pagos: [{ id_metodo_pago: efectivo, monto: "10.00" }] } };
    await aplicarEnCentral(c, TIENDA, viejo);
    const vc = (await c.query("select total_vendido::text as t from venta_consolidada where id_tienda = $1 and fecha = '2020-01-01' and id_metodo_pago = $2", [TIENDA, efectivo])).rows[0];
    check("un evento viejo sin categorías suma a venta_consolidada y no a las categorías", vc?.t === "20.00" && (await leer()) === 4, vc?.t);
  });

  // --- Inventario por producto
  const invCat = (await pedir(`/api/central/red/inventario?categoria=${cat1}`, { token: adminGeneral })).data;
  const catDe = new Map((await central.query("select id_medicamento, coalesce(id_categoria, 0) as c from medicamento")).rows.map((r) => [r.id_medicamento, r.c]));
  check("inventario filtrado por categoría: solo productos de esa categoría", invCat.productos.length > 0 && invCat.productos.every((p) => catDe.get(p.id_medicamento) === cat1));
  const invX = (await pedir(`/api/central/red/inventario?q=${encodeURIComponent(`hu16-${S}-x`)}`, { token: adminGeneral })).data;
  const filaX = invX.productos.find((p) => p.id_medicamento === idX);
  const stockX = Number((await local.query("select cantidad_disponible from lote where id_lote = $1", [loteX])).rows[0].cantidad_disponible);
  check("búsqueda por código encuentra el producto", invX.total === 1 && Boolean(filaX));
  check("la celda de la tienda trae el stock consolidado (50 - 3 + 1)", filaX?.tiendas.find((x) => x.id_tienda === TIENDA)?.cantidad === stockX && stockX === 48, `${filaX?.tiendas.find((x) => x.id_tienda === TIENDA)?.cantidad} vs ${stockX}`);
  check("cada celda trae su estado y la hora de su foto", filaX?.tiendas.every((x) => ["agotado", "bajo", "disponible", "sin_reporte"].includes(x.estado)) && Boolean(filaX.tiendas.find((x) => x.id_tienda === TIENDA).sincronizado));
  const invTienda = (await pedir(`/api/central/red/inventario?tienda=${TIENDA}`, { token: adminGeneral })).data;
  check("inventario filtrado por tienda: una columna", invTienda.productos.every((p) => p.tiendas.length === 1 && p.tiendas[0].id_tienda === TIENDA));
  check("paginado de a 50", invTienda.por_pagina === 50 && invTienda.productos.length <= 50 && invTienda.paginas === Math.max(1, Math.ceil(invTienda.total / 50)));

  // --- HU-05: el comparativo también muestra la frescura
  const comp = (await pedir(`/api/central/reportes/comparativo?desde=${HOY}&hasta=${HOY}`, { token: adminGeneral })).data;
  check("el comparativo de HU-05 trae la frescura de cada tienda", comp.tiendas?.every((t) => ["AL_DIA", "DESACTUALIZADA", "SIN_DATOS"].includes(t.frescura?.estado)));

  // --- Rendimiento (p95 < 2 s), todo dentro de transacciones revertidas
  if (process.env.SIN_VOLUMEN !== "1") {
    const p95 = (ms) => ms.slice().sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1];
    const medir = async (fn, veces = 20) => {
      const ms = [];
      for (let i = 0; i < veces; i += 1) {
        const t = performance.now();
        await fn();
        ms.push(performance.now() - t);
      }
      return ms;
    };
    await en(central, async (c) => {
      const t0 = performance.now();
      const meds = (await c.query(
        `insert into medicamento (codigo_interno, nombre_comercial, principio_activo, id_categoria, requiere_receta, tasa_impuesto)
         select 'V16-' || $1 || '-' || g, 'Volumen ' || g, 'volumen', 1 + g % 5, false, 0 from generate_series(1, 2000) g returning id_medicamento`,
        [S],
      )).rows.map((r) => r.id_medicamento);
      const tiendas = (await c.query(
        "insert into tienda (nombre, direccion, ciudad, activa) select 'Volumen ' || $1 || ' ' || g, 'Calle', 'Prueba', true from generate_series(1, 50) g returning id_tienda",
        [S],
      )).rows.map((r) => r.id_tienda);
      await c.query(
        `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
         select t, m, (t + m) % 40, now()::timestamp from unnest($1::int[]) t cross join unnest($2::int[]) m`,
        [tiendas, meds],
      );
      await c.query(
        `insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
         select t, m, 10, 30 from unnest($1::int[]) t cross join unnest($2::int[]) m`,
        [tiendas, meds],
      );
      const metodosRed = (await c.query("select id_metodo_pago from metodo_pago order by id_metodo_pago limit 4")).rows.map((r) => r.id_metodo_pago);
      await c.query(
        `insert into venta_consolidada (id_tienda, fecha, id_metodo_pago, total_vendido, total_facturas, fecha_sincronizacion)
         select t, current_date - d, m, 100000, 20, now() from unnest($1::int[]) t cross join generate_series(0, 365) d cross join unnest($2::int[]) m`,
        [tiendas, metodosRed],
      );
      await c.query(
        `insert into venta_categoria_consolidada (id_tienda, fecha, id_categoria, unidades, ingresos, fecha_sincronizacion)
         select t, current_date - d, k, 30, 80000, now() from unnest($1::int[]) t cross join generate_series(0, 365) d cross join generate_series(1, 5) k`,
        [tiendas],
      );
      console.log(`  volumen: 2.000 medicamentos × 50 tiendas (100.000 filas de inventario), 73.200 de ventas y 91.500 por categoría en ${Math.round(performance.now() - t0)} ms`);
      const desde = (await c.query("select to_char(current_date - 365, 'YYYY-MM-DD') as d")).rows[0].d;
      const ms = await medir(() => vistaConsolidada({ desde, hasta: HOY }, c));
      check(`vista de un año con 50 tiendas: p95 ${Math.round(p95(ms))} ms < 2000 ms`, p95(ms) < 2000, ms.map(Math.round).join(","));
      const msCat = await medir(() => vistaConsolidada({ desde, hasta: HOY, categoria: 1 }, c));
      check(`vista filtrada por categoría: p95 ${Math.round(p95(msCat))} ms < 2000 ms`, p95(msCat) < 2000, msCat.map(Math.round).join(","));
      const msInv = await medir(() => inventarioRed({ pagina: 3 }, c));
      check(`inventario por producto (página de 50 × 52 tiendas): p95 ${Math.round(p95(msInv))} ms < 2000 ms`, p95(msInv) < 2000, msInv.map(Math.round).join(","));
      const fotoGrande = { idempotency_key: nuevaKey(), tipo_evento: "STOCK_SNAPSHOT", payload: { calculado_en: new Date().toISOString(), completo: true, items: meds.map((m) => ({ id_medicamento: m, cantidad: 7 })) } };
      const tFoto = performance.now();
      await aplicarEnCentral(c, TIENDA, fotoGrande);
      const msFoto = performance.now() - tFoto;
      check(`foto completa de 2.000 medicamentos aplicada en ${Math.round(msFoto)} ms < 1000 ms`, msFoto < 1000);
    });
  }
} finally {
  link.estado = "online";
  await desactivarMedicamentos("codigo_interno like $1", [`HU16-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU16-${S}-%`]);
  if (idCuentaControl) await desactivarEmpleado(idCuentaControl);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
