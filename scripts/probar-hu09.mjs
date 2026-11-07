// Pruebas de HU-09 por las rutas reales de app.mjs: búsqueda de facturas por cliente, número y fechas, historial de un
// cliente, reimpresión idéntica al original (y auditada), datos personales enmascarados, paginación y operación sin
// conexión con el central. ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1.
// Correr con el API detenido. Las facturas son permanentes (los medicamentos de prueba quedan inactivos al final).
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
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
const S = Date.now().toString(36).toUpperCase();

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}
async function crearMedicamento(sufijo, { precio, tasa = 0, receta = false }) {
  const r = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto)
               values ($1, $2, 'prueba de historial', $3, $4) returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
    [`HU09-${S}-${sufijo}`, `Prueba Historial ${S}-${sufijo}`, receta, tasa],
  );
  await central.query("insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, $2, now()::timestamp - interval '1 hour')", [r.rows[0].id_medicamento, precio]);
  return r.rows[0].id_medicamento;
}
const idB = await crearMedicamento("B", { precio: "2500.00", tasa: 19 });
const idC = await crearMedicamento("C", { precio: "4000.00", tasa: 5, receta: true });
await migrate();
await pullReplica();
async function crearLote(idMed, sufijo, cantidad) {
  return (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + 200, $4, $4, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `L9-${S}-${sufijo}`, cantidad],
  )).rows[0].id_lote;
}
await crearLote(idB, "B1", 100);
await crearLote(idC, "C1", 100);

