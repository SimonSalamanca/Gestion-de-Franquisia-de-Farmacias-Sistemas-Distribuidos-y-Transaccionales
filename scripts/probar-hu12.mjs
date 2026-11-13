import "./lib/owner.mjs";
// Pruebas de HU-12 por las rutas reales de app.mjs: receta obligatoria para medicamentos controlados, validación,
// protección de datos del paciente, auditoría, inmutabilidad y la garantía de la base sobre detalle_factura.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las recetas y pacientes de prueba son permanentes (la receta no se borra:
// es parte de la auditoría), con documentos únicos por corrida. Las facturas viven en transacciones que se revierten.
import crypto from "crypto";
import { hmacDocumento } from "../apps/api/datos-personales.mjs";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { traducirErrorReceta } = await import("../apps/api/recetas.mjs");

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

await migrate();
// Estas pruebas cubren la receta registrada a mano (la garantía de la base y la protección del paciente). Con la validación
// contra el central, ese camino está apagado por política: se enciende solo durante la corrida (ver probar-hu12-central).
await local.query("update politica_receta set permitir_registro_manual = true where id = 1");
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
const entrar = async (usuario) =>
  (await pedir("/api/local/auth/login", { method: "POST", key: crypto.randomUUID(), body: { usuario, password: "Farma123" } })).data.token;
const nuevaKey = () => crypto.randomUUID();
const contar = async (sql, valores = []) => Number((await local.query(sql, valores)).rows[0].n);
const fechaRelativa = async (dias) => (await local.query("select (current_date + $1::int)::text as f", [dias])).rows[0].f;
const S = Date.now().toString(36);

// Resultado de una sentencia dentro de un savepoint: el SQLSTATE y el mensaje del rechazo, o "ok".
async function intentar(client, sql, valores = []) {
  await client.query("savepoint s");
  try {
    await client.query(sql, valores);
    await client.query("release savepoint s");
    return { ok: true };
  } catch (error) {
    await client.query("rollback to savepoint s");
    return { ok: false, code: error.code, message: error.message };
  }
}
const rechazo = (r, prefijo) => !r.ok && r.code === "23514" && r.message.startsWith(prefijo);

const idDe = async (codigo) => (await local.query("select id_medicamento from medicamento_ref where codigo_interno = $1", [codigo])).rows[0]?.id_medicamento;
const idControlado = await idDe("MED-004"); // Amoxicilina: requiere receta
const idControlado2 = await idDe("MED-006"); // Losartán: requiere receta
const idLibre = await idDe("MED-001"); // Acetaminofén: no requiere receta
if (!idControlado || !idControlado2 || !idLibre) {
  console.error("Faltan los medicamentos demo (SEED_DEMO=1): MED-001, MED-004 y MED-006");
  process.exit(2);
}
const loteDe = async (idMed) => (await local.query("select id_lote from lote where id_medicamento = $1 order by id_lote limit 1", [idMed])).rows[0]?.id_lote;
const loteControlado = await loteDe(idControlado);
const loteControlado2 = await loteDe(idControlado2);
const loteLibre = await loteDe(idLibre);
check("hay lotes demo de los tres medicamentos", Boolean(loteControlado && loteControlado2 && loteLibre));

const medico = `Dr. Prueba ${S}`;
const paciente = (n) => ({
  nombre: `Paciente Prueba ${S}-${n}`,
  documento_identidad: `HU12${S.toUpperCase()}${n}`,
  telefono: "3001234567",
  correo: `paciente${n}.${S}@prueba.co`,
});
const receta = async (fecha, cliente, medicamentos) => ({ medico_prescriptor: medico, fecha_emision: fecha, cliente, medicamentos });

