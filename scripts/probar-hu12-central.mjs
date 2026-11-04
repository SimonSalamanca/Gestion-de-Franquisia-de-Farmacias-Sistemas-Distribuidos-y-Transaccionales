// Pruebas de HU-12 (validación de la receta contra el nodo central, simulación de la EPS): emisión, validación por
// código, reserva, competencia entre tiendas, liberación, baja por el outbox, conflictos y comportamiento sin conexión.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las recetas emitidas de prueba son permanentes (auditoría); las facturas viven en
// transacciones que se revierten. La segunda tienda es "Farmacia Norte" (id 2), simulada desde el central.
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
const { reservarEnCentral, liberarEnCentral, aplicarBajaReceta } = await import("../apps/api/recetas-red.mjs");

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
const fechaRelativa = async (dias) => (await local.query("select (current_date + $1::int)::text as f", [dias])).rows[0].f;
const S = Date.now().toString(36).toUpperCase();
const TIENDA = 1;
const OTRA = 2;

const idDe = async (codigo) => (await local.query("select id_medicamento from medicamento_ref where codigo_interno = $1", [codigo])).rows[0]?.id_medicamento;
const idAmoxi = await idDe("MED-004");
const idLosartan = await idDe("MED-006");
const idLibre = await idDe("MED-001");
const loteAmoxi = (await local.query("select id_lote from lote where id_medicamento = $1 order by id_lote limit 1", [idAmoxi])).rows[0]?.id_lote;
if (!idAmoxi || !idLosartan || !idLibre || !loteAmoxi) {
  console.error("Faltan los datos demo (SEED_DEMO=1): MED-001, MED-004, MED-006 y un lote de MED-004");
  process.exit(2);
}
const estadoCentral = async (codigo) => (await central.query("select estado, id_tienda_reserva, id_tienda_reclamo from receta_emitida where codigo = $1", [codigo])).rows[0];
const reservar = (idTienda, codigo) => withTx(central, (c) => reservarEnCentral(c, { idTienda, idEmpleado: null, codigo }));
const intentar = async (promesa) => {
  try {
    return { ok: true, valor: await promesa };
  } catch (error) {
    return { ok: false, codigo: error.codigo, status: error.status };
  }
};
const eventoBaja = (codigo, extra = {}) => ({
  idempotency_key: crypto.randomUUID(),
  tipo_evento: "RECETA_DISPENSADA",
  payload: { codigo, id_medicamento: idAmoxi, cantidad: 1, id_factura: 1, dispensado_en: new Date().toISOString(), ...extra },
});
const aplicarBaja = (idTienda, evento) => withTx(central, (c) => aplicarBajaReceta(c, idTienda, evento));