try {
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  const general = await entrar("central", "admin.general");
  check("logins demo", Boolean(cajero && adminTienda && general));
  const efectivo = (await pedir("/api/local/ventas/metodos-pago", { token: cajero })).data.metodos.find((m) => m.nombre === "efectivo").id_metodo_pago;
  const venta = (cuerpo) => pedir("/api/local/ventas", { method: "POST", token: cajero, key: nuevaKey(), body: cuerpo });
  const hoy = (await local.query("select current_date::text as f")).rows[0].f;
  const ayer = (await local.query("select (current_date - 1)::text as f")).rows[0].f;

  // --- Datos: una venta de mostrador y dos pacientes (X con dos compras, Y con una)
  const mostrador = await venta({ lineas: [{ id_medicamento: idB, cantidad: 2 }], pagos: [{ id_metodo_pago: efectivo, monto: "5950.00" }] });
  check("venta de mostrador 201", mostrador.status === 201, `${mostrador.status}`);
  const docX = `H9X${S}`;
  const docY = `H9Y${S}`;
  const nombreX = `Paciente Historial X ${S}`;
  const nombreY = `Paciente Historial Y ${S}`;
  async function ventaReceta(nombre, doc, codigo) {
    const e = await pedir("/api/central/recetas-emitidas", {
      method: "POST",
      token: general,
      key: nuevaKey(),
      body: { codigo, medico_prescriptor: `Dr. Historial ${S}`, fecha_emision: hoy, paciente_nombre: nombre, paciente_documento: doc, medicamentos: [{ id_medicamento: idC, cantidad: 1 }] },
    });
    const v = await pedir("/api/local/recetas/codigo", { method: "POST", token: cajero, body: { codigo } });
    if (e.status !== 201 || v.status !== 200) return { status: 0, data: {} };
    return venta({ lineas: [{ id_medicamento: idC, cantidad: 1, id_receta: v.data.id_receta }], pagos: [{ id_metodo_pago: efectivo, monto: "4200.00" }] });
  }
  const x1 = await ventaReceta(nombreX, docX, `H9X1-${S}`);
  const x2 = await ventaReceta(nombreX, docX, `H9X2-${S}`);
  const y1 = await ventaReceta(nombreY, docY, `H9Y1-${S}`);
  check("tres ventas con paciente 201", [x1, x2, y1].every((r) => r.status === 201), [x1, x2, y1].map((r) => r.status).join(","));

  // --- Acceso (criterio 5)
  check("sin sesión 401", (await pedir("/api/local/historial/facturas")).status === 401);
  check("token del central no sirve en el POS 401", (await pedir("/api/local/historial/facturas", { token: general })).status === 401);
  check("cajero puede consultar", (await pedir("/api/local/historial/facturas", { token: cajero })).status === 200);
  check("administrador de tienda puede consultar", (await pedir("/api/local/historial/facturas", { token: adminTienda })).status === 200);
  check("sin sesión no se reimprime 401", (await pedir(`/api/local/historial/facturas/${mostrador.data.id_factura}/reimprimir`, { method: "POST" })).status === 401);

  // --- Criterio 1: buscar por número, fechas y cliente
  const porNumero = await pedir(`/api/local/historial/facturas?numero=${encodeURIComponent(mostrador.data.numero_factura)}`, { token: cajero });
  check("por número exacto: una factura", porNumero.data.facturas?.length === 1 && porNumero.data.facturas[0].id_factura === mostrador.data.id_factura);
  const minusc = await pedir(`/api/local/historial/facturas?numero=${encodeURIComponent(mostrador.data.numero_factura.toLowerCase())}`, { token: cajero });
  check("el número se busca sin distinguir mayúsculas", minusc.data.facturas?.length === 1);
  const prefijo = await pedir(`/api/local/historial/facturas?numero=${encodeURIComponent(mostrador.data.numero_factura.slice(0, 3))}`, { token: cajero });
  check("por prefijo del número lista varias", prefijo.data.facturas?.length >= 4);
  const hoyR = await pedir(`/api/local/historial/facturas?desde=${hoy}&hasta=${hoy}`, { token: cajero });
  const idsHoy = new Set((hoyR.data.facturas || []).map((f) => f.id_factura));
  check("rango de hoy (inclusive) incluye las 4 facturas nuevas", [mostrador, x1, x2, y1].every((r) => idsHoy.has(r.data.id_factura)));
  const ayerR = await pedir(`/api/local/historial/facturas?desde=${ayer}&hasta=${ayer}`, { token: cajero });
  check("rango de ayer no incluye las de hoy", ayerR.status === 200 && ![mostrador, x1].some((r) => (ayerR.data.facturas || []).some((f) => f.id_factura === r.data.id_factura)));
  const porNombre = await pedir(`/api/local/historial/facturas?cliente=${encodeURIComponent(`Historial X ${S}`)}`, { token: cajero });
  check("por nombre parcial del cliente: solo las 2 de X", porNombre.data.facturas?.length === 2 && porNombre.data.facturas.every((f) => f.cliente?.nombre === nombreX));
  const porDoc = await pedir(`/api/local/historial/facturas?cliente=${docY}`, { token: cajero });
  check("por documento exacto: la de Y", porDoc.data.facturas?.length === 1 && porDoc.data.facturas[0].id_factura === y1.data.id_factura);
  const combinado = await pedir(`/api/local/historial/facturas?cliente=${docX}&desde=${hoy}&hasta=${hoy}&numero=${encodeURIComponent(x1.data.numero_factura)}`, { token: cajero });
  check("filtros combinados", combinado.data.facturas?.length === 1 && combinado.data.facturas[0].id_factura === x1.data.id_factura);
  const nadie = await pedir(`/api/local/historial/facturas?cliente=NoExiste${S}`, { token: cajero });
  check("cliente inexistente: lista vacía 200", nadie.status === 200 && nadie.data.facturas.length === 0);

  // --- Criterio 2: historial completo de un cliente
  const clientes = await pedir(`/api/local/historial/clientes?q=${encodeURIComponent(`Historial X ${S}`)}`, { token: cajero });
  check("buscar cliente por nombre devuelve a X", clientes.data.clientes?.length === 1);
  const idX = clientes.data.clientes[0].id_cliente;
  const resumen = await pedir(`/api/local/historial/clientes/${idX}`, { token: cajero });
  check("resumen: 2 compras y el total", resumen.data.compras === 2 && Number(resumen.data.total_comprado) === Number(x1.data.total) + Number(x2.data.total), JSON.stringify(resumen.data));
  const hist = await pedir(`/api/local/historial/facturas?id_cliente=${idX}`, { token: cajero });
  check("historial del cliente: sus 2 facturas, la más reciente primero", hist.data.facturas?.length === 2 && hist.data.facturas[0].id_factura === x2.data.id_factura && hist.data.facturas[1].id_factura === x1.data.id_factura);
  check("el historial de X no trae facturas de otros", hist.data.facturas.every((f) => f.cliente.id_cliente === idX));
  check("cliente inexistente 404", (await pedir("/api/local/historial/clientes/99999999", { token: cajero })).status === 404);
  check("búsqueda de cliente muy corta 400", (await pedir("/api/local/historial/clientes?q=a", { token: cajero })).status === 400);

  // --- Criterio 5: datos personales
  const veAdmin = (await local.query("select 1 from rol_permiso_ref rp join permiso_ref p on p.id_permiso = rp.id_permiso join empleado_ref e on e.id_rol = rp.id_rol where e.usuario = 'admin.tienda' and p.codigo = 'AUDITORIA_CONSULTAR'")).rowCount > 0;
  check("el cajero ve el documento enmascarado", clientes.data.clientes[0].documento === `****${docX.slice(-4)}` && resumen.data.documento.startsWith("****") && resumen.data.telefono == null);
  check("el cajero no recibe el documento completo en ningún lado", !JSON.stringify([hist.data, porNombre.data, resumen.data]).includes(docX));
  const resAdmin = await pedir(`/api/local/historial/clientes/${idX}`, { token: adminTienda });
  check("quien tiene permiso de datos personales lo ve completo", veAdmin ? resAdmin.data.documento === docX : resAdmin.data.documento.startsWith("****"));
  const audit = await contar(local, "select count(*) as n from registro_actividad where accion = 'CLIENTE_DATOS_CONSULTAR' and entidad_afectada = 'cliente' and id_entidad_afectada = $1", [idX]);
  check("cada consulta del historial de un cliente queda auditada", audit >= 2, `${audit}`);

  // --- Criterio 3: ver y reimprimir sin alterar
  const original = x1.data;
  const filaAntes = JSON.stringify((await local.query("select * from factura where id_factura = $1", [original.id_factura])).rows[0]);
  const lineasAntes = JSON.stringify((await local.query("select * from detalle_factura where id_factura = $1 order by id_lote", [original.id_factura])).rows);
  const vista = await pedir(`/api/local/historial/facturas/${original.id_factura}`, { token: cajero });
  check("ver la factura: idéntica a la emitida", vista.status === 200 && JSON.stringify(vista.data) === JSON.stringify(original));
  check("ver no deja huella de reimpresión", (await contar(local, "select count(*) as n from registro_actividad where accion = 'FACTURA_REIMPRIMIR' and id_entidad_afectada = $1", [original.id_factura])) === 0);
  // El precio cambia después de emitir: la reimpresión conserva el precio original.
  await central.query("insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, '9999.00', now()::timestamp)", [idC]);
  await pullReplica();
  const r1 = await pedir(`/api/local/historial/facturas/${original.id_factura}/reimprimir`, { method: "POST", token: cajero });
  const r2 = await pedir(`/api/local/historial/facturas/${original.id_factura}/reimprimir`, { method: "POST", token: adminTienda });
  const { reimpresion: n1, ...c1 } = r1.data;
  const { reimpresion: n2, ...c2 } = r2.data;
  check("reimpresión 200 con contenido idéntico al original", r1.status === 200 && JSON.stringify(c1) === JSON.stringify(original) && JSON.stringify(c2) === JSON.stringify(original));
  check("las copias se numeran 1 y 2", n1 === 1 && n2 === 2, `${n1},${n2}`);
  check("la reimpresión conserva el precio de la venta aunque el precio vigente cambió", r1.data.lineas[0].precio_unitario === "4000.00");
  check("cada reimpresión queda auditada", (await contar(local, "select count(*) as n from registro_actividad where accion = 'FACTURA_REIMPRIMIR' and id_entidad_afectada = $1", [original.id_factura])) === 2);
  check(
    "la factura y sus líneas no cambiaron",
    JSON.stringify((await local.query("select * from factura where id_factura = $1", [original.id_factura])).rows[0]) === filaAntes &&
      JSON.stringify((await local.query("select * from detalle_factura where id_factura = $1 order by id_lote", [original.id_factura])).rows) === lineasAntes,
  );
  let bloqueado = false;
  try {
    await local.query("update factura set total = total + 1 where id_factura = $1", [original.id_factura]);
  } catch {
    bloqueado = true;
  }
  check("la base impide alterar una factura emitida", bloqueado);
  check("factura inexistente 404", (await pedir("/api/local/historial/facturas/99999999", { token: cajero })).status === 404);

  // --- Criterio 4: paginación y tiempos. Se agregan ventas hasta pasar de una página (25) para probar el cursor.
  for (let i = 0; i < 6; i += 1) {
    const lote = await Promise.all(Array.from({ length: 5 }, () => venta({ lineas: [{ id_medicamento: idB, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "2975.00" }] })));
    if (lote.some((r) => r.status !== 201)) break;
  }
  const total = await contar(local, "select count(*) as n from factura");
  const vistos = [];
  let cursor = null;
  let paginas = 0;
  const tiempos = [];
  do {
    const t0 = Date.now();
    const p = await pedir(`/api/local/historial/facturas${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { token: cajero });
    tiempos.push(Date.now() - t0);
    vistos.push(...p.data.facturas.map((f) => f.id_factura));
    cursor = p.data.siguiente;
    paginas += 1;
  } while (cursor && paginas < 200);
  check("paginar recorre todas las facturas una sola vez", vistos.length === total && new Set(vistos).size === total, `${vistos.length}/${total} en ${paginas} páginas`);
  const orden = (await local.query("select id_factura from factura order by fecha_hora desc, id_factura desc")).rows.map((f) => f.id_factura);
  check("el orden es más reciente primero y estable", JSON.stringify(orden) === JSON.stringify(vistos));
  check("cada página tarda ≤ 2 s", Math.max(...tiempos) <= 2000, `${tiempos.join(", ")} ms`);
  check("existen los índices del historial", (await contar(local, "select count(*) as n from pg_indexes where indexname in ('idx_factura_fecha_id','idx_factura_cliente_fecha','idx_factura_numero_prefijo')")) === 3);

  // --- Validaciones
  const mal = async (ruta, nombre) => check(nombre, (await pedir(ruta, { token: cajero })).status === 400);
  await mal("/api/local/historial/facturas?desde=2026-13-45", "fecha inválida 400");
  await mal("/api/local/historial/facturas?desde=2026-02-30", "fecha imposible 400");
  await mal(`/api/local/historial/facturas?desde=${hoy}&hasta=${ayer}`, "rango invertido 400");
  await mal("/api/local/historial/facturas?cursor=abc", "cursor inválido 400");
  await mal("/api/local/historial/facturas?numero=T1%27%3B--%20x", "número con caracteres raros 400");
  await mal("/api/local/historial/facturas?id_cliente=0", "id_cliente inválido 400");
  const inyeccion = await pedir(`/api/local/historial/facturas?cliente=${encodeURIComponent("%' or 1=1 --")}`, { token: cajero });
  check("un patrón malicioso se trata como texto (sin resultados)", inyeccion.status === 200 && inyeccion.data.facturas.length === 0);

  // --- Sin conexión con el central: todo es local
  link.estado = "offline";
  const off = await pedir(`/api/local/historial/facturas?cliente=${docX}`, { token: cajero });
  const offRe = await pedir(`/api/local/historial/facturas/${original.id_factura}/reimprimir`, { method: "POST", token: cajero });
  check("offline: se busca y se reimprime sin el central", off.status === 200 && off.data.facturas.length === 2 && offRe.status === 200 && offRe.data.reimpresion === 3);
  check("la reimpresión offline quedó en la auditoría local (sube al central al reconectar)", (await contar(local, "select count(*) as n from registro_actividad where accion = 'FACTURA_REIMPRIMIR' and id_entidad_afectada = $1", [original.id_factura])) === 3);
} finally {
  link.estado = "online";
  await central.query("update medicamento set activo = false where codigo_interno like $1", [`HU09-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU09-${S}-%`]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
