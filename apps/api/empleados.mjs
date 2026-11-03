import crypto from "crypto";
import { central, PEPPER } from "./db.mjs";
import { hashPassword } from "./crypto.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";
import { centralAlcanzable, estadoReal, link } from "./sync.mjs";

// HU-07: cuentas de empleados y restablecimiento de contraseña (RF-05, RNF-01, RNF-02, RNF-10).
// El central es el único dueño de las cuentas (HU-06): toda escritura va a su base en una transacción con
// su auditoría y el EMPLEADO_UPSERT hacia la tienda de la cuenta. Desde el POS se exige conexión: la
// unicidad del usuario y la jerarquía solo se garantizan en el central, así que sin red se responde 503.

const ROL_GENERAL = "administrador_general";
const ROLES_DE_TIENDA = ["cajero", "administrador_tienda"];
const ETIQUETA_ROL = { cajero: "Cajero", administrador_tienda: "Administrador de tienda", administrador_general: "Administrador general" };
const MINUTOS_CODIGO = 30;
const HORAS_CODIGO_ALTA = 24;
const MAX_INTENTOS_CODIGO = 5;
// Sin 0/O ni 1/I/L para dictarlo sin errores. 8 caracteres de 31 = ~40 bits, con 5 intentos y 30 minutos.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const USUARIO_RE = /^[a-z0-9][a-z0-9._-]{2,59}$/;
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAIDAS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P01", "08000", "08001", "08003", "08006"]);

function sinConexion() {
  return new ErrorNegocio(503, "SIN_CONEXION", "sin conexión con el nodo central", {
    estado_real: estadoReal(),
    forzado: link.force,
    ultima_sync: link.ultimaSync,
  });
}

// Las rutas del POS llaman al central por la red: una caída a mitad de la operación es 503, no 500.
export async function enCentral(fn) {
  if (!centralAlcanzable()) throw sinConexion();
  try {
    return await fn();
  } catch (error) {
    if (CAIDAS.has(error.code) || /Connection terminated|connect ETIMEDOUT/i.test(error.message || "")) throw sinConexion();
    throw error;
  }
}

