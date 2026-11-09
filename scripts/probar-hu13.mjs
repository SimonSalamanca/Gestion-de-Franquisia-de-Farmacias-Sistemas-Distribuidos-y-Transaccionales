// Pruebas de HU-13 por las rutas reales de app.mjs: permisos, registro de proveedores (central + réplica), solicitudes
// manuales y desde una alerta, proveedor obligatorio, estados (pendiente, enviada, recibida), concurrencia, idempotencia y
// comportamiento sin conexión con el central.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Cada corrida crea sus proveedores y su medicamento; al final quedan inactivos (los
// proveedores y las solicitudes referenciadas no se pueden borrar).
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
const nuevaKey = () => crypto.randomUUID();
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);
const S = Date.now().toString(36);

// Medicamento propio de esta corrida con umbral de 10 (HU-04: todo producto activo lleva umbral en cada tienda activa).
const codigo = `HU13-${S}`.toUpperCase();
const creado = await central.query(
  `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'prueba de reabastecimiento') returning id_medicamento),
        u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 10, 30 from tienda t cross join m where t.activa returning 1)
   select id_medicamento from m`,
  [codigo, `Prueba Reabastecimiento ${S}`],
);
const idMed = creado.rows[0].id_medicamento;
await migrate();
await pullReplica();

