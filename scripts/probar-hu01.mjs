// Pruebas de HU-01 (búsqueda, filtros, existencias en la red, STOCK_SNAPSHOT, offline y RNF-05).
// ESCRIBE en las bases del .env (migración, datos demo, sesiones y auditoría): ejecutar contra bases
// de prueba, nunca contra la base principal. Con URLs de Neon se niega a correr salvo PERMITIR_NEON=1.
// La prueba de rendimiento crea 2.000 medicamentos dentro de una transacción que se revierte al final.
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local, runtime, withTx } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { login, autorizar } = await import("../apps/api/auth.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
const { seedLocalDemo } = await import("../apps/api/demo.mjs");
const { buscar, existenciasEnRed, listarCategorias, listarTiendas, TIMEOUT_RED_MS } = await import("../apps/api/inventario/busqueda.mjs");
const { aplicarEnCentral } = await import("../apps/api/sync/central.mjs");

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
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);

await migrate();
await pullReplica();
await seedLocalDemo(runtime.tiendaId);
const idTienda = runtime.tiendaId;

const sesionCajero = await login({ nodo: "local", usuario: "cajero1", password: "Farma123", idempotencyKey: crypto.randomUUID() });
check("login cajero1", sesionCajero.status === 200, String(sesionCajero.status));
const cajero = await autorizar(sesionCajero.body.token, "local", "INVENTARIO_CONSULTAR");
const ctx = { idTienda, idEmpleado: cajero.id_empleado };

// --- Catálogo replicado (dependencia de HU-01) ---
const medsCentral = await contar(central, "select count(*) as n from medicamento where activo = true");
const medsLocal = await contar(local, "select count(*) as n from medicamento_ref where activo = true");
check("catálogo replicado al nodo local", medsLocal > 0 && medsLocal === medsCentral, `central=${medsCentral} local=${medsLocal}`);
check("categorías para el filtro", (await listarCategorias()).length > 0);
const tiendas = await listarTiendas(ctx);
check("lista de tiendas empieza por la propia", tiendas[0]?.id_tienda === idTienda && tiendas[0]?.propia === true);

// --- Búsqueda (criterio 1, RF-03) ---
const acet = await buscar({ q: "acetaminofen" }, ctx);
check("sin tildes encuentra 'Acetaminofén'", acet.resultados.some((r) => r.nombre_comercial.startsWith("Acetaminofén")), `total=${acet.total}`);
const acetMay = await buscar({ q: "ACETAMINOFÉN" }, ctx);
check("mayúsculas y tildes no cambian el resultado", acetMay.total === acet.total);
const para = await buscar({ q: "paracetamol" }, ctx);
check("busca por principio activo", para.resultados.some((r) => r.codigo_interno === "MED-001") && para.resultados.some((r) => r.codigo_interno === "MED-003"));
const codigo = await buscar({ q: "med-004" }, ctx);
check("código exacto va primero", codigo.resultados[0]?.codigo_interno === "MED-004");
const campos = ["id_medicamento", "codigo_interno", "nombre_comercial", "principio_activo", "categoria", "requiere_receta", "requiere_refrigeracion", "stock_tienda", "estado_stock", "stock_minimo"];
check("cada resultado trae los campos de la especificación", campos.every((campo) => campo in acet.resultados[0]));
const stockSql = await contar(
  local,
  `select coalesce(sum(cantidad_disponible), 0) as n from lote l join medicamento_ref m using (id_medicamento)
   where m.codigo_interno = 'MED-001' and l.estado = 'DISPONIBLE' and l.fecha_caducidad >= current_date`,
);
const med001 = acet.resultados.find((r) => r.codigo_interno === "MED-001");
check("stock propio = lotes DISPONIBLE no vencidos", med001?.stock_tienda === stockSql, `api=${med001?.stock_tienda} sql=${stockSql}`);
check("comodines escapados: '%%' no trae todo", (await buscar({ q: "%%" }, ctx)).total === 0);
check("término de 1 carácter: 400", (await error(() => buscar({ q: "a" }, ctx)))?.status === 400);
check("sin término ni filtros: 400", (await error(() => buscar({ q: "  " }, ctx)))?.status === 400);
check("término de 81 caracteres: 400", (await error(() => buscar({ q: "x".repeat(81) }, ctx)))?.status === 400);
check("estado no válido: 400", (await error(() => buscar({ q: "ac", estado: "raro" }, ctx)))?.status === 400);

