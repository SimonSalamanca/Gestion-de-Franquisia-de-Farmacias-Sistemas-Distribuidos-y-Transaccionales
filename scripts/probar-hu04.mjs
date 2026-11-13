import "./lib/owner.mjs";
import { crearMedicamentoHeredado, crearMedicamentoPrueba, desactivarMedicamentos, intentarCrearSinUmbral, registrarPrecioCentral } from "./lib/central.mjs";
// Pruebas de HU-04 por las rutas reales de app.mjs: alertas de stock bajo y de caducidad, bloqueo automático de lotes
// vencidos, panel ordenado por urgencia, umbrales independientes por producto y por tienda, y la regla de que ningún
// producto activo opera sin umbral.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Cada corrida crea sus propios medicamentos y lotes; los medicamentos de prueba quedan
// inactivos al final.
import crypto from "crypto";
import { execFileSync } from "child_process";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { evaluarAlertas } = await import("../apps/api/alertas.mjs");

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
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);
const S = Date.now().toString(36).toUpperCase();
const TIENDA = 1;

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}

// Medicamento de prueba con su umbral en cada tienda activa, creado en la misma transacción (la regla de HU-04).
async function crearMedicamento(sufijo, { precio = null } = {}) {
  const idMed = await crearMedicamentoPrueba({ codigo: `HU04-${S}-${sufijo}`, nombre: `Prueba Alertas ${S}-${sufijo}`, principio: "prueba de alertas" });
  if (precio != null) {
    await registrarPrecioCentral({ idMedicamento: idMed, precio: precio });
  }
  return idMed;
}
async function crearLote(idMed, sufijo, { cantidad, dias, estado = "DISPONIBLE" }) {
  return (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + $4::int, $5, $5, $6) returning id_lote`,
    [idMed, proveedor, `A-${S}-${sufijo}`, dias, cantidad, estado],
  )).rows[0].id_lote;
}
const fijarLote = (idLote, cantidad, estado = "DISPONIBLE") => local.query("update lote set cantidad_disponible = $2, estado = $3 where id_lote = $1", [idLote, cantidad, estado]);
const activas = async (idMed) => (await local.query("select tipo, nivel, id_lote, detalle, vista_en from alerta where id_medicamento = $1 and estado = 'ACTIVA' order by tipo, id_lote", [idMed])).rows;
const tipos = (filas) => filas.map((f) => `${f.tipo}:${f.nivel}`).join(",");

// --- Medicamentos de la corrida
const idX = await crearMedicamento("X"); // stock bajo
const idY = await crearMedicamento("Y"); // caducidad
const idV = await crearMedicamento("V", { precio: "1000.00" }); // lote vencido (con precio, para intentar venderlo)
const idQ = await crearMedicamento("Q"); // sin umbral en la tienda (simulado)
const idL = await crearMedicamento("L", { precio: "1000.00" }); // lote bloqueado mientras una venta lo tiene
await migrate();
await pullReplica();

try {
  const general = await entrar("central", "admin.general");
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  check("logins demo", Boolean(general && cajero && adminTienda));

  // --- La regla: ningún producto activo opera sin umbral en una tienda activa
  const sinUmbral = await intentarCrearSinUmbral({ tipo: "medicamento", codigo: `HU04-${S}-N`, nombre: `Prueba Sin Umbral ${S}` });
  check("un medicamento activo sin umbral no se puede crear (MEDICAMENTO_SIN_UMBRAL)", !sinUmbral.ok && sinUmbral.code === "23514" && sinUmbral.message.startsWith("MEDICAMENTO_SIN_UMBRAL"), sinUmbral.message);
  check("y no quedó guardado", (await contar(central, "select count(*) as n from medicamento where codigo_interno = $1", [`HU04-${S}-N`])) === 0);
  const tiendaSin = await intentarCrearSinUmbral({ tipo: "tienda", nombre: `HU04 Sin Umbrales ${S}` });
  check("una tienda activa sin umbrales no se puede crear (TIENDA_SIN_UMBRALES)", !tiendaSin.ok && tiendaSin.message.startsWith("TIENDA_SIN_UMBRALES"), tiendaSin.message);
  check("la herramienta de depuración no encuentra productos sin umbral", execFileSync(process.execPath, ["scripts/depurar-umbrales.mjs"], { encoding: "utf8", env: process.env }).includes("Todos los medicamentos activos tienen umbral"));

  // Datos heredados que no cumplen la regla (se simulan apagando la restricción un instante): se listan y se dan de baja.
  async function heredado(sufijo, { unidades = 0 } = {}) {
    return crearMedicamentoHeredado({ codigo: `HU04-${S}-${sufijo}`, nombre: `Prueba Heredado ${S} ${sufijo}`, unidadesEnRed: unidades, idTienda: TIENDA });
  }
  const idH0 = await heredado("H0");
  const idH1 = await heredado("H1", { unidades: 12 });
  const listado = execFileSync(process.execPath, ["scripts/depurar-umbrales.mjs"], { encoding: "utf8", env: process.env });
  check("la herramienta lista los productos sin umbral y no cambia nada", listado.includes(`HU04-${S}-H0`) && listado.includes(`HU04-${S}-H1`) && (await contar(central, "select count(*) as n from medicamento where id_medicamento = any($1::int[]) and activo", [[idH0, idH1]])) === 2);
  const aplicado = execFileSync(process.execPath, ["scripts/depurar-umbrales.mjs", "--aplicar"], { encoding: "utf8", env: process.env });
  const estados = Object.fromEntries((await central.query("select id_medicamento, activo from medicamento where id_medicamento = any($1::int[])", [[idH0, idH1]])).rows.map((r) => [r.id_medicamento, r.activo]));
  check("--aplicar da de baja al que no tiene unidades y respeta al que sí", estados[idH0] === false && estados[idH1] === true, aplicado.split("\n").slice(-3).join(" "));
  const incluir = execFileSync(process.execPath, ["scripts/depurar-umbrales.mjs", "--aplicar", "--incluir-con-stock"], { encoding: "utf8", env: process.env });
  check("--incluir-con-stock da de baja también al que tiene unidades", (await contar(central, "select count(*) as n from medicamento where id_medicamento = $1 and activo", [idH1])) === 0, incluir.split("\n").slice(-2).join(" "));
  check("la baja es lógica (el producto sigue en la base) y queda auditada", (await contar(central, "select count(*) as n from medicamento where id_medicamento = any($1::int[])", [[idH0, idH1]])) === 2 && (await contar(central, "select count(*) as n from registro_actividad_central where accion = 'MEDICAMENTO_BAJA_SIN_UMBRAL' and id_entidad_afectada = any($1::int[])", [[idH0, idH1]])) === 2);
  check("la baja se publicó a las tiendas", (await contar(central, "select count(*) as n from replica_evento where tipo_evento = 'MEDICAMENTO_UPSERT' and (payload ->> 'id_medicamento')::int = any($1::int[]) and payload ->> 'activo' = 'false'", [[idH0, idH1]])) === 2);

  // --- Configuración independiente por producto y por tienda (criterio 5): HU-15 en el central, réplica a la tienda
  const poner = (idTienda, idMed, minimo, dias) =>
    pedir(`/api/central/tiendas/${idTienda}/umbrales`, { method: "PUT", token: general, key: crypto.randomUUID(), body: { id_medicamento: idMed, stock_minimo: minimo, dias_alerta_caducidad: dias } });
  check("el administrador general configura el umbral de X en esta tienda (mínimo 10, aviso 30)", (await poner(TIENDA, idX, 10, 30)).status === 200);
  check("y el de Y (mínimo 0, aviso 10)", (await poner(TIENDA, idY, 0, 10)).status === 200);
  const otraTienda = (await central.query("select id_tienda from tienda where id_tienda <> $1 and activa order by id_tienda limit 1", [TIENDA])).rows[0]?.id_tienda;
  check("hay una segunda tienda en la red", Boolean(otraTienda));
  check("X en la otra tienda tiene su propio umbral (mínimo 500)", (await poner(otraTienda, idX, 500, 3)).status === 200);
  await pullReplica();
  const ref = async (idMed) => (await local.query("select stock_minimo, dias_alerta_caducidad from umbral_stock_ref where id_medicamento = $1", [idMed])).rows[0];
  check("la tienda recibió su umbral y no el de la otra tienda", JSON.stringify(await ref(idX)) === JSON.stringify({ stock_minimo: 10, dias_alerta_caducidad: 30 }), JSON.stringify(await ref(idX)));

  // --- Stock bajo (criterio 1): el mínimo se compara contra el stock vendible
  const loteX = await crearLote(idX, "X1", { cantidad: 30, dias: 300 });
  const r0 = await evaluarAlertas();
  check("la evaluación responde con el resumen", typeof r0.nuevas === "number" && typeof r0.resueltas === "number");
  check("stock por encima del mínimo: sin alerta de stock", (await activas(idX)).length === 0);
  await fijarLote(loteX, 11);
  await evaluarAlertas();
  check("un producto por encima del mínimo por poco sigue sin alerta", (await activas(idX)).length === 0);
  await fijarLote(loteX, 10);
  await evaluarAlertas();
  check("en el umbral exacto (10 de 10) hay alerta STOCK_BAJO nivel MEDIA", tipos(await activas(idX)) === "STOCK_BAJO:MEDIA");
  const idAlertaBaja = (await local.query("select id_alerta from alerta where id_medicamento = $1 and estado = 'ACTIVA'", [idX])).rows[0].id_alerta;
  await fijarLote(loteX, 5);
  await evaluarAlertas();
  const subio = await activas(idX);
  check("con la mitad del mínimo la misma alerta sube a ALTA (no se duplica)", tipos(subio) === "STOCK_BAJO:ALTA" && subio.length === 1 && (await local.query("select id_alerta from alerta where id_medicamento = $1 and estado = 'ACTIVA'", [idX])).rows[0].id_alerta === idAlertaBaja);
  await fijarLote(loteX, 0, "AGOTADO");
  await evaluarAlertas();
  check("sin unidades: STOCK_AGOTADO nivel CRITICA", tipos(await activas(idX)) === "STOCK_AGOTADO:CRITICA");
  check("la alerta de stock bajo anterior quedó resuelta (historial)", (await contar(local, "select count(*) as n from alerta where id_alerta = $1 and estado = 'RESUELTA' and resuelta_en is not null", [idAlertaBaja])) === 1);
  await fijarLote(loteX, 40);
  await evaluarAlertas();
  check("al reponer el stock la alerta se resuelve sola", (await activas(idX)).length === 0);
  check("un lote vencido no cuenta como stock vendible", await (async () => {
    const loteVx = await crearLote(idX, "XV", { cantidad: 100, dias: -2, estado: "BLOQUEADO" });
    await fijarLote(loteX, 8);
    await evaluarAlertas();
    const t = tipos(await activas(idX));
    await fijarLote(loteVx, 0, "AGOTADO");
    await fijarLote(loteX, 40);
    await evaluarAlertas();
    return t.includes("STOCK_BAJO") && t.includes("LOTE_VENCIDO");
  })());

  // --- Caducidad próxima (criterio 2) con periodo de aviso configurable
  const y5 = await crearLote(idY, "Y5", { cantidad: 4, dias: 5 });
  const y9 = await crearLote(idY, "Y9", { cantidad: 6, dias: 9 });
  const y12 = await crearLote(idY, "Y12", { cantidad: 8, dias: 12 });
  const y100 = await crearLote(idY, "Y100", { cantidad: 8, dias: 100 });
  await evaluarAlertas();
  const alY = await activas(idY);
  check("con aviso de 10 días: avisa el de 5 (ALTA) y el de 9 (MEDIA), no el de 12 ni el de 100", tipos(alY) === "CADUCIDAD_PROXIMA:ALTA,CADUCIDAD_PROXIMA:MEDIA" && alY.map((a) => a.id_lote).sort().join() === [y5, y9].sort().join(), tipos(alY));
  check("el detalle trae el lote, las unidades y los días", alY.find((a) => a.id_lote === y5).detalle.dias_restantes === 5 && alY.find((a) => a.id_lote === y5).detalle.cantidad === 4 && alY.find((a) => a.id_lote === y5).detalle.dias_aviso === 10);
  // El aviso se cambia sin tocar el stock mínimo (independientes).
  check("se cambia solo el periodo de aviso (a 15 días) y se conserva el mínimo", (await poner(TIENDA, idY, 0, 15)).status === 200);
  await pullReplica();
  await evaluarAlertas();
  check("con aviso de 15 días también avisa el de 12", (await activas(idY)).length === 3 && (await ref(idY)).stock_minimo === 0);
  check("se cambia solo el mínimo (a 3) y se conserva el aviso", (await poner(TIENDA, idY, 3, 15)).status === 200);
  await pullReplica();
  await evaluarAlertas();
  const tras = await activas(idY);
  check("el cambio de mínimo no movió las alertas de caducidad y la de stock aparece por separado", tras.filter((a) => a.tipo === "CADUCIDAD_PROXIMA").length === 3 && (await ref(idY)).dias_alerta_caducidad === 15 && tras.every((a) => a.tipo !== "STOCK_BAJO"), tipos(tras));
  check("con un aviso más corto (3 días) se resuelven las que ya no aplican", (await poner(TIENDA, idY, 0, 3)).status === 200 && (await (async () => { await pullReplica(); await evaluarAlertas(); return (await activas(idY)).length === 0; })()));
  check("un lote que caduca hoy sigue vendible y no se bloquea", await (async () => {
    const hoy = await crearLote(idY, "Yhoy", { cantidad: 2, dias: 0 });
    await evaluarAlertas();
    return (await local.query("select estado from lote where id_lote = $1", [hoy])).rows[0].estado === "DISPONIBLE";
  })());
  await poner(TIENDA, idY, 0, 30);
  await pullReplica();

  // --- Bloqueo automático de lotes vencidos (criterio 3)
  const loteV = await crearLote(idV, "V1", { cantidad: 7, dias: -1 });
  const snapshotsAntes = await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'STOCK_SNAPSHOT'");
  const bloqueoAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'LOTE_BLOQUEO_AUTOMATICO' and id_entidad_afectada = $1", [loteV]);
  const rb = await evaluarAlertas();
  check("la evaluación bloquea el lote vencido", rb.bloqueados >= 1 && (await local.query("select estado from lote where id_lote = $1", [loteV])).rows[0].estado === "BLOQUEADO");
  check("queda auditado con el sistema como actor", bloqueoAntes === 0 && (await contar(local, "select count(*) as n from registro_actividad where accion = 'LOTE_BLOQUEO_AUTOMATICO' and id_entidad_afectada = $1 and id_empleado is null", [loteV])) === 1);
  check("el nuevo stock se encola para el central", (await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'STOCK_SNAPSHOT'")) > snapshotsAntes);
  const alV = await activas(idV);
  check("alerta LOTE_VENCIDO nivel CRITICA con el lote y sus unidades", alV.some((a) => a.tipo === "LOTE_VENCIDO" && a.nivel === "CRITICA" && a.id_lote === loteV && a.detalle.cantidad === 7 && a.detalle.dias_vencido === 1), tipos(alV));
  const rb2 = await evaluarAlertas();
  check("repetir la evaluación no bloquea ni duplica nada", rb2.bloqueados === 0 && rb2.nuevas === 0 && (await activas(idV)).filter((a) => a.tipo === "LOTE_VENCIDO").length === 1);
  const calc = await pedir("/api/local/ventas/calcular", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idV, cantidad: 1 }] } });
  check("el lote bloqueado no se puede vender (sin stock vendible)", calc.status === 200 && calc.data.puede_vender === false && calc.data.problemas[0]?.codigo === "STOCK_INSUFICIENTE" && calc.data.problemas[0]?.disponible === 0);
  const intento = await pedir("/api/local/ventas", { method: "POST", token: cajero, key: crypto.randomUUID(), body: { lineas: [{ id_medicamento: idV, cantidad: 1 }], pagos: [{ id_metodo_pago: 1, monto: "1000.00" }] } });
  check("y una venta lo rechaza 409 STOCK_INSUFICIENTE", intento.status === 409 && intento.data.codigo === "STOCK_INSUFICIENTE");
  await fijarLote(loteV, 0, "AGOTADO");
  await evaluarAlertas();
  check("al darlo de baja (stock 0) la alerta se resuelve", (await activas(idV)).filter((a) => a.tipo === "LOTE_VENCIDO").length === 0);

  // --- Un lote que una venta tiene bloqueado no frena la evaluación ni se interbloquea con ella
  const loteL = await crearLote(idL, "L1", { cantidad: 3, dias: -1 });
  const venta = await local.connect();
  try {
    await venta.query("begin");
    await venta.query("select id_lote from lote where id_lote = $1 for update", [loteL]);
    const t0 = Date.now();
    const rc = await evaluarAlertas();
    const ms = Date.now() - t0;
    check("con el lote tomado por una venta la evaluación termina sin esperar", ms < 5000, `${ms} ms`);
    check("y lo deja para la siguiente pasada (sigue DISPONIBLE)", (await local.query("select estado from lote where id_lote = $1", [loteL])).rows[0].estado === "DISPONIBLE", JSON.stringify(rc));
    check("aun así lo avisa como vencido", (await activas(idL)).some((a) => a.tipo === "LOTE_VENCIDO"));
    await venta.query("rollback");
  } finally {
    venta.release();
  }
  await evaluarAlertas();
  check("liberado por la venta, la siguiente pasada lo bloquea", (await local.query("select estado from lote where id_lote = $1", [loteL])).rows[0].estado === "BLOQUEADO");

  // --- Evaluaciones simultáneas: sin alertas duplicadas
  const antesDup = await contar(local, "select count(*) as n from alerta where estado = 'ACTIVA'");
  await Promise.all(Array.from({ length: 6 }, () => evaluarAlertas()));
  const dups = await local.query("select tipo, id_medicamento, coalesce(id_lote, 0) as lote, count(*) as n from alerta where estado = 'ACTIVA' group by 1, 2, 3 having count(*) > 1");
  check("seis evaluaciones simultáneas no duplican alertas", dups.rowCount === 0 && (await contar(local, "select count(*) as n from alerta where estado = 'ACTIVA'")) === antesDup);

  // --- Producto sin umbral en esta tienda: el sistema lo avisa
  await local.query("delete from umbral_stock_ref where id_medicamento = $1", [idQ]);
  await evaluarAlertas();
  check("un producto activo sin umbral en la tienda genera SIN_UMBRAL (ALTA)", tipos(await activas(idQ)) === "SIN_UMBRAL:ALTA");
  await local.query("insert into umbral_stock_ref (id_medicamento, stock_minimo, dias_alerta_caducidad) values ($1, 0, 30)", [idQ]);
  await evaluarAlertas();
  check("al configurarlo la alerta SIN_UMBRAL se resuelve", !(await activas(idQ)).some((x) => x.tipo === "SIN_UMBRAL"));
  check("un lote de un producto sin umbral igual avisa su caducidad (aviso por defecto de 30 días)", await (async () => {
    await local.query("delete from umbral_stock_ref where id_medicamento = $1", [idQ]);
    const lq = await crearLote(idQ, "Q1", { cantidad: 5, dias: 20 });
    await evaluarAlertas();
    const t = (await activas(idQ)).some((a) => a.tipo === "CADUCIDAD_PROXIMA" && a.id_lote === lq);
    await local.query("insert into umbral_stock_ref (id_medicamento, stock_minimo, dias_alerta_caducidad) values ($1, 0, 30)", [idQ]);
    return t;
  })());

  // --- Panel único ordenado por urgencia (criterio 4)
  check("sin sesión 401", (await pedir("/api/local/alertas")).status === 401 && (await pedir("/api/local/alertas/resumen")).status === 401);
  const panel = await pedir("/api/local/alertas", { token: cajero });
  check("el cajero ve el panel (no hay permiso nuevo)", panel.status === 200 && panel.data.alertas.length > 0);
  const rango = { CRITICA: 0, ALTA: 1, MEDIA: 2 };
  const niveles = panel.data.alertas.map((a) => rango[a.nivel]);
  check("el panel está ordenado por nivel de urgencia", niveles.every((n, i) => i === 0 || niveles[i - 1] <= n), niveles.join(""));
  const vencidasEnPanel = panel.data.alertas.filter((a) => a.tipo === "LOTE_VENCIDO");
  check("las alertas críticas por lote vencido van antes que las menos urgentes", vencidasEnPanel.length > 0 && panel.data.alertas.findIndex((a) => a.tipo === "LOTE_VENCIDO") < panel.data.alertas.findIndex((a) => a.nivel === "MEDIA"));
  const caducan = panel.data.alertas.filter((a) => a.tipo === "CADUCIDAD_PROXIMA" && a.nivel === "ALTA").map((a) => a.detalle.dias_restantes);
  check("dentro de un nivel, lo que caduca antes va primero", caducan.every((d, i) => i === 0 || caducan[i - 1] <= d), caducan.join());
  check("el panel mezcla en una sola lista alertas de stock y de caducidad", new Set(panel.data.alertas.map((a) => a.tipo)).size >= 3);
  check("filtro por nivel", (await pedir("/api/local/alertas?nivel=CRITICA", { token: cajero })).data.alertas.every((a) => a.nivel === "CRITICA"));
  check("filtro por tipo", (await pedir("/api/local/alertas?tipo=SIN_UMBRAL", { token: cajero })).data.alertas.every((a) => a.tipo === "SIN_UMBRAL"));
  check("filtro inválido 400", (await pedir("/api/local/alertas?tipo=XX", { token: cajero })).status === 400 && (await pedir("/api/local/alertas?nivel=XX", { token: cajero })).status === 400);
  check("el historial de resueltas se consulta", (await pedir("/api/local/alertas?estado=RESUELTA", { token: cajero })).data.alertas.every((a) => a.estado === "RESUELTA"));
  const resumen = await pedir("/api/local/alertas/resumen", { token: cajero });
  const activasTotal = await contar(local, "select count(*) as n from alerta where estado = 'ACTIVA'");
  check("el resumen cuenta las activas por nivel", resumen.data.total === activasTotal && resumen.data.por_nivel.CRITICA.total + resumen.data.por_nivel.ALTA.total + resumen.data.por_nivel.MEDIA.total === activasTotal);
  const una = panel.data.alertas.find((a) => !a.vista_en);
  const sinVerAntes = resumen.data.sin_ver;
  const v1 = await pedir(`/api/local/alertas/${una.id_alerta}/vista`, { method: "POST", token: cajero });
  const v2 = await pedir(`/api/local/alertas/${una.id_alerta}/vista`, { method: "POST", token: adminTienda });
  check("marcar una alerta como vista; repetirlo (otro usuario) conserva la primera confirmación", v1.status === 200 && v2.status === 200 && JSON.stringify(v1.data.vista_en) === JSON.stringify(v2.data.vista_en));
  const quien = (await local.query("select e.usuario from alerta a join empleado_ref e on e.id_empleado = a.id_empleado_vista where a.id_alerta = $1", [una.id_alerta])).rows[0]?.usuario;
  check("queda quién la vio", quien === "cajero1", quien);
  check("el contador de sin ver baja en uno", (await pedir("/api/local/alertas/resumen", { token: cajero })).data.sin_ver === sinVerAntes - 1);
  check("alerta inexistente 404", (await pedir("/api/local/alertas/99999999/vista", { method: "POST", token: cajero })).status === 404);

  // --- Sin conexión con el central: las alertas siguen (RNF-04)
  link.estado = "offline";
  await local.query("update lote set cantidad_disponible = 2 where id_lote = $1", [loteX]);
  const off = await pedir("/api/local/alertas", { token: cajero });
  check("sin central: el panel responde y evalúa", off.status === 200 && off.data.alertas.some((a) => a.id_medicamento === idX && a.tipo === "STOCK_BAJO"));
  link.estado = "online";
  await fijarLote(loteX, 40);
} finally {
  link.estado = "online";
  await desactivarMedicamentos("codigo_interno like $1", [`HU04-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU04-${S}-%`]);
  await local.query("select evaluar_alertas()").catch(() => {});
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