const proveedoresCreados = [];
try {
  const general = await entrar("central", "admin.general");
  const adminTienda = await entrar("local", "admin.tienda");
  const cajero = await entrar("local", "cajero1");
  check("logins demo", Boolean(general && adminTienda && cajero));

  // --- Permisos
  const tienePermiso = async (usuario) =>
    (await local.query(
      `select 1 from empleado_ref e join rol_permiso_ref rp on rp.id_rol = e.id_rol join permiso_ref p on p.id_permiso = rp.id_permiso
       where e.usuario = $1 and p.codigo = 'PROVEEDOR_GESTIONAR'`,
      [usuario],
    )).rowCount === 1;
  check("admin.tienda recibió PROVEEDOR_GESTIONAR por la réplica", await tienePermiso("admin.tienda"));
  check("el cajero no lo tiene", !(await tienePermiso("cajero1")));
  check("el módulo está en el catálogo", (await pedir("/api/modulos")).data.PROVEEDOR_GESTIONAR?.titulo === "Proveedores");
  check("sin sesión 401", (await pedir("/api/local/solicitudes")).status === 401);
  const negadosAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'PROVEEDOR_GESTIONAR'");
  check("el cajero no ve solicitudes 403", (await pedir("/api/local/solicitudes", { token: cajero })).status === 403);
  check("el cajero no genera solicitudes 403", (await pedir("/api/local/solicitudes", { method: "POST", token: cajero, key: nuevaKey(), body: {} })).status === 403);
  check("el cajero no registra proveedores 403", (await pedir("/api/local/proveedores", { method: "POST", token: cajero, key: nuevaKey(), body: {} })).status === 403);
  check("el cajero no ve el registro completo 403", (await pedir("/api/local/proveedores?detalle=1", { token: cajero })).status === 403);
  check("403 auditado en la tienda", (await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'PROVEEDOR_GESTIONAR'")) === negadosAntes + 4);

  // --- Criterio 1: registrar, editar y consultar proveedores
  const nit = `HU13-${S}`.toUpperCase();
  const datos = { nombre_empresa: `Proveedor Prueba ${S}`, nit, telefono: "6015550999", correo: "Ventas@Prueba.COM", direccion: "Calle 1 # 2-3" };
  check("sin Idempotency-Key 400", (await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, body: datos })).status === 400);
  for (const [nombre, malo] of [
    ["sin nombre", { ...datos, nombre_empresa: "" }],
    ["NIT corto", { ...datos, nit: "123" }],
    ["NIT con símbolos", { ...datos, nit: "12 34$56" }],
    ["correo mal escrito", { ...datos, correo: "no-es-correo" }],
    ["teléfono con letras", { ...datos, telefono: "abc" }],
  ]) {
    check(`registrar ${nombre} 400`, (await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key: nuevaKey(), body: malo })).status === 400);
  }
  const key = nuevaKey();
  const alta = await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key, body: datos });
  check("admin de tienda registra un proveedor 201", alta.status === 201 && alta.data.activo === true && alta.data.correo === "ventas@prueba.com", `${alta.status} ${alta.data.mensaje || ""}`);
  const idProv = alta.data.id_proveedor;
  proveedoresCreados.push(idProv);
  const repetido = await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key, body: datos });
  check("reintento con la misma clave: el mismo proveedor", repetido.status === 201 && repetido.data.id_proveedor === idProv);
  check("misma clave con otros datos 409", (await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key, body: { ...datos, nombre_empresa: "Otro" } })).status === 409);
  check("un solo proveedor tras los reintentos", (await contar(central, "select count(*) as n from proveedor where nit = $1", [nit])) === 1);
  const duplicado = await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key: nuevaKey(), body: { ...datos, nombre_empresa: "Otro nombre", nit: nit.toLowerCase() } });
  check("NIT repetido (aunque cambie la mayúscula) 409 NIT_DUPLICADO", duplicado.status === 409 && duplicado.data.codigo === "NIT_DUPLICADO");

  const concurrentes = await Promise.all(
    Array.from({ length: 4 }, (_, i) => pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key: nuevaKey(), body: { ...datos, nombre_empresa: `Carrera ${i}`, nit: `HU13C-${S}`.toUpperCase() } })),
  );
  const ganadores = concurrentes.filter((r) => r.status === 201);
  proveedoresCreados.push(...ganadores.map((r) => r.data.id_proveedor));
  check("cuatro altas simultáneas con el mismo NIT: una sola gana", ganadores.length === 1 && concurrentes.filter((r) => r.status === 409).length === 3);

  const desdeConsola = await pedir("/api/central/proveedores", { method: "POST", token: general, key: nuevaKey(), body: { nombre_empresa: `Consola ${S}`, nit: `HU13K-${S}`.toUpperCase() } });
  check("admin general registra desde la consola 201 (contacto opcional)", desdeConsola.status === 201 && desdeConsola.data.telefono === null);
  proveedoresCreados.push(desdeConsola.data.id_proveedor);

  const editado = await pedir(`/api/central/proveedores/${idProv}`, { method: "PATCH", token: general, key: nuevaKey(), body: { telefono: "6015551234", direccion: "" } });
  check("admin general edita 200 (solo los campos enviados)", editado.status === 200 && editado.data.telefono === "6015551234" && editado.data.direccion === null && editado.data.nombre_empresa === datos.nombre_empresa);
  check("editar sin campos 400", (await pedir(`/api/central/proveedores/${idProv}`, { method: "PATCH", token: general, key: nuevaKey(), body: {} })).status === 400);
  check("editar con el NIT de otro 409", (await pedir(`/api/central/proveedores/${idProv}`, { method: "PATCH", token: general, key: nuevaKey(), body: { nit: `HU13K-${S}`.toUpperCase() } })).status === 409);
  check("proveedor inexistente 404", (await pedir("/api/central/proveedores/99999999", { method: "PATCH", token: general, key: nuevaKey(), body: { telefono: "6015551234" } })).status === 404);

  await pullReplica();
  const enTienda = await local.query("select nombre_empresa, nit, telefono, correo, direccion, activo from proveedor_ref where id_proveedor = $1", [idProv]);
  check("la réplica trae NIT y contacto editado", enTienda.rows[0]?.nit === nit && enTienda.rows[0]?.telefono === "6015551234" && enTienda.rows[0]?.direccion === null);
  check("ningún proveedor de la tienda quedó sin NIT (los anteriores se republican)", (await contar(local, "select count(*) as n from proveedor_ref where nit is null")) === 0);
  const detalle = await pedir("/api/local/proveedores?detalle=1&q=" + encodeURIComponent(S), { token: adminTienda });
  check("el POS consulta el registro (por nombre o NIT)", detalle.status === 200 && detalle.data.proveedores.some((p) => p.id_proveedor === idProv && p.solicitudes_abiertas === 0));
  const legado = await pedir("/api/local/proveedores", { token: adminTienda });
  check("la lista de HU-02 sigue siendo un arreglo de activos", legado.status === 200 && Array.isArray(legado.data) && legado.data.some((p) => p.id_proveedor === idProv));
  const aud = (await central.query("select accion from registro_actividad_central where entidad_afectada = 'proveedor' and id_entidad_afectada = $1", [idProv])).rows.map((r) => r.accion);
  check("auditoría del central: alta y edición", aud.includes("PROVEEDOR_CREAR") && aud.includes("PROVEEDOR_EDITAR"), aud.join(","));

  // --- Criterio 4: sin proveedor no hay solicitud
  const ruta = "/api/local/solicitudes";
  const lineaMed = (cantidad) => [{ id_medicamento: idMed, cantidad }];
  const sinProveedor = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { lineas: lineaMed(5) } });
  check("sin proveedor 400 PROVEEDOR_OBLIGATORIO", sinProveedor.status === 400 && sinProveedor.data.codigo === "PROVEEDOR_OBLIGATORIO");
  check("proveedor inexistente 400", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: 99999999, lineas: lineaMed(5) } })).status === 400);
  check("sin Idempotency-Key 400", (await pedir(ruta, { method: "POST", token: adminTienda, body: { id_proveedor: idProv, lineas: lineaMed(5) } })).status === 400);
  const pedidosAntes = await contar(local, "select count(*) as n from pedido");
  check("sin líneas 400", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: [] } })).status === 400);
  for (const mala of [0, -3, 2.5, "abc", 1000000]) {
    check(`cantidad inválida (${mala}) 400`, (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: lineaMed(mala) } })).status === 400);
  }
  check("producto repetido 400", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: [...lineaMed(2), ...lineaMed(3)] } })).status === 400);
  check("medicamento inexistente 400", (await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: [{ id_medicamento: 99999999, cantidad: 1 }] } })).status === 400);
  check("nada se guardó con los rechazos", (await contar(local, "select count(*) as n from pedido")) === pedidosAntes);

  // --- Criterio 3: solicitud manual, sin alerta activa
  const medicamentos = await pedir(`${ruta}/medicamentos?q=${codigo}`, { token: adminTienda });
  check("búsqueda de medicamentos con stock y mínimo", medicamentos.status === 200 && medicamentos.data.medicamentos[0]?.id_medicamento === idMed && medicamentos.data.medicamentos[0].stock === 0 && medicamentos.data.medicamentos[0].stock_minimo === 10);
  const keyManual = nuevaKey();
  const manual = await pedir(ruta, { method: "POST", token: adminTienda, key: keyManual, body: { id_proveedor: idProv, observaciones: "urgente", lineas: lineaMed(40) } });
  check("solicitud manual 201 en estado pendiente", manual.status === 201 && manual.data.estado_visible === "PENDIENTE" && manual.data.origen_solicitud === "MANUAL" && manual.data.proveedor === datos.nombre_empresa, `${manual.status} ${manual.data.mensaje || ""}`);
  check("la línea trae el producto y la cantidad", manual.data.lineas?.length === 1 && manual.data.lineas[0].id_medicamento === idMed && manual.data.lineas[0].cantidad_solicitada === 40);
  const idManual = manual.data.id_pedido;
  const manualRepetida = await pedir(ruta, { method: "POST", token: adminTienda, key: keyManual, body: { id_proveedor: idProv, observaciones: "urgente", lineas: lineaMed(40) } });
  check("reintento con la misma clave: la misma solicitud", manualRepetida.status === 201 && manualRepetida.data.id_pedido === idManual);
  check("una sola solicitud tras el reintento", (await contar(local, "select count(*) as n from pedido where id_proveedor = $1", [idProv])) === 1);
  check("auditada en la tienda", (await contar(local, "select count(*) as n from registro_actividad where accion = 'SOLICITUD_CREAR' and id_entidad_afectada = $1", [idManual])) === 1);

  // --- Criterio 5: estado de la solicitud
  const lista = await pedir(`${ruta}?estado=PENDIENTE`, { token: adminTienda });
  check("consulta de solicitudes pendientes", lista.status === 200 && lista.data.solicitudes.some((s) => s.id_pedido === idManual) && lista.data.resumen.PENDIENTE >= 1);
  check("estado inválido 400", (await pedir(`${ruta}?estado=XYZ`, { token: adminTienda })).status === 400);
  check("detalle de una solicitud", (await pedir(`${ruta}/${idManual}`, { token: adminTienda })).data.estado_visible === "PENDIENTE");
  check("solicitud inexistente 404", (await pedir(`${ruta}/99999999`, { token: adminTienda })).status === 404);
  const enviada = await pedir(`${ruta}/${idManual}/enviar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: {} });
  check("marcar como enviada 200", enviada.status === 200 && enviada.data.estado_visible === "ENVIADA" && enviada.data.fecha_envio != null);
  check("enviarla otra vez 409 TRANSICION_INVALIDA", (await pedir(`${ruta}/${idManual}/enviar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: {} })).data.codigo === "TRANSICION_INVALIDA");
  const enviadas = await pedir(`${ruta}?estado=ENVIADA`, { token: adminTienda });
  check("el filtro por enviada la muestra", enviadas.data.solicitudes.some((s) => s.id_pedido === idManual));
  check("cancelar sin motivo 400", (await pedir(`${ruta}/${idManual}/cancelar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo: "no" } })).status === 400);

  // La recepción (HU-02/HU-14) acepta una solicitud enviada y la lleva a recibida.
  const venceEn = (await local.query("select (current_date + 400)::text as f")).rows[0].f;
  const recibida = await pedir(`/api/local/pedidos/${idManual}/recepcion`, {
    method: "POST",
    token: adminTienda,
    key: nuevaKey(),
    body: { lineas: [{ id_medicamento: idMed, numero_lote: `L-${S}`, fecha_caducidad: venceEn, cantidad: 40 }] },
  });
  check("recibir una solicitud enviada 200", recibida.status === 200 && recibida.data.estado === "RECIBIDO_TOTAL", `${recibida.status} ${recibida.data.mensaje || ""}`);
  const final = await pedir(`${ruta}/${idManual}`, { token: adminTienda });
  check("estado recibida con fecha de recepción y cantidades", final.data.estado_visible === "RECIBIDA" && final.data.fecha_recepcion != null && final.data.lineas[0].cantidad_recibida === 40);
  check("una recibida no se cancela 409", (await pedir(`${ruta}/${idManual}/cancelar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo: "ya no se necesita" } })).status === 409);
  let bloqueada = false;
  try {
    await local.query("update pedido set estado = 'SOLICITADO' where id_pedido = $1", [idManual]);
  } catch (error) {
    bloqueada = error.code === "23514";
  }
  check("la base impide retroceder una solicitud recibida", bloqueada);

  // --- Criterio 2: desde una alerta de stock, sin volver a ingresar el producto
  // Con 40 unidades en un lote vigente, el stock está bajo la alerta: se consume el lote con un ajuste directo en la base de pruebas.
  await local.query("update lote set cantidad_disponible = 3 where id_medicamento = $1", [idMed]);
  await evaluarAlertas();
  const alerta = (await local.query("select id_alerta, tipo from alerta where id_medicamento = $1 and estado = 'ACTIVA' and tipo in ('STOCK_BAJO', 'STOCK_AGOTADO')", [idMed])).rows[0];
  check("hay una alerta de stock bajo para el producto", alerta?.tipo === "STOCK_BAJO", JSON.stringify(alerta));
  const sugerencia = await pedir(`/api/local/alertas/${alerta.id_alerta}/solicitud`, { token: adminTienda });
  check(
    "la alerta trae producto, stock, mínimo y cantidad sugerida",
    sugerencia.status === 200 && sugerencia.data.medicamento.id_medicamento === idMed && sugerencia.data.stock === 3 && sugerencia.data.stock_minimo === 10 && sugerencia.data.cantidad_sugerida === 17,
    JSON.stringify(sugerencia.data),
  );
  check("el proveedor sugerido es el del último lote", sugerencia.data.proveedor_sugerido?.id_proveedor === idProv);
  check("el cajero no ve la sugerencia 403", (await pedir(`/api/local/alertas/${alerta.id_alerta}/solicitud`, { token: cajero })).status === 403);
  check("alerta inexistente 404", (await pedir("/api/local/alertas/99999999/solicitud", { token: adminTienda })).status === 404);
  const sinProvAlerta = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_alerta: alerta.id_alerta } });
  check("desde la alerta, también exige proveedor", sinProvAlerta.status === 400 && sinProvAlerta.data.codigo === "PROVEEDOR_OBLIGATORIO");

  // Cuatro administradores pulsan "generar solicitud" a la vez sobre la misma alerta: una sola nace.
  const carreras = await Promise.all(
    Array.from({ length: 4 }, () => pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_alerta: alerta.id_alerta, id_proveedor: idProv } })),
  );
  const nacidas = carreras.filter((r) => r.status === 201);
  check("cuatro solicitudes simultáneas desde la misma alerta: una sola", nacidas.length === 1 && carreras.filter((r) => r.data.codigo === "SOLICITUD_DUPLICADA").length === 3, carreras.map((r) => r.status).join(","));
  const deAlerta = nacidas[0].data;
  check("nace PENDIENTE, ligada a la alerta, con el producto y la cantidad sugerida", deAlerta.origen_solicitud === "ALERTA_AUTOMATICA" && deAlerta.id_alerta === alerta.id_alerta && deAlerta.alerta_tipo === "STOCK_BAJO" && deAlerta.lineas[0].id_medicamento === idMed && deAlerta.lineas[0].cantidad_solicitada === 17);
  const otraVez = await pedir(`/api/local/alertas/${alerta.id_alerta}/solicitud`, { token: adminTienda });
  check("la sugerencia avisa que ya hay una solicitud abierta", otraVez.data.solicitud_abierta?.id_pedido === deAlerta.id_pedido && otraVez.data.solicitud_abierta.estado_visible === "PENDIENTE");
  check("la cantidad se puede ajustar al cancelar y volver a generar", (await pedir(`${ruta}/${deAlerta.id_pedido}/cancelar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo: "cantidad equivocada" } })).data.estado_visible === "CANCELADA");
  const regenerada = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_alerta: alerta.id_alerta, id_proveedor: idProv, cantidad: 30 } });
  check("cancelada la anterior, se genera otra con otra cantidad", regenerada.status === 201 && regenerada.data.lineas[0].cantidad_solicitada === 30);
  const cancelada = (await pedir(`${ruta}/${deAlerta.id_pedido}`, { token: adminTienda })).data;
  check("la cancelada guarda su motivo y su auditoría", cancelada.observaciones === "cantidad equivocada" && (await contar(local, "select count(*) as n from registro_actividad where accion = 'SOLICITUD_CANCELAR' and id_entidad_afectada = $1", [deAlerta.id_pedido])) === 1);

  // Alertas que no se pueden reabastecer o que ya se resolvieron
  const sinUmbral = (await local.query("insert into alerta (tipo, id_medicamento, nivel, detalle) values ('SIN_UMBRAL', $1, 'ALTA', '{}') returning id_alerta", [idMed])).rows[0].id_alerta;
  const noRebast = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_alerta: sinUmbral, id_proveedor: idProv } });
  check("solo las alertas de stock generan solicitud 409", noRebast.status === 409 && noRebast.data.codigo === "ALERTA_NO_REABASTECIBLE");
  const resuelta = (await local.query("insert into alerta (tipo, id_medicamento, id_lote, nivel, detalle, estado, resuelta_en) values ('STOCK_BAJO', $1, 987654, 'MEDIA', '{\"stock\":1,\"stock_minimo\":10}', 'RESUELTA', now()) returning id_alerta", [idMed])).rows[0].id_alerta;
  const yaResuelta = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_alerta: resuelta, id_proveedor: idProv } });
  check("una alerta ya resuelta no genera solicitud 409", yaResuelta.status === 409 && yaResuelta.data.codigo === "ALERTA_RESUELTA");
  await local.query("delete from alerta where id_alerta = any($1::bigint[])", [[sinUmbral, resuelta]]);

  // --- Proveedor inactivo: no se generan solicitudes nuevas con él
  const desactivado = await pedir(`/api/local/proveedores/${idProv}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { activo: false } });
  check("desactivar un proveedor 200", desactivado.status === 200 && desactivado.data.activo === false);
  await pullReplica();
  const inactivo = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: lineaMed(5) } });
  check("proveedor inactivo: no se genera la solicitud 409", inactivo.status === 409 && inactivo.data.codigo === "PROVEEDOR_INACTIVO");
  let triggerOk = false;
  try {
    await local.query("insert into pedido (id_proveedor, id_empleado_solicitante, origen_solicitud) select $1, id_empleado, 'MANUAL' from empleado_ref where usuario = 'admin.tienda'", [idProv]);
  } catch (error) {
    triggerOk = error.code === "23514";
  }
  check("la base también rechaza un proveedor inactivo", triggerOk);
  let sinProvBase = false;
  try {
    await local.query("insert into pedido (id_proveedor, id_empleado_solicitante, origen_solicitud) select null, id_empleado, 'MANUAL' from empleado_ref where usuario = 'admin.tienda'");
  } catch (error) {
    // El disparador (proveedor inexistente o inactivo) actúa antes que NOT NULL: cualquiera de los dos lo rechaza.
    sinProvBase = ["23502", "23514"].includes(error.code);
  }
  check("la base rechaza una solicitud sin proveedor", sinProvBase);
  const sinInactivos = await pedir("/api/local/proveedores?detalle=1&q=" + encodeURIComponent(S), { token: adminTienda });
  const conInactivos = await pedir("/api/local/proveedores?detalle=1&incluir_inactivos=1&q=" + encodeURIComponent(S), { token: adminTienda });
  check("el registro oculta los inactivos salvo que se pidan", !sinInactivos.data.proveedores.some((p) => p.id_proveedor === idProv) && conInactivos.data.proveedores.some((p) => p.id_proveedor === idProv && p.activo === false));
  check("las solicitudes ya hechas con él siguen visibles", (await pedir(`${ruta}?id_proveedor=${idProv}`, { token: adminTienda })).data.solicitudes.length === 3);
  const reactivado = await pedir(`/api/central/proveedores/${idProv}`, { method: "PATCH", token: general, key: nuevaKey(), body: { activo: true } });
  check("reactivarlo desde la consola 200", reactivado.status === 200 && reactivado.data.activo === true);
  await pullReplica();

  // --- Sin conexión con el central: la tienda sigue solicitando; el registro de proveedores no se edita
  link.estado = "offline";
  const offline = await pedir(ruta, { method: "POST", token: adminTienda, key: nuevaKey(), body: { id_proveedor: idProv, lineas: lineaMed(7) } });
  check("sin central: la solicitud se genera igual 201", offline.status === 201 && offline.data.estado_visible === "PENDIENTE", `${offline.status} ${offline.data.mensaje || ""}`);
  check("sin central: se consultan las solicitudes", (await pedir(ruta, { token: adminTienda })).data.solicitudes.some((s) => s.id_pedido === offline.data.id_pedido));
  check("sin central: se marca como enviada", (await pedir(`${ruta}/${offline.data.id_pedido}/enviar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: {} })).data.estado_visible === "ENVIADA");
  check("sin central: el registro de proveedores se consulta en la tienda", (await pedir("/api/local/proveedores?detalle=1&q=" + encodeURIComponent(S), { token: adminTienda })).data.proveedores.some((p) => p.id_proveedor === idProv));
  const caida = await pedir("/api/local/proveedores", { method: "POST", token: adminTienda, key: nuevaKey(), body: { nombre_empresa: "Sin red", nit: `HU13X-${S}`.toUpperCase() } });
  check("sin central: registrar un proveedor 503 SIN_CONEXION", caida.status === 503 && caida.data.codigo === "SIN_CONEXION");
  check("sin central: no se registró", (await contar(central, "select count(*) as n from proveedor where nit = $1", [`HU13X-${S}`.toUpperCase()])) === 0);
  check("sin central: editar 503", (await pedir(`/api/local/proveedores/${idProv}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { telefono: "6015550000" } })).status === 503);
  check("sin central: la consola responde 503", (await pedir("/api/central/proveedores", { token: general })).status === 503);
  link.estado = "online";
  const salvaje = await pedir(`${ruta}/${offline.data.id_pedido}/cancelar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { motivo: "prueba terminada" } });
  check("al volver la red nada cambia en las solicitudes locales", salvaje.status === 200 && salvaje.data.estado_visible === "CANCELADA");

  // --- Consola: el registro de la red incluye los proveedores creados desde las tiendas
  const consola = await pedir("/api/central/proveedores?q=" + encodeURIComponent(S), { token: general });
  check("la consola lista los proveedores de la prueba", consola.status === 200 && consola.data.proveedores.length >= 3);
  check("la consola no tiene solicitudes (son de cada tienda) 404", (await pedir("/api/central/solicitudes", { token: general })).status === 404);
} finally {
  link.estado = "online";
  await central.query("update medicamento set activo = false where id_medicamento = $1", [idMed]);
  await local.query("update medicamento_ref set activo = false where id_medicamento = $1", [idMed]);
  if (proveedoresCreados.length) {
    // Los proveedores de prueba se desactivan en las dos bases (sin eventos) y sus solicitudes abiertas se cancelan,
    // para que no queden como pendientes en la tienda.
    await central.query("update proveedor set activo = false where id_proveedor = any($1::int[])", [proveedoresCreados]);
    await local.query("update proveedor_ref set activo = false where id_proveedor = any($1::int[])", [proveedoresCreados]);
    await local.query(
      "update pedido set estado = 'CANCELADO', observaciones = 'limpieza de la prueba HU-13' where id_proveedor = any($1::int[]) and estado in ('SOLICITADO', 'ENVIADO')",
      [proveedoresCreados],
    );
  }
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