try {
  const general = await entrar("central", "admin.general");
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  check("logins demo", Boolean(general && cajero && adminTienda));
  const hoy = await fechaRelativa(0);

  // --- Emisión simulada (consola central)
  const emitir = (cuerpo, opciones = {}) => pedir("/api/central/recetas-emitidas", { method: "POST", token: general, key: nuevaKey(), body: cuerpo, ...opciones });
  const cuerpoBase = (n, extra = {}) => ({
    codigo: `HU12T-${S}-${n}`,
    paciente_nombre: `Paciente Central ${S}-${n}`,
    paciente_documento: `HC${S}${n}`,
    medico_prescriptor: `Dr. Central ${S}`,
    fecha_emision: hoy,
    medicamentos: [{ id_medicamento: idAmoxi, cantidad: 2 }, { id_medicamento: idLosartan, cantidad: 30 }],
    ...extra,
  });
  check("sin sesión 401", (await pedir("/api/central/recetas-emitidas")).status === 401);
  check("un token del POS no sirve en la consola", [401, 403].includes((await pedir("/api/central/recetas-emitidas", { token: cajero })).status));
  check("sin Idempotency-Key 400", (await pedir("/api/central/recetas-emitidas", { method: "POST", token: general, body: cuerpoBase("X") })).status === 400);
  check("sin médico 400", (await emitir(cuerpoBase("X", { medico_prescriptor: "" }))).status === 400);
  check("documento inválido 400", (await emitir(cuerpoBase("X", { paciente_documento: "1 2" }))).status === 400);
  check("fecha futura 400", (await emitir(cuerpoBase("X", { fecha_emision: await fechaRelativa(2) }))).status === 400);
  const libre = await emitir(cuerpoBase("X", { medicamentos: [{ id_medicamento: idLibre, cantidad: 1 }] }));
  check("un medicamento sin receta obligatoria no se emite 400", libre.status === 400 && libre.data.codigo === "NO_REQUIERE_RECETA");
  check("ninguna validación dejó recetas", (await contar(central, "select count(*) as n from receta_emitida where codigo = $1", [`HU12T-${S}-X`])) === 0);

  const key = nuevaKey();
  const r1 = await emitir(cuerpoBase("1"), { key });
  check("el administrador general emite una receta 201", r1.status === 201 && r1.data.estado === "EMITIDA" && r1.data.codigo === `HU12T-${S}-1`, `${r1.status} ${r1.data.mensaje || ""}`);
  check("la respuesta enmascara el documento", r1.data.paciente_documento === `****${`HC${S}1`.slice(-4)}`);
  const repetida = await emitir(cuerpoBase("1"), { key });
  check("reintento con la misma clave: misma receta", repetida.status === 201 && repetida.data.id_receta_emitida === r1.data.id_receta_emitida);
  check("el mismo código con otra clave 409", (await emitir(cuerpoBase("1"))).data.codigo === "CODIGO_DUPLICADO");
  const generada = await emitir({ ...cuerpoBase("G"), codigo: "" });
  check("sin código, el central genera uno RX-", generada.status === 201 && /^RX-\d{10}$/.test(generada.data.codigo));
  for (const n of ["2", "3", "4", "5", "6", "7"]) await emitir(cuerpoBase(n));
  const vencida = await emitir(cuerpoBase("V", { fecha_emision: await fechaRelativa(-45) }));
  check("se puede emitir una receta ya vencida (para probar el rechazo)", vencida.status === 201);
  const listado = await pedir(`/api/central/recetas-emitidas?q=HU12T-${S}`, { token: general });
  check("listado de recetas emitidas con documento enmascarado", listado.status === 200 && listado.data.recetas.length >= 8 && listado.data.recetas.every((r) => r.paciente_documento.startsWith("****")));
  check("filtro por estado", (await pedir(`/api/central/recetas-emitidas?estado=ANULADA&q=HU12T-${S}`, { token: general })).data.recetas.length === 0);
  check("las recetas demo están en el central", (await contar(central, "select count(*) as n from receta_emitida where codigo like 'RX-DEMO-%'")) >= 3);

  // --- Validación por código desde el POS
  const validar = (codigo, token = cajero) => pedir("/api/local/recetas/codigo", { method: "POST", token, body: { codigo } });
  check("sin sesión 401 al validar", (await pedir("/api/local/recetas/codigo", { method: "POST", body: { codigo: "ABCD" } })).status === 401);
  check("código con formato inválido 400", (await validar("a b")).status === 400);
  const desconocida = await validar(`NOEXISTE-${S}`);
  check("código inexistente 404 RECETA_NO_ENCONTRADA", desconocida.status === 404 && desconocida.data.codigo === "RECETA_NO_ENCONTRADA");
  const venc = await validar(`HU12T-${S}-V`);
  check("receta vencida 409 RECETA_VENCIDA", venc.status === 409 && venc.data.codigo === "RECETA_VENCIDA");
  check("la vencida no quedó reservada", (await estadoCentral(`HU12T-${S}-V`)).estado === "EMITIDA");
  const politica = await pedir("/api/local/recetas/politica", { token: cajero });
  check("política: registro manual apagado y 30 días", politica.status === 200 && politica.data.registro_manual === false && politica.data.dias_vigencia === 30);
  const manual = await pedir("/api/local/recetas", { method: "POST", token: cajero, key: nuevaKey(), body: { medico_prescriptor: "Dr. X", fecha_emision: hoy, cliente: { nombre: "Ana", documento_identidad: "12345678" }, medicamentos: [{ id_medicamento: idAmoxi, cantidad: 1 }] } });
  check("el registro manual está desactivado 409", manual.status === 409 && manual.data.codigo === "REGISTRO_MANUAL_DESACTIVADO");

  const codigo1 = `HU12T-${S}-1`;
  const ok1 = await validar(codigo1);
  check("receta válida: se valida y se reserva 200", ok1.status === 200 && ok1.data.origen === "CENTRAL" && ok1.data.codigo_receta === codigo1, `${ok1.status} ${ok1.data.mensaje || ""}`);
  check("la copia local trae médico, fecha y medicamentos", ok1.data.medico_prescriptor === `Dr. Central ${S}` && ok1.data.fecha_emision === hoy && ok1.data.medicamentos.length === 2);
  check("la copia local enmascara el documento y queda utilizable", ok1.data.paciente_documento.startsWith("****") && ok1.data.utilizable === true && ok1.data.reserva_vigente === true);
  const estado1 = await estadoCentral(codigo1);
  check("en el central queda RESERVADA para esta tienda", estado1.estado === "RESERVADA" && estado1.id_tienda_reserva === TIENDA);
  const otraVez = await validar(codigo1);
  check("validar otra vez renueva la reserva sin duplicar la receta local", otraVez.status === 200 && otraVez.data.id_receta === ok1.data.id_receta && (await contar(local, "select count(*) as n from receta where codigo_receta = $1", [codigo1])) === 1);
  check("RECETA_VALIDAR_CENTRAL auditada en la tienda sin datos del paciente", (await local.query("select detalle from registro_actividad where accion = 'RECETA_VALIDAR_CENTRAL' and id_entidad_afectada = $1", [ok1.data.id_receta])).rows.every((f) => f.detalle.includes(codigo1) && !f.detalle.includes(`HC${S}1`)));
  check("RECETA_RESERVAR auditada en el central", (await contar(central, "select count(*) as n from registro_actividad_central where accion = 'RECETA_RESERVAR' and detalle like $1", [`%${codigo1}%`])) >= 1);

  // --- Validación anticipada de la venta con la receta del central
  const evaluar = (cuerpo) => pedir("/api/local/recetas/validar", { method: "POST", token: cajero, body: cuerpo });
  const ev = await evaluar({ id_receta: ok1.data.id_receta, lineas: [{ id_medicamento: idAmoxi, cantidad: 2 }] });
  check("la venta puede continuar con la receta reservada", ev.data.puede_continuar === true);

  // --- Competencia entre tiendas
  const codigo3 = `HU12T-${S}-3`;
  const carrera = await Promise.all([intentar(reservar(TIENDA, codigo3)), intentar(reservar(OTRA, codigo3))]);
  const ganadoras = carrera.filter((r) => r.ok).length;
  const perdedora = carrera.find((r) => !r.ok);
  check("dos tiendas a la vez: solo una la reserva", ganadoras === 1 && perdedora?.codigo === "RECETA_RESERVADA_OTRA_TIENDA", JSON.stringify(carrera.map((r) => r.codigo || "ok")));
  const duenia = (await estadoCentral(codigo3)).id_tienda_reserva;
  check("el central registra una sola dueña de la reserva", [TIENDA, OTRA].includes(duenia));
  const oponente = duenia === TIENDA ? OTRA : TIENDA;
  const liberarOtra = await intentar(withTx(central, (c) => liberarEnCentral(c, { idTienda: oponente, idEmpleado: null, codigo: codigo3 })));
  check("una tienda no puede liberar la reserva de otra", !liberarOtra.ok && liberarOtra.codigo === "RECETA_RESERVADA_OTRA_TIENDA");
  const noPisa = await validar(codigo1, cajero);
  check("la receta ya validada por esta tienda sigue funcionando", noPisa.status === 200);
  const deOtra = await intentar(reservar(OTRA, codigo1));
  check("la otra tienda no puede usar una receta reservada por esta", !deOtra.ok && deOtra.codigo === "RECETA_RESERVADA_OTRA_TIENDA");

  // --- Reserva vencida: la otra tienda puede tomarla
  const codigo4 = `HU12T-${S}-4`;
  await validar(codigo4);
  await central.query("update receta_emitida set reservada_hasta = now()::timestamp - interval '1 minute' where codigo = $1", [codigo4]);
  const tomada = await intentar(reservar(OTRA, codigo4));
  check("con la reserva vencida, otra tienda la toma", tomada.ok && (await estadoCentral(codigo4)).id_tienda_reserva === OTRA);
  const perdida = await validar(codigo4);
  check("y esta tienda ya no puede validarla 409", perdida.status === 409 && perdida.data.codigo === "RECETA_RESERVADA_OTRA_TIENDA");

  // --- Liberar
  const codigo2 = `HU12T-${S}-2`;
  const v2 = await validar(codigo2);
  const lib = await pedir(`/api/local/recetas/${v2.data.id_receta}/liberar`, { method: "POST", token: cajero });
  check("liberar la reserva 200", lib.status === 200 && lib.data.utilizable === false && lib.data.reserva_vigente === false);
  check("en el central vuelve a EMITIDA", (await estadoCentral(codigo2)).estado === "EMITIDA");
  check("liberar de nuevo no falla (idempotente)", (await pedir(`/api/local/recetas/${v2.data.id_receta}/liberar`, { method: "POST", token: cajero })).status === 200);
  const tomaOtra = await intentar(reservar(OTRA, codigo2));
  check("liberada, otra tienda puede reservarla", tomaOtra.ok);
  await withTx(central, (c) => liberarEnCentral(c, { idTienda: OTRA, idEmpleado: null, codigo: codigo2 }));
  check("liberar una receta inexistente 404", (await pedir("/api/local/recetas/99999999/liberar", { method: "POST", token: cajero })).status === 404);

  // --- La base: la venta con receta del central (transacciones que se revierten)
  const empleado = (await local.query("select id_empleado from empleado_ref where usuario = 'cajero1'")).rows[0].id_empleado;
  const clienteDe = async (id) => (await local.query("select id_cliente from receta where id_receta = $1", [id])).rows[0].id_cliente;
  const idReceta1 = ok1.data.id_receta;
  const cliente1 = await clienteDe(idReceta1);
  const colaAntes = await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'RECETA_DISPENSADA'");
  let payloadBaja = null;
  const client = await local.connect();
  try {
    await client.query("begin");
    const factura = async (idCliente, sufijo) =>
      (await client.query(
        `insert into factura (numero_factura, id_cliente, id_empleado, subtotal, impuestos, total) values ($1, $2, $3, 100, 0, 100) returning id_factura`,
        [`HU12C-${S}-${sufijo}`, idCliente, empleado],
      )).rows[0].id_factura;
    const linea = async (idFactura, cantidad, idReceta) => {
      await client.query("savepoint s");
      try {
        await client.query(
          "insert into detalle_factura (id_factura, id_lote, id_receta, cantidad, precio_unitario_aplicado, subtotal_linea) values ($1, $2, $3, $4, 10, $4 * 10)",
          [idFactura, loteAmoxi, idReceta, cantidad],
        );
        await client.query("release savepoint s");
        return { ok: true };
      } catch (error) {
        await client.query("rollback to savepoint s");
        return { ok: false, code: error.code, message: error.message };
      }
    };
    const f1 = await factura(cliente1, "1");
    check("con la reserva vigente, la línea se acepta", (await linea(f1, 2, idReceta1)).ok);
    const evento = (await client.query("select payload from outbox_sync where tipo_evento = 'RECETA_DISPENSADA' order by id_outbox desc limit 1")).rows[0];
    payloadBaja = evento?.payload;
    check("la línea encola la baja RECETA_DISPENSADA con el código", payloadBaja?.codigo === codigo1 && payloadBaja?.cantidad === 2);
    const f2 = await factura(cliente1, "2");
    const segunda = await linea(f2, 1, idReceta1);
    check("la primera dispensación quema la receta: otra factura se rechaza", !segunda.ok && segunda.message.startsWith("RECETA_RECLAMADA"), segunda.message);
    await client.query("rollback");

    await client.query("begin");
    const f3 = await factura(cliente1, "3");
    await client.query("update receta set reservada_hasta = now()::timestamp - interval '1 minute' where id_receta = $1", [idReceta1]);
    const vencidaReserva = await linea(f3, 1, idReceta1);
    check("con la reserva terminada, la base rechaza la línea", !vencidaReserva.ok && vencidaReserva.message.startsWith("RECETA_RESERVA_VENCIDA"), vencidaReserva.message);
    await client.query("rollback");

    await client.query("begin");
    const manualId = (await client.query(
      "insert into receta (medico_prescriptor, fecha_emision, id_cliente, id_empleado_registro) values ('Dr. Manual', current_date, $1, $2) returning id_receta",
      [cliente1, empleado],
    )).rows[0].id_receta;
    await client.query("insert into receta_medicamento (id_receta, id_medicamento, cantidad_autorizada) values ($1, $2, 5)", [manualId, idAmoxi]);
    const manualLinea = await linea(await factura(cliente1, "4"), 1, manualId);
    check("una receta manual no sirve para un controlado con la política apagada", !manualLinea.ok && manualLinea.message.startsWith("RECETA_MANUAL_NO_PERMITIDA"), manualLinea.message);
    await client.query("rollback");
  } finally {
    client.release();
  }
  check("al revertirse la venta, la baja no queda en el outbox", (await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'RECETA_DISPENSADA'")) === colaAntes);

  // --- La baja por el outbox (camino real de sincronización)
  await local.query(
    "insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload) values (null, $1, 'RECETA_DISPENSADA', $2::jsonb)",
    [crypto.randomUUID(), JSON.stringify({ ...payloadBaja, dispensado_en: new Date().toISOString() })],
  );
  const envio = await flushOutbox(TIENDA);
  check("el ciclo del outbox envía la baja", envio.sent >= 1);
  const tras = await estadoCentral(codigo1);
  check("el central da de baja la receta: RECLAMADA por esta tienda", tras.estado === "RECLAMADA" && tras.id_tienda_reclamo === TIENDA);
  check("el outbox marca la baja como ENVIADO", (await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'RECETA_DISPENSADA' and estado in ('PENDIENTE', 'ERROR')")) === 0);
  check("RECETA_RECLAMAR auditada en el central", (await contar(central, "select count(*) as n from registro_actividad_central where accion = 'RECETA_RECLAMAR' and detalle like $1", [`%${codigo1}%`])) === 1);

  // --- Duplicados y conflictos de la baja
  const conflictos = (codigo) => contar(central, "select count(*) as n from receta_conflicto where codigo = $1", [codigo]);
  const ev1 = eventoBaja(codigo1);
  await aplicarBaja(TIENDA, ev1);
  await aplicarBaja(TIENDA, ev1);
  check("la baja repetida de la misma tienda no crea conflicto", (await conflictos(codigo1)) === 0 && (await estadoCentral(codigo1)).estado === "RECLAMADA");
  await aplicarBaja(OTRA, eventoBaja(codigo1));
  const conf = await central.query("select motivo, id_tienda_origen from receta_conflicto where codigo = $1", [codigo1]);
  check("la baja de otra tienda sobre una receta reclamada va a la cola de conflicto", conf.rowCount === 1 && conf.rows[0].motivo === `YA_RECLAMADA_EN_TIENDA_${TIENDA}` && conf.rows[0].id_tienda_origen === OTRA);
  check("y la receta sigue reclamada por la primera tienda", (await estadoCentral(codigo1)).id_tienda_reclamo === TIENDA);
  await aplicarBaja(TIENDA, eventoBaja(`NOEXISTE-${S}`));
  check("una baja con código desconocido queda en la cola de conflicto", (await conflictos(`NOEXISTE-${S}`)) === 1);
  const reclamo = await validar(codigo1);
  check("validar una receta reclamada 409 RECETA_RECLAMADA con la tienda", reclamo.status === 409 && reclamo.data.codigo === "RECETA_RECLAMADA" && reclamo.data.tienda === "Farmacia Centro", JSON.stringify(reclamo.data));
  const reclamoOtra = await intentar(reservar(OTRA, codigo1));
  check("ninguna tienda puede reservar una receta reclamada", !reclamoOtra.ok && reclamoOtra.codigo === "RECETA_RECLAMADA");
  const codigo5 = `HU12T-${S}-5`;
  await reservar(OTRA, codigo5);
  await aplicarBaja(TIENDA, eventoBaja(codigo5));
  const pisada = await central.query("select motivo from receta_conflicto where codigo = $1", [codigo5]);
  check("una baja sobre una reserva ajena activa gana y deja aviso", (await estadoCentral(codigo5)).id_tienda_reclamo === TIENDA && pisada.rows[0]?.motivo === `RESERVA_ACTIVA_DE_TIENDA_${OTRA}`);

  // --- Sin conexión con el central (opción A)
  const codigo6 = `HU12T-${S}-6`;
  const codigo7 = `HU12T-${S}-7`;
  const v6 = await validar(codigo6);
  link.estado = "offline";
  const sinRed = await validar(codigo7);
  check("sin central: un controlado nuevo no se valida 503 SIN_CONEXION", sinRed.status === 503 && sinRed.data.codigo === "SIN_CONEXION");
  check("sin central: no se creó copia local ni reserva", (await contar(local, "select count(*) as n from receta where codigo_receta = $1", [codigo7])) === 0 && (await estadoCentral(codigo7)).estado === "EMITIDA");
  const libreOffline = await evaluar({ lineas: [{ id_medicamento: idLibre, cantidad: 2 }] });
  check("sin central: el medicamento de venta libre sigue (autonomía local)", libreOffline.status === 200 && libreOffline.data.puede_continuar === true);
  const yaReservada = await evaluar({ id_receta: v6.data.id_receta, lineas: [{ id_medicamento: idAmoxi, cantidad: 2 }] });
  check("sin central: la receta ya reservada sigue valiendo mientras dura su reserva", yaReservada.data.puede_continuar === true);
  check("sin central: no se puede liberar una reserva 503", (await pedir(`/api/local/recetas/${v6.data.id_receta}/liberar`, { method: "POST", token: cajero })).status === 503);
  check("sin central: la consola no emite 503", (await emitir(cuerpoBase("O"))).status === 503);
  link.estado = "online";
  await withTx(central, (c) => liberarEnCentral(c, { idTienda: TIENDA, idEmpleado: null, codigo: codigo6 })).catch(() => {});
  check("reconectado, el controlado se valida", (await validar(codigo7)).status === 200);

  // --- Auditoría del central
  const acciones = (await central.query("select distinct accion from registro_actividad_central where detalle like $1 or detalle like $2", [`%HU12T-${S}%`, `%${S}%`])).rows.map((r) => r.accion);
  check("el central audita emisión, reserva, liberación y baja", ["RECETA_EMITIR", "RECETA_RESERVAR", "RECETA_LIBERAR", "RECETA_RECLAMAR"].every((a) => acciones.includes(a)), acciones.join(","));
} finally {
  link.estado = "online";
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
