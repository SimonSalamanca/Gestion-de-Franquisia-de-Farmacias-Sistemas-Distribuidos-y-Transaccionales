// Pruebas de HU-03 por las rutas reales de app.mjs: permisos, validaciones, programación, historial inmutable,
// réplica a la tienda, consulta sin conexión, precio vigente en un instante y facturas que no cambian.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Usa un medicamento propio por corrida; al final queda inactivo (su historial
// de precios es permanente). La factura de prueba se crea dentro de una transacción que se revierte.
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
const enDias = (dias) => new Date(Date.now() + dias * 86400000).toISOString();
const S = Date.now().toString(36);

// Medicamento propio de esta corrida, publicado a la tienda por la emisión del catálogo de migrate().
const codigo = `HU03-${S}`.toUpperCase();
const creado = await central.query(
  `insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'prueba de precios') returning id_medicamento`,
  [codigo, `Prueba Precios ${S}`],
);
const idMed = creado.rows[0].id_medicamento;
await migrate();
await pullReplica();

try {
  const general = await entrar("central", "admin.general");
  const adminTienda = await entrar("local", "admin.tienda");
  const cajero = await entrar("local", "cajero1");
  check("logins demo", Boolean(general && adminTienda && cajero));
  check("el medicamento de prueba llegó a la tienda", (await contar(local, "select count(*) as n from medicamento_ref where id_medicamento = $1", [idMed])) === 1);

  // --- Permisos (criterio 4) y consulta (criterio 5)
  check("sin sesión 401", (await pedir("/api/local/precios")).status === 401);
  const listaCajero = await pedir(`/api/local/precios?q=${codigo}`, { token: cajero });
  check("el cajero consulta precios", listaCajero.status === 200 && listaCajero.data.medicamentos.some((m) => m.id_medicamento === idMed));
  const vacio = await pedir(`/api/local/precios/${idMed}`, { token: cajero });
  check("sin precio aún: historial vacío y sin vigente", vacio.status === 200 && vacio.data.historial.length === 0 && vacio.data.vigente === null);
  const negadosAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO'");
  const delCajero = await pedir(`/api/local/precios/${idMed}`, { method: "POST", token: cajero, key: nuevaKey(), body: { precio: "100" } });
  check("el cajero no puede cambiar precios 403", delCajero.status === 403);
  check("403 auditado en la tienda", (await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO'")) === negadosAntes + 1);
  check("sin precios tras el 403", (await contar(central, "select count(*) as n from precio_medicamento where id_medicamento = $1", [idMed])) === 0);

  // --- Validaciones
  const ruta = `/api/local/precios/${idMed}`;
  check("sin Idempotency-Key 400", (await pedir(ruta, { method: "POST", token: adminTienda, body: { precio: "1000" } })).status === 400);
  for (const malo of ["-5", "0", "abc", "10.123"]) {
    check(`precio inválido (${malo}) 400`, (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: malo } })).status === 400);
  }
  check("inicio en el pasado 400", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: "1000", desde: enDias(-1) } })).status === 400);
  check("medicamento inexistente 404", (await pedir("/api/local/precios/99999999", { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: "1000" } })).status === 404);

  // --- Registro (criterio 1): ahora y programado
  const key = nuevaKey();
  const primero = await pedir(ruta, { method: "POST", token: adminTienda, key, body: { precio: "1000" } });
  check("admin de tienda registra un precio 201", primero.status === 201 && primero.data.vigente && Number(primero.data.vigente.precio) === 1000, `${primero.status} ${primero.data.mensaje || ""}`);
  const repetido = await pedir(ruta, { method: "POST", token: adminTienda, key, body: { precio: "1000" } });
  check("reintento con la misma clave: mismo precio", repetido.status === 201 && repetido.data.id_precio === primero.data.id_precio);
  check("misma clave con otro precio 409", (await pedir(ruta, { method: "POST", token: adminTienda, key, body: { precio: "2000" } })).status === 409);
  check("un solo precio tras los reintentos", (await contar(central, "select count(*) as n from precio_medicamento where id_medicamento = $1", [idMed])) === 1);

  const enDos = enDias(2);
  const programado = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: "1500", desde: enDos } });
  check("precio programado a 2 días 201", programado.status === 201, programado.data.mensaje || "");
  const hist = programado.data.historial || [];
  const [futuro, actual] = hist;
  check("historial: programado arriba, vigente abajo", hist.length === 2 && futuro.estado === "PROGRAMADO" && actual.estado === "VIGENTE");
  check("el vigente termina cuando empieza el programado", actual && new Date(actual.fecha_fin_vigencia).getTime() === new Date(futuro.fecha_inicio_vigencia).getTime());
  check("el vigente sigue siendo 1000", Number(programado.data.vigente?.precio) === 1000);
  check("mismo instante de inicio 409", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: "1700", desde: enDos } })).data.codigo === "PRECIO_DUPLICADO");

  // --- Corregir un programado; uno que ya rige no (criterio 2)
  const corregido = await pedir(`/api/local/precios/registro/${futuro.id_precio}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { precio: "1600" } });
  check("corregir un precio programado 200", corregido.status === 200 && Number(corregido.data.historial[0].precio) === 1600, corregido.data.mensaje || "");
  const enVigor = await pedir(`/api/local/precios/registro/${actual.id_precio}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { precio: "1" } });
  check("un precio que ya rige no se corrige 409", enVigor.status === 409 && enVigor.data.codigo === "PRECIO_EN_VIGOR");
  let bloqueos = 0;
  for (const sql of ["update precio_medicamento set precio = 1 where id_precio = $1", "delete from precio_medicamento where id_precio = $1"]) {
    try {
      await central.query(sql, [actual.id_precio]);
    } catch (error) {
      if (error.code === "42501") bloqueos += 1;
    }
  }
  check("en la base, el historial que ya rigió no se cambia ni se borra", bloqueos === 2);

  // --- Admin general desde la consola: mismo precio de red
  const enCinco = enDias(5);
  const deGeneral = await pedir(`/api/central/precios/${idMed}`, { method: "POST", token: general, key: nuevaKey(), body: { precio: "1800", desde: enCinco } });
  check("admin general programa otro precio 201", deGeneral.status === 201 && deGeneral.data.historial.length === 3);
  const consola = await pedir(`/api/central/precios?q=${codigo}`, { token: general });
  const enConsola = consola.data.medicamentos?.find((m) => m.id_medicamento === idMed);
  check("consola: vigente y próximo cambio", Number(enConsola?.precio_vigente) === 1000 && Number(enConsola?.proximo?.precio) === 1600);
  check(
    "el próximo cambio trae la misma hora que el historial (sin desfase de zona)",
    enConsola?.proximo && new Date(enConsola.proximo.desde).getTime() === new Date(futuro.fecha_inicio_vigencia).getTime(),
    `${enConsola?.proximo?.desde} / ${futuro?.fecha_inicio_vigencia}`,
  );

  // --- Auditoría
  const auditadas = await central.query(
    "select accion from registro_actividad_central where entidad_afectada = 'medicamento' and id_entidad_afectada = $1",
    [idMed],
  );
  const acciones = auditadas.rows.map((row) => row.accion);
  check(
    "auditoría: 3 registros y 1 reprogramación",
    acciones.filter((a) => a === "PRECIO_REGISTRAR").length === 3 && acciones.filter((a) => a === "PRECIO_REPROGRAMAR").length === 1,
    acciones.join(","),
  );

  // --- Réplica: la tienda tiene el historial completo y aplica cada precio en su instante
  await pullReplica();
  const enTienda = await local.query("select precio::text, fecha_inicio_vigencia, fecha_fin_vigencia from precio_ref where id_medicamento = $1 order by fecha_inicio_vigencia", [idMed]);
  const enCentral = await central.query("select precio::text, fecha_inicio_vigencia, fecha_fin_vigencia from precio_medicamento where id_medicamento = $1 order by fecha_inicio_vigencia", [idMed]);
  check("la tienda tiene el mismo historial que el central", JSON.stringify(enTienda.rows) === JSON.stringify(enCentral.rows), `${enTienda.rowCount}/${enCentral.rowCount}`);
  const vigenteEn = async (dias) =>
    (await local.query("select precio_vigente($1, (now() + make_interval(secs => $2))::timestamp)::text as p", [idMed, dias * 86400])).rows[0].p;
  check("precio_vigente hoy = 1000", (await vigenteEn(0)) === "1000.00");
  check("precio_vigente en 3 días = 1600 (programado corregido)", (await vigenteEn(3)) === "1600.00");
  check("precio_vigente en 6 días = 1800", (await vigenteEn(6)) === "1800.00");
  const busqueda = await pedir(`/api/local/inventario/buscar?q=${codigo}`, { token: cajero });
  check("la búsqueda de inventario muestra el precio vigente", busqueda.status === 200 && busqueda.data.resultados[0]?.precio === "1000.00");

  // --- Sin conexión: consultar sí, cambiar no
  link.estado = "offline";
  const caida = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { precio: "2500" } });
  check("sin central: registrar 503", caida.status === 503 && caida.data.codigo === "SIN_CONEXION");
  check("sin central: no se registró", (await contar(central, "select count(*) as n from precio_medicamento where id_medicamento = $1 and precio = 2500", [idMed])) === 0);
  const offline = await pedir(`/api/local/precios/${idMed}`, { token: cajero });
  check("sin central: el historial se consulta en la tienda", offline.status === 200 && offline.data.historial.length === 3 && Number(offline.data.vigente?.precio) === 1000);
  check("sin central: la consola responde 503", (await pedir(`/api/central/precios/${idMed}`, { token: general })).status === 503);
  link.estado = "online";

  // --- Factura (criterio 3): toma el precio del instante de la venta y no cambia después
  const lote = (await local.query(
    "select l.id_lote, l.id_medicamento from lote l join precio_ref p on p.id_medicamento = l.id_medicamento order by l.id_lote limit 1",
  )).rows[0];
  const empleado = (await local.query("select id_empleado from empleado_ref where usuario = 'admin.tienda'")).rows[0].id_empleado;
  const client = await local.connect();
  try {
    await client.query("begin");
    const precioVenta = (await client.query("select precio_vigente($1)::text as p", [lote.id_medicamento])).rows[0].p;
    const factura = await client.query(
      `insert into factura (numero_factura, id_empleado, subtotal, impuestos, total)
       values ($1, $2, $3::numeric * 2, 0, $3::numeric * 2) returning id_factura, fecha_hora`,
      [`HU03-${S}`, empleado, precioVenta],
    );
    const idFactura = factura.rows[0].id_factura;
    // Lo que hará HU-08: el precio sale de precio_vigente a la hora de la factura, en la misma transacción.
    await client.query(
      `insert into detalle_factura (id_factura, id_lote, cantidad, precio_unitario_aplicado, subtotal_linea)
       select $1, $2, 2, precio_vigente($3, f.fecha_hora), precio_vigente($3, f.fecha_hora) * 2 from factura f where f.id_factura = $1`,
      [idFactura, lote.id_lote, lote.id_medicamento],
    );
    const linea = async () => (await client.query("select precio_unitario_aplicado::text as p from detalle_factura where id_factura = $1", [idFactura])).rows[0].p;
    check("la factura fija el precio vigente al momento de la venta", (await linea()) === precioVenta, precioVenta);
    // Un precio nuevo después (simulado en la réplica, dentro de la transacción que se revierte).
    await client.query(
      `insert into precio_ref (id_precio, id_medicamento, precio, fecha_inicio_vigencia) values (-1, $1, 99999, now()::timestamp + interval '1 second')`,
      [lote.id_medicamento],
    );
    const despues = (await client.query("select precio_vigente($1, now()::timestamp + interval '2 seconds')::text as p", [lote.id_medicamento])).rows[0].p;
    check("tras un cambio de precio, la factura conserva el suyo", despues === "99999.00" && (await linea()) === precioVenta);
    let inmutable = 0;
    for (const sql of [
      "update detalle_factura set precio_unitario_aplicado = 1 where id_factura = $1",
      "update factura set total = 1, subtotal = 1 where id_factura = $1",
      "delete from detalle_factura where id_factura = $1",
    ]) {
      await client.query("savepoint s");
      try {
        await client.query(sql, [idFactura]);
      } catch (error) {
        if (error.code === "42501") inmutable += 1;
      }
      await client.query("rollback to savepoint s");
    }
    check("la factura emitida no se puede modificar ni borrar", inmutable === 3);
    await client.query("savepoint s");
    let estadoOk = true;
    try {
      await client.query("update factura set estado = 'ANULADA' where id_factura = $1", [idFactura]);
    } catch {
      estadoOk = false;
    }
    await client.query("rollback to savepoint s");
    check("el estado sí puede cambiar (anulación, HU-10)", estadoOk);
  } finally {
    await client.query("rollback");
    client.release();
  }
} finally {
  link.estado = "online";
  // El medicamento de prueba queda inactivo: su historial de precios ya no se puede borrar.
  await central.query("update medicamento set activo = false where id_medicamento = $1", [idMed]);
  await local.query("update medicamento_ref set activo = false where id_medicamento = $1", [idMed]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