try {
  const cajero = await entrar("cajero1");
  const admin = await entrar("admin.tienda");
  check("logins demo", Boolean(cajero && admin));
  const hoy = await fechaRelativa(0);

  // --- Acceso
  check("sin sesión 401", (await pedir("/api/local/recetas")).status === 401);
  check("consola central sin rutas de receta: 404", (await pedir("/api/central/recetas", { token: admin })).status === 404);

  // --- Criterio 5: sin receta obligatoria no se pide nada
  const libre = await pedir("/api/local/recetas/validar", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idLibre, cantidad: 2 }] } });
  check("medicamento sin receta obligatoria: puede continuar sin receta", libre.status === 200 && libre.data.puede_continuar && !libre.data.requiere_receta && libre.data.lineas[0].estado === "NO_REQUIERE");

  // --- Criterios 1 y 2: el controlado exige receta
  const sinReceta = await pedir("/api/local/recetas/validar", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idControlado, cantidad: 1 }, { id_medicamento: idLibre, cantidad: 1 }] } });
  check("medicamento controlado sin receta: exige receta y no continúa", sinReceta.data.requiere_receta && !sinReceta.data.puede_continuar && sinReceta.data.lineas.find((l) => l.id_medicamento === idControlado).estado === "RECETA_REQUERIDA");
  const catalogo = await pedir("/api/local/recetas/medicamentos?q=amoxi", { token: cajero });
  check("el catálogo de receta solo lista medicamentos controlados", catalogo.status === 200 && catalogo.data.medicamentos.some((m) => m.id_medicamento === idControlado));
  const todos = await pedir("/api/local/recetas/medicamentos", { token: cajero });
  check("el catálogo de receta no incluye los de venta libre", !todos.data.medicamentos.some((m) => m.id_medicamento === idLibre));

  // --- Validaciones del registro
  const valida = await receta(hoy, paciente("A"), [{ id_medicamento: idControlado, cantidad: 3 }]);
  const mala = async (cambio, nombre, status = 400) => {
    const r = await pedir("/api/local/recetas", { method: "POST", token: cajero, key: nuevaKey(), body: { ...valida, ...cambio } });
    check(nombre, r.status === status, `${r.status} ${r.data.codigo || ""} ${r.data.mensaje || ""}`);
    return r;
  };
  check("sin Idempotency-Key 400", (await pedir("/api/local/recetas", { method: "POST", token: cajero, body: valida })).status === 400);
  await mala({ medico_prescriptor: "  " }, "sin médico 400");
  await mala({ fecha_emision: "" }, "sin fecha 400");
  await mala({ fecha_emision: "2026-02-30" }, "fecha inexistente 400");
  await mala({ fecha_emision: await fechaRelativa(1) }, "fecha futura 400");
  const vencida = await mala({ fecha_emision: await fechaRelativa(-31) }, "receta vencida (31 días) 400");
  check("el rechazo por vencida es RECETA_VENCIDA", vencida.data.codigo === "RECETA_VENCIDA");
  await mala({ cliente: { nombre: "", documento_identidad: "12345678" } }, "sin nombre del paciente 400");
  await mala({ cliente: { nombre: "Ana", documento_identidad: "" } }, "sin documento del paciente 400");
  await mala({ cliente: { nombre: "Ana", documento_identidad: "12 34!" } }, "documento con formato inválido 400");
  await mala({ medicamentos: [] }, "sin medicamentos 400");
  await mala({ medicamentos: [{ id_medicamento: idControlado, cantidad: 0 }] }, "cantidad cero 400");
  await mala({ medicamentos: [{ id_medicamento: idControlado, cantidad: 1 }, { id_medicamento: idControlado, cantidad: 1 }] }, "medicamento repetido 400");
  await mala({ medicamentos: [{ id_medicamento: 99999999, cantidad: 1 }] }, "medicamento inexistente 400");
  const libreEnReceta = await mala({ medicamentos: [{ id_medicamento: idLibre, cantidad: 1 }] }, "un medicamento sin receta obligatoria no va en una receta 400");
  check("el rechazo es NO_REQUIERE_RECETA", libreEnReceta.data.codigo === "NO_REQUIERE_RECETA");
  check("ninguna validación dejó recetas del médico de prueba", (await contar("select count(*) as n from receta where medico_prescriptor = $1", [medico])) === 0);

  // --- Registro (criterio 1)
  const key = nuevaKey();
  const datosA = paciente("A");
  const primera = await pedir("/api/local/recetas", { method: "POST", token: cajero, key, body: valida });
  check("el cajero registra la receta 201", primera.status === 201, `${primera.status} ${primera.data.mensaje || ""}`);
  const idA = primera.data.id_receta;
  check("la receta trae médico, fecha y medicamento", primera.data.medico_prescriptor === medico && primera.data.fecha_emision === hoy && primera.data.medicamentos[0].id_medicamento === idControlado && primera.data.medicamentos[0].saldo === 3);
  check("la respuesta enmascara el documento del paciente", primera.data.paciente_documento === `****${datosA.documento_identidad.slice(-4)}` && !JSON.stringify(primera.data).includes(datosA.documento_identidad) && !JSON.stringify(primera.data).includes(datosA.telefono));
  check("queda la receta como utilizable", primera.data.utilizable === true && primera.data.vigente === true);
  const repetida = await pedir("/api/local/recetas", { method: "POST", token: cajero, key, body: valida });
  check("reintento con la misma clave: misma receta", repetida.status === 201 && repetida.data.id_receta === idA);
  check("la misma clave con otros datos 409", (await pedir("/api/local/recetas", { method: "POST", token: cajero, key, body: { ...valida, medico_prescriptor: "Otro" } })).status === 409);
  check("una sola receta tras los reintentos", (await contar("select count(*) as n from receta where medico_prescriptor = $1", [medico])) === 1);
  const otraDelMismo = await pedir("/api/local/recetas", { method: "POST", token: cajero, key: nuevaKey(), body: await receta(hoy, datosA, [{ id_medicamento: idControlado2, cantidad: 2 }]) });
  check("otra receta del mismo paciente 201", otraDelMismo.status === 201);
  check("el paciente no se duplica (un cliente por documento)", (await contar("select count(*) as n from cliente where documento_hmac = $1", [hmacDocumento(datosA.documento_identidad)])) === 1);

  // --- Criterio 4: auditoría con el detalle de la receta, sin datos del paciente
  const auditoria = await local.query("select accion, entidad_afectada, detalle, id_empleado from registro_actividad where accion = 'RECETA_REGISTRAR' and id_entidad_afectada = $1", [idA]);
  const detalle = auditoria.rows[0]?.detalle || "";
  check("RECETA_REGISTRAR auditada con médico, fecha y medicamento", auditoria.rowCount === 1 && detalle.includes(medico) && detalle.includes(hoy) && detalle.includes("Amoxicilina"), detalle);
  check("la auditoría no contiene datos del paciente", !detalle.includes(datosA.documento_identidad) && !detalle.includes(datosA.nombre) && !detalle.includes(datosA.telefono));
  check("la auditoría guarda quién registró", auditoria.rows[0]?.id_empleado === (await local.query("select id_empleado from empleado_ref where usuario = 'cajero1'")).rows[0].id_empleado);

  // --- Datos personales por rol (RNF-02, regla 15)
  const deCajero = await pedir(`/api/local/recetas/${idA}`, { token: cajero });
  check("el cajero ve la receta con el documento enmascarado y sin contacto", deCajero.status === 200 && deCajero.data.paciente_documento.startsWith("****") && !("paciente_telefono" in deCajero.data) && !JSON.stringify(deCajero.data).includes(datosA.correo));
  const consultasAntes = await contar("select count(*) as n from registro_actividad where accion = 'CLIENTE_DATOS_CONSULTAR' and id_entidad_afectada = $1", [idA]);
  const deAdmin = await pedir(`/api/local/recetas/${idA}`, { token: admin });
  check("el administrador ve los datos completos del paciente", deAdmin.status === 200 && deAdmin.data.paciente_documento === datosA.documento_identidad && deAdmin.data.paciente_telefono === datosA.telefono && deAdmin.data.paciente_correo === datosA.correo);
  check("ver datos personales queda auditado", (await contar("select count(*) as n from registro_actividad where accion = 'CLIENTE_DATOS_CONSULTAR' and id_entidad_afectada = $1", [idA])) === consultasAntes + 1);
  const lista = await pedir("/api/local/recetas?q=" + encodeURIComponent(medico), { token: admin });
  check("el listado siempre enmascara el documento, incluso al administrador", lista.status === 200 && lista.data.recetas.length === 2 && lista.data.recetas.every((r) => r.paciente_documento.startsWith("****")));
  const porDocumento = await pedir(`/api/local/recetas?documento=${datosA.documento_identidad}&id_medicamento=${idControlado}&solo_utilizables=1`, { token: cajero });
  check("el cajero ubica la receta del paciente por documento y medicamento", porDocumento.data.recetas?.length === 1 && porDocumento.data.recetas[0].id_receta === idA);
  check("receta inexistente 404", (await pedir("/api/local/recetas/99999999", { token: cajero })).status === 404);
  check("factura inexistente 404", (await pedir("/api/local/recetas/factura/99999999", { token: cajero })).status === 404);

  // --- Validación anticipada con receta
  const validar = async (cuerpo) => (await pedir("/api/local/recetas/validar", { method: "POST", token: cajero, body: cuerpo })).data;
  const estadoDe = (r, idMed) => r.lineas.find((l) => l.id_medicamento === idMed).estado;
  const conReceta = await validar({ id_receta: idA, lineas: [{ id_medicamento: idControlado, cantidad: 3 }] });
  check("con receta válida y saldo: puede continuar", conReceta.puede_continuar && estadoDe(conReceta, idControlado) === "OK");
  check("pedir más de lo autorizado: RECETA_SALDO", estadoDe(await validar({ id_receta: idA, lineas: [{ id_medicamento: idControlado, cantidad: 4 }] }), idControlado) === "RECETA_SALDO");
  check("la receta de otro medicamento no sirve: RECETA_INVALIDA", estadoDe(await validar({ id_receta: idA, lineas: [{ id_medicamento: idControlado2, cantidad: 1 }] }), idControlado2) === "RECETA_INVALIDA");
  const clienteA = (await local.query("select id_cliente from cliente where documento_hmac = $1", [hmacDocumento(datosA.documento_identidad)])).rows[0].id_cliente;
  check("receta de otro paciente: RECETA_CLIENTE", estadoDe(await validar({ id_receta: idA, id_cliente: clienteA + 100000, lineas: [{ id_medicamento: idControlado, cantidad: 1 }] }), idControlado) === "RECETA_CLIENTE");
  check("receta inexistente: RECETA_INVALIDA", estadoDe(await validar({ id_receta: 99999999, lineas: [{ id_medicamento: idControlado, cantidad: 1 }] }), idControlado) === "RECETA_INVALIDA");
  check("líneas vacías 400", (await pedir("/api/local/recetas/validar", { method: "POST", token: cajero, body: { lineas: [] } })).status === 400);

  // --- Sin conexión con el central: todo sigue funcionando (autonomía local) y no se encola nada
  const colaAntes = await contar("select count(*) as n from outbox_sync");
  link.estado = "offline";
  const offline = await pedir("/api/local/recetas", { method: "POST", token: cajero, key: nuevaKey(), body: await receta(hoy, paciente("B"), [{ id_medicamento: idControlado, cantidad: 1 }]) });
  check("sin central: la receta se registra 201", offline.status === 201);
  check("sin central: la receta se consulta y se valida", (await pedir(`/api/local/recetas/${offline.data.id_receta}`, { token: cajero })).status === 200 && (await validar({ id_receta: offline.data.id_receta, lineas: [{ id_medicamento: idControlado, cantidad: 1 }] })).puede_continuar);
  link.estado = "online";
  check("la receta no genera eventos al central (los datos del paciente no salen de la tienda)", (await contar("select count(*) as n from outbox_sync")) === colaAntes);
  const idB = offline.data.id_receta;

  // --- La receta registrada es inmutable
  let inmutables = 0;
  for (const sql of [
    "update receta set medico_prescriptor = 'Otro' where id_receta = $1",
    "update receta set fecha_emision = current_date - 1 where id_receta = $1",
    "delete from receta where id_receta = $1",
    "update receta_medicamento set cantidad_autorizada = 99 where id_receta = $1",
    "delete from receta_medicamento where id_receta = $1",
  ]) {
    const r = await intentarFuera(sql, idA);
    if (!r.ok && r.code === "42501") inmutables += 1;
  }
  check("en la base, la receta no se modifica ni se borra", inmutables === 5, String(inmutables));

  // --- Garantía de la base sobre la factura (criterios 1, 2, 3 y 5), en transacciones que se revierten
  const empleado = (await local.query("select id_empleado from empleado_ref where usuario = 'cajero1'")).rows[0].id_empleado;
  const client = await local.connect();
  try {
    await client.query("begin");
    const nuevaFactura = async (idCliente, sufijo) =>
      (await client.query(
        `insert into factura (numero_factura, id_cliente, id_empleado, subtotal, impuestos, total) values ($1, $2, $3, 100, 0, 100) returning id_factura`,
        [`HU12-${S}-${sufijo}`, idCliente, empleado],
      )).rows[0].id_factura;
    const linea = (idFactura, idLote, cantidad, idReceta) =>
      intentar(client, "insert into detalle_factura (id_factura, id_lote, id_receta, cantidad, precio_unitario_aplicado, subtotal_linea) values ($1, $2, $3, $4, 10, $4 * 10)", [idFactura, idLote, idReceta, cantidad]);
    const dispensado = async (idReceta, idMed) =>
      (await client.query("select cantidad_dispensada from receta_medicamento where id_receta = $1 and id_medicamento = $2", [idReceta, idMed])).rows[0].cantidad_dispensada;

    const f1 = await nuevaFactura(clienteA, "1");
    check("criterio 2: controlado sin receta, la base rechaza la línea", rechazo(await linea(f1, loteControlado, 1, null), "RECETA_REQUERIDA"));
    check("criterio 5: sin receta obligatoria, la línea se acepta sin receta", (await linea(f1, loteLibre, 2, null)).ok);
    check("la receta de otro medicamento no sirve", rechazo(await linea(f1, loteControlado2, 1, idB), "RECETA_INVALIDA"));
    check("una receta inexistente no sirve", rechazo(await linea(f1, loteControlado, 1, 99999999), "RECETA_INVALIDA"));
    check("la receta de otro paciente no sirve", rechazo(await linea(f1, loteControlado, 1, idB), "RECETA_CLIENTE"));
    check("pedir más de lo autorizado se rechaza", rechazo(await linea(f1, loteControlado, 4, idA), "RECETA_SALDO"));
    check("las líneas rechazadas no descontaron de la receta", (await dispensado(idA, idControlado)) === 0);
    check("criterio 1 y 3: con receta válida la línea se acepta y guarda la receta", (await linea(f1, loteControlado, 2, idA)).ok);
    const guardada = await client.query("select id_receta from detalle_factura where id_factura = $1 and id_lote = $2", [f1, loteControlado]);
    check("criterio 3: la línea de la factura queda asociada a la receta", guardada.rows[0]?.id_receta === idA);
    check("la línea descuenta de la receta", (await dispensado(idA, idControlado)) === 2);
    const f2 = await nuevaFactura(clienteA, "2");
    check("la receta no se reutiliza más allá de lo autorizado", rechazo(await linea(f2, loteControlado, 2, idA), "RECETA_SALDO"));
    check("pero sí alcanza para el saldo que queda", (await linea(f2, loteControlado, 1, idA)).ok && (await dispensado(idA, idControlado)) === 3);

    // El API traduce el rechazo de la base a un error de negocio que HU-08 puede responder tal cual.
    const rechazado = await linea(await nuevaFactura(clienteA, "3"), loteControlado, 1, null);
    const traducido = traducirErrorReceta({ code: rechazado.code, message: rechazado.message });
    check("traducirErrorReceta: 409 RECETA_REQUERIDA", traducido.status === 409 && traducido.codigo === "RECETA_REQUERIDA");

    // Receta vencida: se crea ya vieja dentro de la transacción (el API no permite registrarla).
    const vieja = (await client.query(
      "insert into receta (medico_prescriptor, fecha_emision, id_cliente, id_empleado_registro) values ($1, current_date - 40, $2, $3) returning id_receta",
      [medico, clienteA, empleado],
    )).rows[0].id_receta;
    await client.query("insert into receta_medicamento (id_receta, id_medicamento, cantidad_autorizada) values ($1, $2, 5)", [vieja, idControlado]);
    check("una receta vencida no sirve", rechazo(await linea(await nuevaFactura(clienteA, "4"), loteControlado, 1, vieja), "RECETA_VENCIDA"));
    await client.query("rollback");

    // El rollback de la venta devuelve el saldo a la receta.
    check("al revertirse la venta, la receta recupera su saldo", (await contar("select cantidad_dispensada as n from receta_medicamento where id_receta = $1 and id_medicamento = $2", [idA, idControlado])) === 0);
  } finally {
    client.release();
  }

  // --- Concurrencia: dos ventas sobre la misma receta se serializan (el bloqueo de la fila)
  const a = await local.connect();
  const b = await local.connect();
  try {
    await a.query("begin");
    await b.query("begin");
    await b.query("set local lock_timeout = '1500ms'");
    const insertar = (c, sufijo) =>
      c.query(
        `with f as (insert into factura (numero_factura, id_cliente, id_empleado, subtotal, impuestos, total) values ($1, $2, $3, 100, 0, 100) returning id_factura)
         insert into detalle_factura (id_factura, id_lote, id_receta, cantidad, precio_unitario_aplicado, subtotal_linea)
         select id_factura, $4, $5, 3, 10, 30 from f`,
        [`HU12-${S}-${sufijo}`, clienteA, empleado, loteControlado, idA],
      );
    await insertar(a, "CA");
    let esperaB = null;
    try {
      await insertar(b, "CB");
    } catch (error) {
      esperaB = error.code;
    }
    check("la segunda venta sobre la misma receta espera al bloqueo de la primera", esperaB === "55P03", String(esperaB));
    await a.query("rollback");
    await b.query("rollback");
  } finally {
    a.release();
    b.release();
  }
  check("tras la concurrencia la receta sigue intacta", (await contar("select cantidad_dispensada as n from receta_medicamento where id_receta = $1 and id_medicamento = $2", [idA, idControlado])) === 0);
} finally {
  await local.query("update politica_receta set permitir_registro_manual = false where id = 1");
  link.estado = "online";
  server.close();
}

// Rechazos de inmutabilidad: cada sentencia en su propia conexión, sin transacción abierta.
async function intentarFuera(sql, id) {
  try {
    await local.query(sql, [id]);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

console.log(fallos.length ? `\n${fallos.length} FALLOS:\n- ${fallos.join("\n- ")}` : "\nTodas las pruebas de HU-12 pasaron");
await central.end();
await local.end();
process.exit(fallos.length ? 1 : 0);