// --- Filtros combinables (criterio 3) ---
const analgesicos = (await listarCategorias()).find((c) => c.nombre === "Analgésicos");
const porCategoria = await buscar({ categoria: analgesicos.id_categoria }, ctx);
check("solo filtro de categoría (sin término)", porCategoria.total > 0 && porCategoria.resultados.every((r) => r.id_categoria === analgesicos.id_categoria));
for (const estado of ["disponible", "bajo", "agotado"]) {
  const r = await buscar({ categoria: analgesicos.id_categoria, estado }, ctx);
  const todos = porCategoria.resultados.filter((x) => x.estado_stock === estado).length;
  check(`categoría AND estado=${estado}`, r.resultados.every((x) => x.estado_stock === estado && x.id_categoria === analgesicos.id_categoria) && r.total === todos, `total=${r.total} esperado=${todos}`);
}
const lejos = await buscar({ categoria: analgesicos.id_categoria, pagina: 99 }, ctx);
check("página fuera de rango: vacía pero con el total", lejos.resultados.length === 0 && lejos.total === porCategoria.total);

// --- Otra tienda y existencias en la red (criterio 2) ---
// Usa cualquier otra tienda activa del central que haya reportado stock; sin ninguna, esta parte se omite.
const otra = (
  await central.query(
    `select ic.id_tienda, ic.id_medicamento, ic.cantidad_disponible, m.codigo_interno
     from inventario_consolidado ic
     join tienda t on t.id_tienda = ic.id_tienda and t.activa = true
     join medicamento m on m.id_medicamento = ic.id_medicamento
     where ic.id_tienda <> $1 and ic.cantidad_disponible > 0
     order by ic.id_tienda, m.codigo_interno
     limit 1`,
    [idTienda],
  )
).rows[0];
const idRed = otra?.id_tienda ?? null;
check("tienda inexistente: 404", (await error(() => buscar({ q: "ac", tienda: 999999 }, ctx)))?.status === 404);
const existencias = await existenciasEnRed(med001.id_medicamento, {}, ctx);
check("la red excluye la tienda propia", existencias.tiendas.every((t) => t.id_tienda !== idTienda));
const ordenada = existencias.tiendas.every((t, i, l) => i === 0 || (l[i - 1].cantidad > 0) > (t.cantidad > 0) || l[i - 1].cantidad >= t.cantidad);
check("la red va con stock primero y por cantidad", ordenada);
if (otra) {
  const enRed = await buscar({ q: otra.codigo_interno, tienda: idRed }, ctx);
  const item = enRed.resultados.find((r) => r.id_medicamento === otra.id_medicamento);
  check(
    `filtro por la tienda ${idRed} usa su consolidado y su hora`,
    enRed.tienda.propia === false && item?.stock_tienda === Number(otra.cantidad_disponible) && item?.actualizado_en != null,
  );
  const redOtra = await existenciasEnRed(otra.id_medicamento, {}, ctx);
  check(`la red trae la tienda ${idRed} con cantidad y hora`, redOtra.tiendas.some((t) => t.id_tienda === idRed && t.cantidad > 0 && t.actualizado_en));
} else {
  console.log("OMITIDO filtro por otra tienda: ninguna otra tienda activa ha reportado stock al central");
}

// --- Seguridad (RNF-01) ---
const denegadosAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and id_empleado = $1", [cajero.id_empleado]);
const fueraDeRol = await error(() => autorizar(sesionCajero.body.token, "local", "RED_CONTROL"));
const denegadosDespues = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and id_empleado = $1", [cajero.id_empleado]);
check("fuera de rol: 403 y queda ACCESO_DENEGADO", fueraDeRol?.status === 403 && denegadosDespues === denegadosAntes + 1);
check("sin sesión: 401", (await error(() => autorizar("token-falso", "local", "INVENTARIO_CONSULTAR")))?.status === 401);

