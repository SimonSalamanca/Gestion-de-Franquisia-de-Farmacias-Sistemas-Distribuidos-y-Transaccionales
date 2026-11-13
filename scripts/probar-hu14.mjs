import "./lib/owner.mjs";
import { desactivarMedicamentos, desactivarProveedores, publicarAltaMedicamento } from "./lib/central.mjs";
// Pruebas de HU-14 por las rutas reales de app.mjs: la recepción pide lote y caducidad, actualiza el inventario con lote y
// proveedor, queda ligada a la solicitud original, deja constancia de las diferencias (faltante y sobrante) y se audita con
// responsable, fecha y hora. También idempotencia, concurrencia, inmutabilidad y funcionamiento sin conexión.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Cada corrida crea sus proveedor y medicamentos; al final quedan inactivos (los lotes, las
// recepciones y sus constancias no se pueden borrar).
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
const S = Date.now().toString(36);

// Dos medicamentos propios de esta corrida (HU-04: todo producto activo lleva umbral en cada tienda activa).
async function crearMedicamento(sufijo) {
  const r = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'prueba de recepción') returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
    [`HU14${sufijo}-${S}`.toUpperCase(), `Prueba Recepción ${sufijo} ${S}`],
  );
  await publicarAltaMedicamento(r.rows[0].id_medicamento);
  return r.rows[0].id_medicamento;
}
const idA = await crearMedicamento("A");
const idB = await crearMedicamento("B");
await migrate();
await pullReplica();

