// Pruebas de HU-07 por las rutas reales de app.mjs: cuentas, jerarquía, restablecimiento, réplica a la tienda,
// sin conexión, auditoría no editable, filtros y subida de la auditoría de la tienda al central.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las cuentas de prueba quedan desactivadas, no se borran (su auditoría es permanente).
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local, runtime } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { subirAuditoria } = await import("../apps/api/auditoria.mjs");

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
const entrar = (nodo, usuario, password) =>
  pedir(`/api/${nodo}/auth/login`, { method: "POST", key: crypto.randomUUID(), body: { usuario, password } });
const nuevaKey = () => crypto.randomUUID();
const S = Date.now().toString(36);
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);
const PASSWORD = `Nueva${S}9x`;

const creados = [];
try {
  const general = (await entrar("central", "admin.general", "Farma123")).data.token;
  const adminTienda = (await entrar("local", "admin.tienda", "Farma123")).data.token;
  const cajero = (await entrar("local", "cajero1", "Farma123")).data.token;
  check("logins demo", Boolean(general && adminTienda && cajero));
  const roles = Object.fromEntries((await central.query("select nombre, id_rol from rol")).rows.map((r) => [r.nombre, r.id_rol]));
  const idTienda = runtime.tiendaId;
  const otraTienda = (await central.query("select id_tienda from tienda where id_tienda <> $1 and activa order by 1 limit 1", [idTienda])).rows[0]?.id_tienda;

  // --- Acceso
  check("sin sesión 401", (await pedir("/api/local/empleados")).status === 401);
  const negadosAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO'");
  check("cajero 403", (await pedir("/api/local/empleados", { token: cajero })).status === 403);
  check("403 del cajero auditado en la tienda", (await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO'")) === negadosAntes + 1);
  check("cajero sin auditoría 403", (await pedir("/api/local/auditoria", { token: cajero })).status === 403);

  const lista = await pedir("/api/local/empleados", { token: adminTienda });
  check(
    "admin de tienda ve solo su tienda",
    lista.status === 200 && lista.data.empleados.length > 0 && lista.data.empleados.every((e) => e.id_tienda === idTienda),
    String(lista.status),
  );
  check("admin de tienda no puede asignar admin general", !lista.data.roles.some((r) => r.nombre === "administrador_general"));

  // --- Alta (criterio 1) con código de activación
  const usuario = `hu07.caj.${S}`;
  const alta = { usuario, nombre_completo: "Cajero de Prueba HU07", correo: `caj.${S}@farmahub.local`, id_rol: roles.cajero, id_tienda: otraTienda };
  check("alta sin Idempotency-Key 400", (await pedir("/api/local/empleados", { method: "POST", token: adminTienda, body: alta })).status === 400);
  check("usuario inválido 400", (await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key: nuevaKey(), body: { ...alta, usuario: "A B" } })).status === 400);
  const key = nuevaKey();
  const creada = await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key, body: alta });
  const id = creada.data.empleado?.id_empleado;
  if (id) creados.push(id);
  check("alta 201 con código", creada.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(creada.data.codigo || ""), `${creada.status} ${creada.data.mensaje || ""}`);
  check("admin de tienda no elige otra tienda: queda en la suya", creada.data.empleado?.id_tienda === idTienda);
  const repetida = await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key, body: alta });
  check("reintento: misma cuenta, sin volver a mostrar el código", repetida.status === 201 && repetida.data.empleado?.id_empleado === id && !repetida.data.codigo);
  check("misma clave con otros datos 409", (await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key, body: { ...alta, nombre_completo: "Otro" } })).status === 409);
  check("usuario repetido 409", (await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key: nuevaKey(), body: alta })).data.codigo === "USUARIO_EXISTE");
  check("una sola cuenta", (await contar(central, "select count(*) as n from empleado where usuario = $1", [usuario])) === 1);
  const codigoEnClaro = await contar(central, "select count(*) as n from auth_operacion where cuerpo_json::text like $1", [`%${creada.data.codigo}%`]);
  check("el código no queda guardado en claro", codigoEnClaro === 0);

  // --- Jerarquía (criterio 5)
  const negadosCentral = await contar(central, "select count(*) as n from registro_actividad_central where accion = 'ACCESO_DENEGADO' and entidad_afectada = 'empleado'");
  const subeAGeneral = await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key: nuevaKey(), body: { ...alta, usuario: `hu07.g.${S}`, id_rol: roles.administrador_general } });
  check("admin de tienda no crea admin general 403", subeAGeneral.status === 403 && subeAGeneral.data.codigo === "JERARQUIA");
  const idGeneral = (await central.query("select id_empleado, version_cuenta from empleado where usuario = 'admin.general'")).rows[0];
  check(
    "admin de tienda no edita al admin general 403",
    (await pedir(`/api/local/empleados/${idGeneral.id_empleado}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { nombre_completo: "Cambio", version_cuenta: Number(idGeneral.version_cuenta) } })).status === 403,
  );
  check(
    "admin de tienda no genera código para el admin general 403",
    (await pedir(`/api/local/empleados/${idGeneral.id_empleado}/codigo`, { method: "POST", token: adminTienda, key: nuevaKey() })).status === 403,
  );
  check("rechazos jerárquicos auditados en el central", (await contar(central, "select count(*) as n from registro_actividad_central where accion = 'ACCESO_DENEGADO' and entidad_afectada = 'empleado'")) === negadosCentral + 3);
  const yo = (await central.query("select id_empleado, version_cuenta from empleado where usuario = 'admin.tienda'")).rows[0];
  check("no se desactiva a sí mismo 403", (await pedir(`/api/local/empleados/${yo.id_empleado}/desactivar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { version_cuenta: Number(yo.version_cuenta) } })).status === 403);
  check("no cambia su propio rol 403", (await pedir(`/api/local/empleados/${yo.id_empleado}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { id_rol: roles.cajero, version_cuenta: Number(yo.version_cuenta) } })).status === 403);

  // --- Réplica a la tienda y activación con el código (criterio 2)
  await pullReplica();
  const ref = await local.query("select activo, contrasena_hash is not null as hash from empleado_ref where id_empleado = $1", [id]);
  check("la cuenta llega a la tienda", ref.rowCount === 1 && ref.rows[0].activo && ref.rows[0].hash);
  check("contraseña débil 400", (await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: creada.data.codigo, password: "12345678" } })).status === 400);
  const canje = await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: creada.data.codigo, password: PASSWORD } });
  check("canje del código de activación 200", canje.status === 200, `${canje.status} ${canje.data.mensaje || ""}`);
  check("código ya usado 400", (await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: creada.data.codigo, password: PASSWORD } })).data.codigo === "CODIGO_INVALIDO");
  check("usuario inexistente: mismo error genérico", (await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario: `nadie.${S}`, codigo: "AAAA-AAAA", password: PASSWORD } })).data.codigo === "CODIGO_INVALIDO");
  const version = await central.query("select version_credencial from empleado where id_empleado = $1", [id]);
  check("restablecer sube version_credencial", Number(version.rows[0].version_credencial) === 2);
  await pullReplica();
  const sesionNueva = await entrar("local", usuario, PASSWORD);
  check("login en la tienda con la contraseña nueva", sesionNueva.status === 200, String(sesionNueva.status));

  // Código con intentos fallidos: se bloquea al quinto.
  const codigo = await pedir(`/api/local/empleados/${id}/codigo`, { method: "POST", token: adminTienda, key: nuevaKey() });
  check("generar código 201", codigo.status === 201 && Boolean(codigo.data.codigo));
  for (let i = 0; i < 5; i += 1) {
    await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: "ZZZZ-ZZZZ", password: PASSWORD } });
  }
  const bloqueado = await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: codigo.data.codigo, password: `${PASSWORD}b` } });
  check("tras 5 intentos el código queda inválido", bloqueado.status === 400);
  check("estado BLOQUEADO", (await contar(central, "select count(*) as n from codigo_restablecimiento where id_empleado = $1 and estado = 'BLOQUEADO'", [id])) === 1);

  // --- Edición con versión
  const actual = (await pedir("/api/local/empleados", { token: adminTienda })).data.empleados.find((e) => e.id_empleado === id);
  const editada = await pedir(`/api/local/empleados/${id}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { nombre_completo: "Cajero HU07 Editado", version_cuenta: actual.version_cuenta } });
  check("edición 200", editada.status === 200 && editada.data.empleado.nombre_completo === "Cajero HU07 Editado", editada.data.mensaje || "");
  check("edición con versión vieja 409", (await pedir(`/api/local/empleados/${id}`, { method: "PATCH", token: adminTienda, key: nuevaKey(), body: { nombre_completo: "Pisado", version_cuenta: actual.version_cuenta } })).status === 409);

  // --- Desactivación: revoca sesiones en la tienda y bloquea el login
  const baja = await pedir(`/api/local/empleados/${id}/desactivar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { version_cuenta: editada.data.empleado.version_cuenta } });
  check("desactivar 200", baja.status === 200 && baja.data.empleado.activo === false);
  await pullReplica();
  check("su sesión de la tienda queda revocada", (await pedir("/api/auth/me?nodo=local", { token: sesionNueva.data.token })).status === 401);
  check("ya no puede entrar", (await entrar("local", usuario, PASSWORD)).status !== 200);
  const alta2 = await pedir(`/api/local/empleados/${id}/reactivar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { version_cuenta: baja.data.empleado.version_cuenta } });
  check("reactivar 200", alta2.status === 200 && alta2.data.empleado.activo === true);

  // --- Admin general desde la consola: cualquier tienda
  if (otraTienda) {
    const deOtra = await pedir("/api/central/empleados", { method: "POST", token: general, key: nuevaKey(), body: { usuario: `hu07.adm.${S}`, nombre_completo: "Admin de otra tienda", id_rol: roles.administrador_tienda, id_tienda: otraTienda } });
    if (deOtra.data.empleado) creados.push(deOtra.data.empleado.id_empleado);
    check("admin general crea en otra tienda", deOtra.status === 201 && deOtra.data.empleado.id_tienda === otraTienda);
    check(
      "admin de tienda no toca cuentas de otra tienda 403",
      (await pedir(`/api/local/empleados/${deOtra.data.empleado.id_empleado}/desactivar`, { method: "POST", token: adminTienda, key: nuevaKey(), body: { version_cuenta: 1 } })).status === 403,
    );
    const red = await pedir("/api/central/empleados", { token: general });
    check("admin general ve toda la red", red.status === 200 && new Set(red.data.empleados.map((e) => e.id_tienda)).size >= 2);
    await pullReplica();
    check("la cuenta de otra tienda no recibe hash aquí", (await contar(local, "select count(*) as n from empleado_ref where id_empleado = $1 and contrasena_hash is not null", [deOtra.data.empleado.id_empleado])) === 0);
  }
  check("admin general no se desactiva a sí mismo 403", (await pedir(`/api/central/empleados/${idGeneral.id_empleado}/desactivar`, { method: "POST", token: general, key: nuevaKey(), body: { version_cuenta: Number(idGeneral.version_cuenta) } })).status === 403);

  // --- Sin conexión: cuentas 503, auditoría local sigue
  link.estado = "offline";
  const caida = await pedir("/api/local/empleados", { method: "POST", token: adminTienda, key: nuevaKey(), body: { ...alta, usuario: `hu07.off.${S}` } });
  check("sin central: alta 503", caida.status === 503 && caida.data.codigo === "SIN_CONEXION");
  check("sin central: no se creó", (await contar(central, "select count(*) as n from empleado where usuario = $1", [`hu07.off.${S}`])) === 0);
  check("sin central: restablecer 503", (await pedir("/api/local/auth/restablecer", { method: "POST", key: nuevaKey(), body: { usuario, codigo: "AAAA-AAAA", password: PASSWORD } })).status === 503);
  check("sin central: la auditoría local responde", (await pedir("/api/local/auditoria", { token: adminTienda })).status === 200);
  check("sin central: la de cuentas 503", (await pedir("/api/local/auditoria?origen=cuentas", { token: adminTienda })).status === 503);
  link.estado = "online";

  // --- Consulta y filtros (criterio 4)
  const logins = await pedir("/api/local/auditoria?accion=INICIO_SESION", { token: adminTienda });
  check("filtro por acción", logins.status === 200 && logins.data.total > 0 && logins.data.registros.every((r) => r.accion === "INICIO_SESION"));
  const porUsuario = await pedir(`/api/local/auditoria?usuario=${encodeURIComponent(usuario)}`, { token: adminTienda });
  check("filtro por usuario", porUsuario.status === 200 && porUsuario.data.total > 0 && porUsuario.data.registros.every((r) => r.usuario === usuario));
  const futuro = new Date(Date.now() + 86400000).toISOString();
  check("filtro por fecha (desde mañana: nada)", (await pedir(`/api/local/auditoria?desde=${futuro}`, { token: adminTienda })).data.total === 0);
  check("fechas al revés 400", (await pedir(`/api/local/auditoria?desde=${futuro}&hasta=${new Date().toISOString()}`, { token: adminTienda })).status === 400);
  check("trae fecha, hora y usuario", logins.data.registros.every((r) => r.fecha_hora && r.usuario));
  const cuentas = await pedir("/api/local/auditoria?origen=cuentas&accion=EMPLEADO_CREAR", { token: adminTienda });
  check(
    "admin de tienda ve las acciones de cuentas de su tienda",
    cuentas.status === 200 && cuentas.data.registros.some((r) => r.id_entidad_afectada === id) && !cuentas.data.registros.some((r) => creados.slice(1).includes(r.id_entidad_afectada)),
  );

  // --- Subida de la auditoría de la tienda al central
  const antes = await contar(central, "select count(*) as n from auditoria_tienda where id_tienda = $1", [idTienda]);
  const subida = await subirAuditoria(idTienda);
  const despues = await contar(central, "select count(*) as n from auditoria_tienda where id_tienda = $1", [idTienda]);
  check("la auditoría de la tienda sube al central", subida.enviados > 0 && despues > antes, `${antes} → ${despues}`);
  await subirAuditoria(idTienda);
  check("reenviar no duplica", (await contar(central, "select count(*) as n from auditoria_tienda where id_tienda = $1", [idTienda])) === despues);
  const maxLocal = await contar(local, "select coalesce(max(id_registro), 0) as n from registro_actividad");
  const maxCentral = await contar(central, "select coalesce(max(id_registro), 0) as n from auditoria_tienda where id_tienda = $1", [idTienda]);
  check("el central tiene hasta el último registro de la tienda", maxCentral === maxLocal, `${maxCentral} / ${maxLocal}`);

  // --- Auditoría no editable (criterio 3)
  for (const [nombre, pool, tabla] of [["local", local, "registro_actividad"], ["central", central, "registro_actividad_central"], ["red", central, "auditoria_tienda"]]) {
    let bloqueo = 0;
    for (const sql of [`update ${tabla} set detalle = 'x'`, `delete from ${tabla}`, `truncate ${tabla}`]) {
      try {
        await pool.query(sql);
      } catch (error) {
        if (error.code === "42501") bloqueo += 1;
      }
    }
    check(`auditoría ${nombre}: update, delete y truncate bloqueados`, bloqueo === 3);
  }

  const redAud = await pedir(`/api/central/auditoria?accion=EMPLEADO_CREAR&usuario=admin.tienda`, { token: general });
  check("consola: auditoría de red filtrada", redAud.status === 200 && redAud.data.registros.some((r) => r.id_entidad_afectada === id && r.origen === "central"));
  const deTienda = await pedir(`/api/central/auditoria?tienda=${idTienda}&accion=INICIO_SESION`, { token: general });
  check("consola: logins subidos de la tienda", deTienda.status === 200 && deTienda.data.total > 0 && deTienda.data.registros.every((r) => r.origen === "tienda" && r.id_tienda === idTienda));
  const soloCentral = await pedir("/api/central/auditoria?tienda=central", { token: general });
  check("consola: solo el central", soloCentral.status === 200 && soloCentral.data.registros.every((r) => r.origen === "central"));
} finally {
  link.estado = "online";
  // Las cuentas de prueba quedan desactivadas (no se borran: su auditoría las referencia).
  for (const idCreado of creados) {
    await central.query("update empleado set activo = false, fecha_baja = coalesce(fecha_baja, now()) where id_empleado = $1", [idCreado]);
    await local.query("update empleado_ref set activo = false, fecha_baja = coalesce(fecha_baja, now()) where id_empleado = $1", [idCreado]);
  }
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