async function auditar(client, idEmpleado, accion, idEntidad, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'empleado', $3, $4)`,
    [idEmpleado, accion, idEntidad, String(detalle || "").slice(0, 400)],
  );
}

// El rechazo se audita fuera de la transacción de la operación, que se revierte al lanzar el error.
async function denegar(actor, motivo, idEntidad = null) {
  await auditar(central, actor.id_empleado, "ACCESO_DENEGADO", idEntidad, `EMPLEADO_GESTIONAR: ${motivo}`);
  return new ErrorNegocio(403, "JERARQUIA", motivo);
}

// Quien actúa se relee en el central (no en la réplica del POS): rol y permisos vigentes.
async function actorDe(idEmpleado) {
  const result = await central.query(
    `select e.id_empleado, e.id_tienda, e.usuario, r.nombre as rol,
            coalesce(array_agg(p.codigo) filter (where p.codigo is not null), '{}') as permisos
     from empleado e
     join rol r on r.id_rol = e.id_rol
     left join rol_permiso rp on rp.id_rol = e.id_rol
     left join permiso p on p.id_permiso = rp.id_permiso
     where e.id_empleado = $1 and e.activo = true and e.fecha_baja is null
     group by e.id_empleado, r.nombre`,
    [idEmpleado],
  );
  const actor = result.rows[0];
  if (!actor) throw new ErrorNegocio(401, "SESION", "Sesión inválida o expirada");
  if (!actor.permisos.includes("EMPLEADO_GESTIONAR")) throw await denegar(actor, "sin permiso EMPLEADO_GESTIONAR");
  return actor;
}

// Restricción jerárquica: el admin de tienda solo gestiona cajeros y admins de su propia tienda.
function motivoJerarquia(actor, { tiendaObjetivo, rolObjetivo, tiendaNueva, rolNuevo }) {
  if (actor.rol === ROL_GENERAL) return null;
  if (rolObjetivo === ROL_GENERAL) return "No puede modificar cuentas de administrador general";
  if (rolNuevo === ROL_GENERAL) return "No puede asignar el rol de administrador general";
  if (tiendaObjetivo != null && Number(tiendaObjetivo) !== Number(actor.id_tienda)) return "Solo puede gestionar cuentas de su tienda";
  if (tiendaNueva != null && Number(tiendaNueva) !== Number(actor.id_tienda)) return "No puede asignar cuentas a otra tienda";
  return null;
}

async function exigirJerarquia(actor, datos, idEntidad) {
  const motivo = motivoJerarquia(actor, datos);
  if (motivo) throw await denegar(actor, motivo, idEntidad);
}

function texto(valor, { min = 1, max, campo, etiqueta }) {
  const limpio = String(valor ?? "").trim();
  if (limpio.length < min || limpio.length > max) {
    throw invalido(`${etiqueta} debe tener entre ${min} y ${max} caracteres`, { campo });
  }
  return limpio;
}

function correoDe(valor) {
  const limpio = String(valor ?? "").trim();
  if (!limpio) return null;
  if (limpio.length > 120 || !CORREO_RE.test(limpio)) throw invalido("Correo no válido", { campo: "correo" });
  return limpio.toLowerCase();
}

function enteroDe(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw invalido(`Falta ${campo}`, { campo });
  return n;
}

export function validarContrasena(password, usuario) {
  const valor = String(password ?? "");
  if (valor.length < 8 || valor.length > 128) throw invalido("La contraseña debe tener entre 8 y 128 caracteres", { campo: "password" });
  if (!/[A-Za-z]/.test(valor) || !/\d/.test(valor)) throw invalido("La contraseña debe combinar letras y números", { campo: "password" });
  if (usuario && valor.toLowerCase().includes(String(usuario).toLowerCase())) {
    throw invalido("La contraseña no puede contener el usuario", { campo: "password" });
  }
  return valor;
}

function nuevoCodigo() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const normalizarCodigo = (codigo) => String(codigo ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hmacCodigo = (idEmpleado, codigo) =>
  crypto.createHmac("sha256", PEPPER).update(`restablecer|${idEmpleado}|${normalizarCodigo(codigo)}`).digest("hex");

// Un solo código vigente por cuenta: generar uno anula el anterior.
async function emitirCodigo(client, idEmpleado, generadoPor, horas) {
  await client.query("update codigo_restablecimiento set estado = 'ANULADO' where id_empleado = $1 and estado = 'VIGENTE'", [idEmpleado]);
  const codigo = nuevoCodigo();
  const inserted = await client.query(
    `insert into codigo_restablecimiento (id_empleado, codigo_hmac, expira_en, generado_por)
     values ($1, $2, now() + $3::interval, $4)
     returning expira_en`,
    [idEmpleado, hmacCodigo(idEmpleado, codigo), `${horas} hours`, generadoPor],
  );
  return { codigo, expira_en: inserted.rows[0].expira_en };
}

// Mismo payload que emitirEmpleadosPendientes (migrate.mjs) y que aplica sync/handlers/empleado.mjs.
// Se envía a cada tienda afectada: la nueva la aplica y la anterior (si cambió) la desactiva y borra el hash.
async function publicar(client, idEmpleado, tiendas) {
  const fila = await client.query(
    `select id_empleado, id_tienda, id_rol, nombre_completo, usuario, activo, contrasena_hash, fecha_baja, version_credencial
     from empleado where id_empleado = $1`,
    [idEmpleado],
  );
  const empleado = fila.rows[0];
  for (const destino of [...new Set(tiendas.map(Number))]) {
    await client.query("select append_replica_evento($1, 'EMPLEADO_UPSERT', $2, $3::jsonb)", [
      destino,
      empleado.version_credencial,
      JSON.stringify(empleado),
    ]);
  }
  return empleado;
}

async function revocarSesiones(client, idEmpleado, idTienda) {
  await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [idEmpleado]);
  await client.query("select append_replica_evento($1, 'SESION_REVOCAR', 1, $2::jsonb)", [idTienda, JSON.stringify({ id_empleado: idEmpleado })]);
}

async function cuentaDe(client, idEmpleado, bloquear = false) {
  const result = await client.query(
    `select e.id_empleado, e.id_tienda, e.id_rol, e.usuario, e.nombre_completo, e.correo, e.activo, e.fecha_baja,
            e.version_cuenta, r.nombre as rol
     from empleado e join rol r on r.id_rol = e.id_rol
     where e.id_empleado = $1 ${bloquear ? "for update of e" : ""}`,
    [idEmpleado],
  );
  if (result.rowCount === 0) throw noEncontrado("La cuenta no existe");
  return result.rows[0];
}

async function rolDe(client, idRol) {
  const result = await client.query("select id_rol, nombre from rol where id_rol = $1", [idRol]);
  if (result.rowCount === 0) throw invalido("Rol no válido", { campo: "id_rol" });
  return result.rows[0];
}

async function exigirTiendaActiva(client, idTienda) {
  const result = await client.query("select activa from tienda where id_tienda = $1", [idTienda]);
  if (result.rowCount === 0) throw invalido("La tienda no existe", { campo: "id_tienda" });
  if (!result.rows[0].activa) throw invalido("La tienda está desactivada", { campo: "id_tienda" });
}

// La red nunca se queda sin un administrador general activo. Se bloquean todos para serializar.
async function exigirOtroGeneral(client, idEmpleado) {
  const otros = await client.query(
    `select e.id_empleado from empleado e join rol r on r.id_rol = e.id_rol
     where r.nombre = $1 and e.activo = true and e.fecha_baja is null and e.id_empleado <> $2
     for update of e`,
    [ROL_GENERAL, idEmpleado],
  );
  if (otros.rowCount === 0) throw conflicto("ULTIMO_GENERAL", "Debe quedar al menos un administrador general activo");
}

function exigirVersion(cuenta, version) {
  if (Number(cuenta.version_cuenta) !== version) {
    throw conflicto("CONFLICTO", "La cuenta cambió en otro puesto. Recargue e intente de nuevo");
  }
}

function vista(cuenta, tiendas = new Map()) {
  return {
    id_empleado: cuenta.id_empleado,
    usuario: cuenta.usuario,
    nombre_completo: cuenta.nombre_completo,
    correo: cuenta.correo,
    id_rol: cuenta.id_rol,
    rol: cuenta.rol,
    rol_etiqueta: ETIQUETA_ROL[cuenta.rol] || cuenta.rol,
    id_tienda: cuenta.id_tienda,
    tienda: tiendas.get(cuenta.id_tienda) ?? cuenta.tienda ?? null,
    activo: cuenta.activo && !cuenta.fecha_baja,
    fecha_baja: cuenta.fecha_baja,
    version_cuenta: Number(cuenta.version_cuenta),
  };
}

const escribir = (actor, key, operacion, body, fn) =>
  conIdempotencia(central, { key, operacion, idEmpleado: actor.id_empleado, body }, fn);

export async function listarCuentas(idActor, query = {}) {
  const actor = await actorDe(idActor);
  const general = actor.rol === ROL_GENERAL;
  const filtroTienda = general ? (query.tienda ? enteroDe(query.tienda, "tienda") : null) : actor.id_tienda;
  const [cuentas, roles, tiendas] = await Promise.all([
    central.query(
      `select e.id_empleado, e.id_tienda, e.id_rol, e.usuario, e.nombre_completo, e.correo, e.activo, e.fecha_baja,
              e.version_cuenta, r.nombre as rol, t.nombre as tienda
       from empleado e join rol r on r.id_rol = e.id_rol join tienda t on t.id_tienda = e.id_tienda
       where ($1::int is null or e.id_tienda = $1)
       order by (e.activo and e.fecha_baja is null) desc, t.nombre, e.nombre_completo`,
      [filtroTienda],
    ),
    central.query("select id_rol, nombre from rol order by id_rol"),
    central.query(
      "select id_tienda, nombre from tienda where activa = true and ($1::int is null or id_tienda = $1) order by nombre",
      [general ? null : actor.id_tienda],
    ),
  ]);
  return {
    empleados: cuentas.rows.map((cuenta) => vista(cuenta)),
    roles: roles.rows
      .filter((rol) => general || ROLES_DE_TIENDA.includes(rol.nombre))
      .map((rol) => ({ ...rol, etiqueta: ETIQUETA_ROL[rol.nombre] || rol.nombre })),
    tiendas: tiendas.rows,
    actor: { id_empleado: actor.id_empleado, rol: actor.rol, id_tienda: actor.id_tienda },
  };
}

// Alta: la cuenta nace con una contraseña aleatoria que nadie conoce y un código de activación de 24 h.
// El empleado elige su contraseña con ese código (mismo flujo que el restablecimiento): el admin nunca la ve.
export async function crearCuenta(idActor, key, body) {
  const actor = await actorDe(idActor);
  const usuario = texto(body.usuario, { min: 3, max: 60, campo: "usuario", etiqueta: "El usuario" }).toLowerCase();
  if (!USUARIO_RE.test(usuario)) throw invalido("Usuario: minúsculas, números, punto, guion o guion bajo", { campo: "usuario" });
  const nombre = texto(body.nombre_completo, { min: 3, max: 150, campo: "nombre_completo", etiqueta: "El nombre" });
  const correo = correoDe(body.correo);
  const idRol = enteroDe(body.id_rol, "id_rol");
  const idTienda = actor.rol === ROL_GENERAL ? enteroDe(body.id_tienda, "id_tienda") : actor.id_tienda;
  const rol = await rolDe(central, idRol);
  await exigirJerarquia(actor, { rolNuevo: rol.nombre, tiendaNueva: idTienda });

  let activacion = null;
  try {
    const resultado = await escribir(actor, key, "EMPLEADO_CREAR", body, async (client) => {
      await exigirTiendaActiva(client, idTienda);
      const existe = await client.query("select 1 from empleado where usuario = $1", [usuario]);
      if (existe.rowCount > 0) throw conflicto("USUARIO_EXISTE", "Ese usuario ya existe en la red");
      const creado = await client.query(
        `insert into empleado (id_tienda, id_rol, nombre_completo, usuario, contrasena_hash, correo, activo, version_credencial)
         values ($1, $2, $3, $4, $5, $6, true, 1)
         returning id_empleado`,
        [idTienda, idRol, nombre, usuario, hashPassword(crypto.randomBytes(32).toString("base64url")), correo],
      );
      const id = creado.rows[0].id_empleado;
      activacion = await emitirCodigo(client, id, actor.id_empleado, HORAS_CODIGO_ALTA);
      await publicar(client, id, [idTienda]);
      await auditar(client, actor.id_empleado, "EMPLEADO_CREAR", id, `usuario ${usuario}, rol ${rol.nombre}, tienda ${idTienda}`);
      // El código no se guarda en la respuesta idempotente: solo viaja en la primera respuesta.
      return { status: 201, body: { empleado: vista(await cuentaDe(client, id)) } };
    });
    return entregarCodigo(resultado, activacion);
  } catch (error) {
    if (error.code === "23505") throw conflicto("USUARIO_EXISTE", "Ese usuario ya existe en la red");
    throw error;
  }
}

function entregarCodigo(resultado, codigo) {
  if (resultado.repetido || !codigo) {
    return { ...resultado, body: { ...resultado.body, aviso: resultado.repetido ? "Operación ya realizada: el código solo se muestra una vez. Genere otro si lo perdió." : undefined } };
  }
  return { ...resultado, body: { ...resultado.body, codigo: codigo.codigo, codigo_expira_en: codigo.expira_en } };
}

export async function editarCuenta(idActor, key, idEmpleado, body) {
  const actor = await actorDe(idActor);
  const version = enteroDe(body.version_cuenta, "version_cuenta");
  const actual = await cuentaDe(central, idEmpleado);
  const nombre = texto(body.nombre_completo ?? actual.nombre_completo, { min: 3, max: 150, campo: "nombre_completo", etiqueta: "El nombre" });
  const correo = body.correo === undefined ? actual.correo : correoDe(body.correo);
  const idRol = body.id_rol == null ? actual.id_rol : enteroDe(body.id_rol, "id_rol");
  const idTienda = body.id_tienda == null ? actual.id_tienda : enteroDe(body.id_tienda, "id_tienda");
  const rolNuevo = await rolDe(central, idRol);
  await exigirJerarquia(actor, { tiendaObjetivo: actual.id_tienda, rolObjetivo: actual.rol, tiendaNueva: idTienda, rolNuevo: rolNuevo.nombre }, idEmpleado);
  if (Number(idEmpleado) === Number(actor.id_empleado) && (idRol !== actual.id_rol || idTienda !== actual.id_tienda)) {
    throw await denegar(actor, "No puede cambiar su propio rol ni su tienda", idEmpleado);
  }

  return escribir(actor, key, `EMPLEADO_EDITAR:${idEmpleado}`, body, async (client) => {
    const cuenta = await cuentaDe(client, idEmpleado, true);
    exigirVersion(cuenta, version);
    if (idTienda !== cuenta.id_tienda) await exigirTiendaActiva(client, idTienda);
    if (cuenta.rol === ROL_GENERAL && rolNuevo.nombre !== ROL_GENERAL && cuenta.activo) await exigirOtroGeneral(client, idEmpleado);
    await client.query(
      `update empleado
       set nombre_completo = $2, correo = $3, id_rol = $4, id_tienda = $5, version_cuenta = version_cuenta + 1
       where id_empleado = $1`,
      [idEmpleado, nombre, correo, idRol, idTienda],
    );
    if (idTienda !== cuenta.id_tienda) await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [idEmpleado]);
    await publicar(client, idEmpleado, [cuenta.id_tienda, idTienda]);
    const cambios = [
      nombre !== cuenta.nombre_completo && "nombre",
      correo !== cuenta.correo && "correo",
      idRol !== cuenta.id_rol && `rol ${cuenta.rol} → ${rolNuevo.nombre}`,
      idTienda !== cuenta.id_tienda && `tienda ${cuenta.id_tienda} → ${idTienda}`,
    ].filter(Boolean);
    await auditar(client, actor.id_empleado, "EMPLEADO_EDITAR", idEmpleado, `${cuenta.usuario}: ${cambios.join(", ") || "sin cambios"}`);
    return { status: 200, body: { empleado: vista(await cuentaDe(client, idEmpleado)) } };
  });
}

async function cambiarEstado(idActor, key, idEmpleado, body, activar) {
  const actor = await actorDe(idActor);
  const version = enteroDe(body.version_cuenta, "version_cuenta");
  const actual = await cuentaDe(central, idEmpleado);
  await exigirJerarquia(actor, { tiendaObjetivo: actual.id_tienda, rolObjetivo: actual.rol }, idEmpleado);
  if (!activar && Number(idEmpleado) === Number(actor.id_empleado)) throw await denegar(actor, "No puede desactivar su propia cuenta", idEmpleado);
  const accion = activar ? "EMPLEADO_REACTIVAR" : "EMPLEADO_DESACTIVAR";

  return escribir(actor, key, `${accion}:${idEmpleado}`, { version }, async (client) => {
    const cuenta = await cuentaDe(client, idEmpleado, true);
    const activa = cuenta.activo && !cuenta.fecha_baja;
    // Ya está en el estado pedido: la operación es idempotente y no publica ni audita de nuevo.
    if (activa === activar) return { status: 200, body: { empleado: vista(cuenta) } };
    exigirVersion(cuenta, version);
    if (activar) {
      await exigirTiendaActiva(client, cuenta.id_tienda);
      await client.query(
        "update empleado set activo = true, fecha_baja = null, version_cuenta = version_cuenta + 1 where id_empleado = $1",
        [idEmpleado],
      );
    } else {
      if (cuenta.rol === ROL_GENERAL) await exigirOtroGeneral(client, idEmpleado);
      await client.query(
        "update empleado set activo = false, fecha_baja = now(), version_cuenta = version_cuenta + 1 where id_empleado = $1",
        [idEmpleado],
      );
      await client.query("update codigo_restablecimiento set estado = 'ANULADO' where id_empleado = $1 and estado = 'VIGENTE'", [idEmpleado]);
      await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [idEmpleado]);
    }
    // El handler de la tienda revoca las sesiones locales al recibir activo=false / fecha_baja.
    await publicar(client, idEmpleado, [cuenta.id_tienda]);
    await auditar(client, actor.id_empleado, accion, idEmpleado, cuenta.usuario);
    return { status: 200, body: { empleado: vista(await cuentaDe(client, idEmpleado)) } };
  });
}

export const desactivarCuenta = (idActor, key, idEmpleado, body) => cambiarEstado(idActor, key, idEmpleado, body, false);
export const reactivarCuenta = (idActor, key, idEmpleado, body) => cambiarEstado(idActor, key, idEmpleado, body, true);

// El admin genera un código de un solo uso (30 min) y se lo entrega al empleado en persona.
// No cambia la contraseña ni cierra sesiones: eso ocurre solo cuando el empleado canjea el código.
export async function generarCodigo(idActor, key, idEmpleado) {
  const actor = await actorDe(idActor);
  const actual = await cuentaDe(central, idEmpleado);
  await exigirJerarquia(actor, { tiendaObjetivo: actual.id_tienda, rolObjetivo: actual.rol }, idEmpleado);
  let codigo = null;
  const resultado = await escribir(actor, key, `CONTRASENA_CODIGO:${idEmpleado}`, {}, async (client) => {
    const cuenta = await cuentaDe(client, idEmpleado, true);
    if (!cuenta.activo || cuenta.fecha_baja) throw conflicto("CUENTA_INACTIVA", "La cuenta está desactivada");
    codigo = await emitirCodigo(client, idEmpleado, actor.id_empleado, MINUTOS_CODIGO / 60);
    await auditar(client, actor.id_empleado, "CONTRASENA_CODIGO_GENERADO", idEmpleado, cuenta.usuario);
    return { status: 201, body: { empleado: vista(cuenta) } };
  });
  return entregarCodigo(resultado, codigo);
}

const CODIGO_INVALIDO = { codigo: "CODIGO_INVALIDO", mensaje: "Usuario o código no válidos, vencidos o ya usados" };

// Canje sin sesión. El error es el mismo para usuario inexistente, código malo, vencido o usado
// (no revela qué cuentas existen). Los fallos sí quedan guardados: se devuelven, no se lanzan.
export async function restablecerContrasena(key, body) {
  const usuario = String(body.usuario ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!usuario || !normalizarCodigo(body.codigo)) throw invalido("Usuario y código son obligatorios");
  validarContrasena(password, usuario);
  return conIdempotencia(central, { key, operacion: "CONTRASENA_RESTABLECER", idEmpleado: 0, body }, async (client) => {
    const cuenta = await client.query(
      "select id_empleado, id_tienda, usuario from empleado where usuario = $1 and activo = true and fecha_baja is null for update",
      [usuario],
    );
    const empleado = cuenta.rows[0];
    const vigente = empleado
      ? await client.query(
          `select id_codigo, codigo_hmac, intentos from codigo_restablecimiento
           where id_empleado = $1 and estado = 'VIGENTE' and expira_en > now()
           order by id_codigo desc limit 1 for update`,
          [empleado.id_empleado],
        )
      : { rowCount: 0, rows: [] };
    if (vigente.rowCount === 0) {
      await client.query(
        `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, detalle)
         values ($1, 'CONTRASENA_RESTABLECER_FALLIDO', 'empleado', $2)`,
        [empleado?.id_empleado ?? null, `${usuario.slice(0, 60)}: sin código vigente`],
      );
      return { status: 400, body: CODIGO_INVALIDO };
    }
    const fila = vigente.rows[0];
    const esperado = Buffer.from(fila.codigo_hmac, "hex");
    const recibido = Buffer.from(hmacCodigo(empleado.id_empleado, body.codigo), "hex");
    if (!crypto.timingSafeEqual(esperado, recibido)) {
      const intentos = fila.intentos + 1;
      await client.query(
        "update codigo_restablecimiento set intentos = $2::int, estado = case when $2::int >= $3::int then 'BLOQUEADO' else estado end where id_codigo = $1",
        [fila.id_codigo, intentos, MAX_INTENTOS_CODIGO],
      );
      await auditar(client, empleado.id_empleado, "CONTRASENA_RESTABLECER_FALLIDO", empleado.id_empleado, `intento ${intentos} de ${MAX_INTENTOS_CODIGO}`);
      return { status: 400, body: CODIGO_INVALIDO };
    }
    // Contraseña nueva: version_credencial sube, así un login hecho con la anterior no se reaplica (HU-06).
    await client.query(
      `update empleado set contrasena_hash = $2, version_credencial = version_credencial + 1, version_cuenta = version_cuenta + 1
       where id_empleado = $1`,
      [empleado.id_empleado, hashPassword(password)],
    );
    await client.query("update codigo_restablecimiento set estado = 'USADO', usado_en = now() where id_codigo = $1", [fila.id_codigo]);
    await publicar(client, empleado.id_empleado, [empleado.id_tienda]);
    await revocarSesiones(client, empleado.id_empleado, empleado.id_tienda);
    await auditar(client, empleado.id_empleado, "CONTRASENA_RESTABLECIDA", empleado.id_empleado, empleado.usuario);
    return { status: 200, body: { ok: true, mensaje: "Contraseña actualizada. Su tienda la recibe en la próxima sincronización." } };
  });
}