const proveedoresCreados = [];
try {
  const general = await entrar("central", "admin.general");
  const adminTienda = await entrar("local", "admin.tienda");
  const cajero = await entrar("local", "cajero1");
  check("logins demo", Boolean(general && adminTienda && cajero));
  const idAdmin = (await local.query("select id_empleado from empleado_ref where usuario = 'admin.tienda'")).rows[0].id_empleado;

  // Proveedor de la corrida (HU-13) replicado a la tienda.
  const prov = await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key: nuevaKey(), body: { nombre_empresa: `Proveedor Recepción ${S}`, nit: `HU14-${S}`.toUpperCase() } });
  const idProv = prov.data.id_proveedor;
  proveedoresCreados.push(idProv);
  await pullReplica();

  const caducidad = (await local.query("select (current_date + 400)::text as f")).rows[0].f;
  const ayer = (await local.query("select (current_date - 1)::text as f")).rows[0].f;

  // Solicitud con la que se trabaja: genera, envía y devuelve su detalle.
  async function solicitud(lineas) {
    const r = await pedir("/api/local/solicitudes", { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas } });
    if (r.status !== 201) throw new Error(`no se pudo crear la solicitud: ${r.status} ${r.data.mensaje}`);
    return r.data;
  }
  const recibir = (idPedido, body, { key = nuevaKey(), token = adminTienda } = {}) =>
    pedir(`/api/local/pedidos/${idPedido}/recepcion`, { method: "POST", token, key, body });
  const lineaRec = (id, n, cantidad, fecha = caducidad) => ({ id_medicamento: id, numero_lote: `L-${n}-${S}`, fecha_caducidad: fecha, cantidad });

  // --- Permisos
  const sol = await solicitud([{ id_medicamento: idA, cantidad: 30 }, { id_medicamento: idB, cantidad: 20 }]);
  const idPedido = sol.id_pedido;
  check("sin sesión 401", (await pedir(`/api/local/pedidos/${idPedido}/recepcion`, { method: "POST", key: nuevaKey(), body: {} })).status === 401);
  check("el cajero no recibe pedidos 403", (await recibir(idPedido, { lineas: [lineaRec(idA, 1, 5)] }, { token: cajero })).status === 403);
  check("el cajero no consulta las recepciones 403", (await pedir(`/api/local/pedidos/${idPedido}/recepciones`, { token: cajero })).status === 403);
  check("el cajero no cierra pedidos 403", (await pedir(`/api/local/pedidos/${idPedido}/cierre`, { method: "POST", token: cajero, key: nuevaKey(), body: { motivo_diferencia: "no debe poder" } })).status === 403);

  // --- Criterio 1: lote y fecha de caducidad obligatorios
  const antes = {
    recepciones: await contar(local, "select count(*) as n from recepcion where id_pedido = $1", [idPedido]),
    movimientos: await contar(local, "select count(*) as n from movimiento_inventario where referencia_documento = $1", [`PEDIDO-${idPedido}`]),
  };
  const sinKey = await pedir(`/api/local/pedidos/${idPedido}/recepcion`, { method: "POST", token: adminTienda, body: { lineas: [lineaRec(idA, 1, 5)] } });
  check("sin Idempotency-Key 400", sinKey.status === 400);
  check("sin líneas 400", (await recibir(idPedido, { lineas: [] })).status === 400);
  const sinLote = await recibir(idPedido, { lineas: [{ id_medicamento: idA, fecha_caducidad: caducidad, cantidad: 5 }] });
  check("sin número de lote 400 en el campo", sinLote.status === 400 && sinLote.data.campo === "numero_lote");
  const sinFecha = await recibir(idPedido, { lineas: [{ id_medicamento: idA, numero_lote: "X", cantidad: 5 }] });
  check("sin caducidad 400 en el campo", sinFecha.status === 400 && sinFecha.data.campo === "fecha_caducidad");
  check("caducidad en el pasado 400", (await recibir(idPedido, { lineas: [lineaRec(idA, 1, 5, ayer)] })).status === 400);
  check("cantidad cero o negativa 400", (await recibir(idPedido, { lineas: [lineaRec(idA, 1, 0)] })).status === 400 && (await recibir(idPedido, { lineas: [lineaRec(idA, 1, -2)] })).status === 400);
  const ajeno = await recibir(idPedido, { lineas: [lineaRec(99999999, 1, 5)] });
  check("un medicamento que no está en el pedido 400", ajeno.status === 400);
  const exceso = await recibir(idPedido, { lineas: [lineaRec(idA, 1, 31)] });
  check("recibir más de lo pendiente sin motivo 400 (HU-02 sigue igual)", exceso.status === 400 && /pendientes/.test(exceso.data.mensaje) && exceso.data.campo === "motivo_diferencia");
  check("pedido inexistente 404", (await recibir(99999999, { lineas: [lineaRec(idA, 1, 5)] })).status === 404);
  check(
    "los rechazos no dejan nada guardado",
    (await contar(local, "select count(*) as n from recepcion where id_pedido = $1", [idPedido])) === antes.recepciones &&
      (await contar(local, "select count(*) as n from movimiento_inventario where referencia_documento = $1", [`PEDIDO-${idPedido}`])) === antes.movimientos,
  );

  // --- Criterios 2, 3 y 5: recepción parcial; inventario, vínculo con la solicitud y auditoría
  const keyParcial = nuevaKey();
  const cuerpoParcial = { lineas: [lineaRec(idA, 1, 30)], documento_proveedor: `REM-${S}` };
  const parcial = await recibir(idPedido, cuerpoParcial, { key: keyParcial });
  check("recepción parcial 200 en estado RECIBIDO_PARCIAL", parcial.status === 200 && parcial.data.estado === "RECIBIDO_PARCIAL" && parcial.data.con_diferencia === false, `${parcial.status} ${parcial.data.mensaje || ""}`);
  const idRec1 = parcial.data.id_recepcion;
  const lote = (await local.query("select id_lote, id_proveedor, cantidad_disponible, cantidad_inicial, fecha_caducidad, estado from lote where id_lote = $1", [parcial.data.lotes[0]])).rows[0];
  check("el inventario se actualiza: lote con las unidades recibidas", lote.cantidad_disponible === 30 && lote.cantidad_inicial === 30 && lote.fecha_caducidad === caducidad && lote.estado === "DISPONIBLE");
  check("el lote queda asociado al proveedor del pedido", lote.id_proveedor === idProv);
  const mov = (await local.query("select tipo_movimiento, cantidad, id_empleado, referencia_documento from movimiento_inventario where id_lote = $1", [lote.id_lote])).rows;
  check("un movimiento ENTRADA ligado al pedido", mov.length === 1 && mov[0].tipo_movimiento === "ENTRADA" && mov[0].cantidad === 30 && mov[0].referencia_documento === `PEDIDO-${idPedido}` && mov[0].id_empleado === idAdmin);
  const rec = (await local.query("select id_pedido, id_empleado, fecha_hora, documento_proveedor from recepcion where id_recepcion = $1", [idRec1])).rows[0];
  check("la recepción queda vinculada a la solicitud original", rec.id_pedido === idPedido && rec.id_empleado === idAdmin && rec.documento_proveedor === `REM-${S}`);
  const det = (await local.query("select id_medicamento, id_lote, id_proveedor, cantidad from detalle_recepcion where id_recepcion = $1", [idRec1])).rows;
  check("el detalle liga medicamento, lote y proveedor", det.length === 1 && det[0].id_medicamento === idA && det[0].id_lote === lote.id_lote && det[0].id_proveedor === idProv && det[0].cantidad === 30);
  check("el stock vendible del medicamento sube", (await contar(local, "select coalesce(sum(cantidad_disponible), 0) as n from lote where id_medicamento = $1 and estado = 'DISPONIBLE'", [idA])) === 30);
  const aud = (await local.query("select id_empleado, fecha_hora, detalle from registro_actividad where accion = 'PEDIDO_RECIBIR' and id_entidad_afectada = $1 order by id_registro", [idPedido])).rows;
  check("auditoría: PEDIDO_RECIBIR con responsable", aud.length === 1 && aud[0].id_empleado === idAdmin && aud[0].detalle.includes(`recepción ${idRec1}`) && aud[0].detalle.includes(`REM-${S}`), JSON.stringify(aud));
  check("auditoría con fecha y hora actuales", Math.abs(Date.now() - new Date(aud[0].fecha_hora).getTime()) < 120000);
  const rep = await recibir(idPedido, cuerpoParcial, { key: keyParcial });
  check("reintento con la misma clave: la misma recepción", rep.status === 200 && rep.data.id_recepcion === idRec1);
  check("el reintento no duplica el inventario", (await contar(local, "select cantidad_disponible as n from lote where id_lote = $1", [lote.id_lote])) === 30 && (await contar(local, "select count(*) as n from recepcion where id_pedido = $1", [idPedido])) === 1);
  const doble = nuevaKey();
  const cuerpoDoble = { lineas: [lineaRec(idB, 2, 5)] };
  const [d1, d2] = await Promise.all([recibir(idPedido, cuerpoDoble, { key: doble }), recibir(idPedido, cuerpoDoble, { key: doble })]);
  check("doble clic simultáneo: una sola recepción", d1.data.id_recepcion === d2.data.id_recepcion && (await contar(local, "select count(*) as n from recepcion where id_pedido = $1", [idPedido])) === 2);
  check("misma clave con otros datos 409", (await recibir(idPedido, { lineas: [lineaRec(idB, 2, 6)] }, { key: doble })).status === 409);
  const sinCerrar = await recibir(idPedido, { lineas: [lineaRec(idB, 3, 1)], motivo_diferencia: "se recibirá el resto después" });
  check("el motivo sin diferencia que cerrar no cambia el estado", sinCerrar.status === 200 && sinCerrar.data.estado === "RECIBIDO_PARCIAL" && sinCerrar.data.diferencias.length === 0);

  // --- Criterio 4: la diferencia queda registrada (faltante al cerrar con 14 de 20)
  const stockB = () => contar(local, "select coalesce(sum(cantidad_disponible), 0) as n from lote where id_medicamento = $1", [idB]);
  check("hasta aquí B tiene 6 unidades (5 + 1)", (await stockB()) === 6);
  const sinMotivo = await recibir(idPedido, { lineas: [lineaRec(idB, 4, 8)], cerrar_con_diferencia: true });
  check("cerrar con faltante sin motivo 400 MOTIVO_DIFERENCIA_OBLIGATORIO", sinMotivo.status === 400 && sinMotivo.data.codigo === "MOTIVO_DIFERENCIA_OBLIGATORIO");
  check("y no se recibió nada", (await stockB()) === 6);
  const cierre = await recibir(idPedido, { lineas: [lineaRec(idB, 4, 8)], cerrar_con_diferencia: true, motivo_diferencia: "El proveedor no entregó el resto" });
  check("cerrar con faltante y motivo 200 en RECIBIDO_TOTAL", cierre.status === 200 && cierre.data.estado === "RECIBIDO_TOTAL" && cierre.data.con_diferencia === true, `${cierre.status} ${cierre.data.mensaje || ""}`);
  const dif = cierre.data.diferencias?.[0];
  check("la constancia trae solicitado, recibido y faltante", dif?.tipo === "FALTANTE" && dif.cantidad_solicitada === 20 && dif.cantidad_recibida === 14 && dif.diferencia === -6, JSON.stringify(dif));
  const filaDif = (await local.query("select id_pedido, id_recepcion, motivo, id_empleado, fecha_hora from diferencia_recepcion where id_pedido = $1", [idPedido])).rows;
  check("la diferencia queda ligada al pedido y a la recepción, con responsable y motivo", filaDif.length === 1 && filaDif[0].id_recepcion === cierre.data.id_recepcion && filaDif[0].id_empleado === idAdmin && filaDif[0].motivo === "El proveedor no entregó el resto");
  const audDif = (await local.query("select id_empleado, detalle from registro_actividad where accion = 'RECEPCION_DIFERENCIA' and id_entidad_afectada = $1", [idPedido])).rows;
  check("auditoría: RECEPCION_DIFERENCIA con el responsable y el motivo", audDif.length === 1 && audDif[0].id_empleado === idAdmin && audDif[0].detalle.includes("Motivo: El proveedor no entregó el resto") && audDif[0].detalle.includes("-6"));
  const detalleSol = await pedir(`/api/local/solicitudes/${idPedido}`, { token: adminTienda });
  check("el estado de la solicitud es RECIBIDA con diferencia", detalleSol.data.estado_visible === "RECIBIDA" && detalleSol.data.con_diferencia === true && detalleSol.data.fecha_recepcion != null);
  const historial = await pedir(`/api/local/solicitudes/${idPedido}/recepciones`, { token: adminTienda });
  check("la solicitud lista sus 4 recepciones con lotes y su diferencia", historial.status === 200 && historial.data.recepciones.length === 4 && historial.data.diferencias.length === 1 && historial.data.recepciones.every((r) => r.responsable === "Luis Mora" && r.lineas.length === 1 && r.lineas[0].numero_lote));
  const historial2 = await pedir(`/api/local/pedidos/${idPedido}/recepciones`, { token: adminTienda });
  check("el historial también está en Lotes y recepción", historial2.status === 200 && historial2.data.proveedor.startsWith("Proveedor Recepción"));
  check("un pedido recibido ya no admite recepciones 409", (await recibir(idPedido, { lineas: [lineaRec(idB, 5, 1)] })).data.codigo === "PEDIDO_CERRADO");
  const lista = await pedir("/api/local/solicitudes?estado=RECIBIDA", { token: adminTienda });
  check("la lista de solicitudes marca la diferencia", lista.data.solicitudes.find((s) => s.id_pedido === idPedido)?.con_diferencia === true);

  // --- Constancias inmutables
  let bloqueos = 0;
  for (const sql of [
    ["update recepcion set observaciones = 'x' where id_recepcion = $1", idRec1],
    ["delete from recepcion where id_recepcion = $1", idRec1],
    ["update detalle_recepcion set cantidad = 1 where id_recepcion = $1", idRec1],
    ["delete from detalle_recepcion where id_recepcion = $1", idRec1],
    ["update diferencia_recepcion set motivo = 'cambiado a escondidas' where id_pedido = $1", idPedido],
    ["delete from diferencia_recepcion where id_pedido = $1", idPedido],
  ]) {
    try {
      await local.query(sql[0], [sql[1]]);
    } catch (error) {
      if (error.code === "42501") bloqueos += 1;
    }
  }
  check("en la base, recepciones y diferencias no se editan ni se borran", bloqueos === 6, `${bloqueos}/6`);
  let incoherente = 0;
  for (const sql of [
    "insert into diferencia_recepcion (id_pedido, id_medicamento, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado) select $1, $2, 'FALTANTE', 10, 8, 5, 'no cuadra', $3",
    "insert into diferencia_recepcion (id_pedido, id_medicamento, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado) select $1, $2, 'SOBRANTE', 10, 8, -2, 'tipo al revés', $3",
    "insert into diferencia_recepcion (id_pedido, id_medicamento, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado) select $1, $2, 'FALTANTE', 10, 8, -2, 'x', $3",
  ]) {
    try {
      await local.query(sql, [idPedido, idA, idAdmin]);
    } catch (error) {
      if (error.code === "23514") incoherente += 1;
    }
  }
  check("la base rechaza una diferencia que no cuadra o sin motivo", incoherente === 3, `${incoherente}/3`);

  // --- Sobrante: llega más de lo pedido (12 de 10)
  const solSobrante = await solicitud([{ id_medicamento: idA, cantidad: 10 }]);
  const sobra = await recibir(solSobrante.id_pedido, { lineas: [lineaRec(idA, 6, 12)], motivo_diferencia: "El proveedor envió dos cajas de más" });
  check("recibir de más con motivo 200 y RECIBIDO_TOTAL", sobra.status === 200 && sobra.data.estado === "RECIBIDO_TOTAL" && sobra.data.con_diferencia === true, `${sobra.status} ${sobra.data.mensaje || ""}`);
  check("constancia de sobrante +2", sobra.data.diferencias[0]?.tipo === "SOBRANTE" && sobra.data.diferencias[0].diferencia === 2 && sobra.data.diferencias[0].cantidad_recibida === 12);
  check("el inventario recibe las 12 unidades", (await contar(local, "select cantidad_disponible as n from lote where id_lote = $1", [sobra.data.lotes[0]])) === 12);

  // --- Pedido recibido completo, en dos entregas, sin diferencias
  const solExacta = await solicitud([{ id_medicamento: idB, cantidad: 20 }]);
  const e1 = await recibir(solExacta.id_pedido, { lineas: [lineaRec(idB, 7, 12)] });
  const e2 = await recibir(solExacta.id_pedido, { lineas: [lineaRec(idB, 8, 8)] });
  check("dos entregas que suman lo pedido: parcial y luego total", e1.data.estado === "RECIBIDO_PARCIAL" && e2.data.estado === "RECIBIDO_TOTAL");
  check("sin diferencias no queda constancia", e2.data.con_diferencia === false && (await contar(local, "select count(*) as n from diferencia_recepcion where id_pedido = $1", [solExacta.id_pedido])) === 0);
  check("cerrar un pedido sin diferencia 400", (await recibir(solExacta.id_pedido, { lineas: [lineaRec(idB, 9, 1)], cerrar_con_diferencia: true, motivo_diferencia: "no aplica" })).data.codigo === "PEDIDO_CERRADO");

  // --- Cerrar con diferencia sin recibir nada nuevo (el proveedor no enviará el resto)
  const solCierre = await solicitud([{ id_medicamento: idA, cantidad: 25 }, { id_medicamento: idB, cantidad: 10 }]);
  check("cerrar un pedido sin recepciones 409 (se cancela)", (await pedir(`/api/local/pedidos/${solCierre.id_pedido}/cierre`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo_diferencia: "nunca llegó nada" } })).data.codigo === "TRANSICION_INVALIDA");
  await recibir(solCierre.id_pedido, { lineas: [lineaRec(idA, 10, 10)] });
  check("cerrar con diferencia sin motivo 400", (await pedir(`/api/local/pedidos/${solCierre.id_pedido}/cierre`, { method: "POST", token: adminTienda, key: nuevaKey(), body: {} })).status === 400);
  const cierreSolo = await pedir(`/api/local/pedidos/${solCierre.id_pedido}/cierre`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo_diferencia: "Proveedor sin existencias del resto" } });
  check("cerrar con diferencia y motivo 200", cierreSolo.status === 200 && cierreSolo.data.estado === "RECIBIDO_TOTAL" && cierreSolo.data.diferencias.length === 2, `${cierreSolo.status} ${cierreSolo.data.mensaje || ""}`);
  const faltas = (await local.query("select id_medicamento, diferencia, cantidad_recibida, id_recepcion from diferencia_recepcion where id_pedido = $1 order by id_medicamento", [solCierre.id_pedido])).rows;
  check("faltante de 15 en A y de 10 en B, sin recepción asociada", faltas.length === 2 && faltas[0].diferencia === -15 && faltas[0].cantidad_recibida === 10 && faltas[1].diferencia === -10 && faltas.every((f) => f.id_recepcion === null));
  check("cerrar dos veces 409", (await pedir(`/api/local/pedidos/${solCierre.id_pedido}/cierre`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo_diferencia: "otra vez" } })).status === 409);
  check("auditoría del cierre con responsable", (await contar(local, "select count(*) as n from registro_actividad where accion = 'PEDIDO_CERRAR_DIFERENCIA' and id_entidad_afectada = $1 and id_empleado = $2", [solCierre.id_pedido, idAdmin])) === 1);

  // --- Sin conexión con el central la recepción funciona igual (RNF-04)
  const solOffline = await solicitud([{ id_medicamento: idA, cantidad: 9 }]);
  link.estado = "offline";
  const offline = await recibir(solOffline.id_pedido, { lineas: [lineaRec(idA, 11, 9)] });
  check("sin central: la recepción se registra 200", offline.status === 200 && offline.data.estado === "RECIBIDO_TOTAL", `${offline.status} ${offline.data.mensaje || ""}`);
  check("sin central: el historial se consulta", (await pedir(`/api/local/solicitudes/${solOffline.id_pedido}/recepciones`, { token: adminTienda })).data.recepciones.length === 1);
  link.estado = "online";
} finally {
  link.estado = "online";
  await desactivarMedicamentos("id_medicamento = any($1::int[])", [[idA, idB]]);
  await local.query("update medicamento_ref set activo = false where id_medicamento = any($1::int[])", [[idA, idB]]);
  if (proveedoresCreados.length) {
    await desactivarProveedores("id_proveedor = any($1::int[])", [proveedoresCreados]);
    await local.query("update proveedor_ref set activo = false where id_proveedor = any($1::int[])", [proveedoresCreados]);
    await local.query(
      "update pedido set estado = 'CANCELADO', observaciones = 'limpieza de la prueba HU-14' where id_proveedor = any($1::int[]) and estado in ('SOLICITADO', 'ENVIADO')",
      [proveedoresCreados],
    );
  }
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