// --- STOCK_SNAPSHOT en el central: idempotente y monótono (criterio 4) ---
// Se envía el stock real de la tienda, así el consolidado queda correcto aunque una prueba falle.
const ibu = (await local.query("select id_medicamento from medicamento_ref where codigo_interno = 'MED-002'")).rows[0].id_medicamento;
const stockIbu = await contar(
  local,
  "select coalesce(sum(cantidad_disponible) filter (where estado = 'DISPONIBLE' and fecha_caducidad >= current_date), 0) as n from lote where id_medicamento = $1",
  [ibu],
);
const leerCentral = async () =>
  (await central.query("select cantidad_disponible, fecha_sincronizacion from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [idTienda, ibu])).rows[0];
const snapshot = (key, cantidad, calculadoEn) => ({
  idempotency_key: key,
  tipo_evento: "STOCK_SNAPSHOT",
  payload: { id_tienda: idTienda, calculado_en: calculadoEn, items: [{ id_medicamento: ibu, cantidad }] },
});
const enviar = (evento) => withTx(central, (client) => aplicarEnCentral(client, idTienda, evento));
// Misma fuente de hora que encolarStockSnapshot: now() de la base local.
const ahoraLocal = new Date((await local.query("select now() as ahora")).rows[0].ahora).toISOString();
const clave = crypto.randomUUID();
await enviar(snapshot(clave, stockIbu, ahoraLocal));
check("snapshot aplicado", Number((await leerCentral())?.cantidad_disponible) === stockIbu);
await enviar(snapshot(clave, stockIbu + 999, ahoraLocal));
check("duplicado (misma clave) no cambia nada", Number((await leerCentral())?.cantidad_disponible) === stockIbu);
await enviar(snapshot(crypto.randomUUID(), stockIbu + 999, "2000-01-01T00:00:00.000Z"));
check("una foto vieja no pisa una nueva", Number((await leerCentral())?.cantidad_disponible) === stockIbu);

// --- Sin conexión con el central (criterio 5, RNF-04) ---
const estadoPrevio = link.estado;
link.estado = "offline";
const localOffline = await buscar({ q: "acetaminofen" }, ctx);
check("offline: la búsqueda local sigue", localOffline.total === acet.total);
const redOffline = await error(() => existenciasEnRed(med001.id_medicamento, {}, ctx));
check("offline: la red responde 503 SIN_CONEXION (no lista vacía)", redOffline?.status === 503 && redOffline?.codigo === "SIN_CONEXION");
if (idRed) {
  const otraOffline = await error(() => buscar({ q: "ac", tienda: idRed }, ctx));
  check("offline: filtro por otra tienda responde 503", otraOffline?.status === 503);
}
link.estado = estadoPrevio;

// --- Central lento (RNF-05): la red se corta a los 1,5 s y la búsqueda local no espera ---
const consultaOriginal = central.query;
central.query = (...args) => new Promise((resolve, reject) => {
  setTimeout(() => consultaOriginal.apply(central, args).then(resolve, reject), 2500);
});
try {
  const inicioLento = performance.now();
  const lenta = await error(() => existenciasEnRed(med001.id_medicamento, {}, ctx));
  const msLenta = performance.now() - inicioLento;
  check("central lento: 503 SIN_CONEXION al vencer el timeout", lenta?.status === 503 && lenta?.codigo === "SIN_CONEXION");
  check("central lento: responde en menos de 2 s", msLenta < 2000 && msLenta >= TIMEOUT_RED_MS - 50, `${msLenta.toFixed(0)} ms`);
  const inicioLocal = performance.now();
  const localConCentralLento = await buscar({ q: "acetaminofen" }, ctx);
  check("central lento: la búsqueda local no lo espera", localConCentralLento.total === acet.total && performance.now() - inicioLocal < 1000);
} finally {
  central.query = consultaOriginal;
}
// Deja terminar la consulta retrasada antes de seguir, para no cruzarla con las siguientes.
await new Promise((resolve) => setTimeout(resolve, 1200));

// --- RNF-05 y filtro de estado con catálogo grande (2.000 medicamentos, se revierten) ---
const client = await local.connect();
try {
  await client.query("begin");
  const base = Number((await client.query("select coalesce(max(id_medicamento), 0) + 100000 as n from medicamento_ref")).rows[0].n);
  await client.query(
    `insert into medicamento_ref (id_medicamento, codigo_interno, nombre_comercial, principio_activo, id_categoria)
     select $1 + g, 'PERF-' || g, 'Producto de prueba ' || g, 'Principio ' || (g % 97), $2
     from generate_series(1, 2000) g`,
    [base, analgesicos.id_categoria],
  );
  const agotadosSql = await contar(
    client,
    `select count(*) as n from medicamento_ref m
     left join (select id_medicamento, sum(cantidad_disponible) filter (where estado = 'DISPONIBLE' and fecha_caducidad >= current_date) as s
                from lote group by id_medicamento) l using (id_medicamento)
     where m.activo = true and coalesce(l.s, 0) <= 0`,
  );
  const agotados = await buscar({ estado: "agotado" }, ctx, client);
  check("estado=agotado cuenta todo el catálogo (más de 500)", agotados.total === agotadosSql && agotados.total > 2000, `api=${agotados.total} sql=${agotadosSql}`);

  const terminos = ["producto", "prueba 1", "principio 4", "perf-15", "acetaminofen", "ibuprofeno", "paracetamol", "med-0", "loratadina", "insulina"];
  const tiempos = [];
  for (let i = 0; i < 100; i += 1) {
    const inicio = performance.now();
    await buscar({ q: terminos[i % terminos.length], estado: i % 3 === 0 ? "agotado" : undefined }, ctx, client);
    tiempos.push(performance.now() - inicio);
  }
  tiempos.sort((a, b) => a - b);
  const p95 = tiempos[Math.ceil(tiempos.length * 0.95) - 1];
  check("RNF-05: p95 de 100 búsquedas < 2 s con 2.000+ medicamentos", p95 < 2000, `p95=${p95.toFixed(0)} ms`);
} finally {
  await client.query("rollback");
  client.release();
}
check("los 2.000 medicamentos de prueba se revirtieron", (await contar(local, "select count(*) as n from medicamento_ref where codigo_interno like 'PERF-%'")) === 0);

console.log(fallos.length ? `\n${fallos.length} FALLO(S)\n- ${fallos.join("\n- ")}` : "\nTODO OK");
await central.end();
await local.end();
process.exit(fallos.length ? 1 : 0);
