import { central, local } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";

// HU-13: registro de proveedores (RF-09). El central es el dueño (proveedor): toda escritura va a su base en una
// transacción con su auditoría y un PROVEEDOR_UPSERT con la fila completa hacia todas las tiendas. Las tiendas guardan
// proveedor_ref con los datos de contacto, así que consultan el registro y generan solicitudes sin conexión.
// Desde el POS, registrar y editar exigen conexión (503, igual que HU-03): el NIT único solo se garantiza en el central.
// Dos administradores que editan el mismo proveedor a la vez se serializan con FOR UPDATE; gana el último en guardar
// (son datos de contacto, no stock, recetas ni pagos: la política está documentada en HU-13).

const NIT_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]{4,39}$/;
const TELEFONO_RE = /^[0-9+()\-\s]{7,30}$/;
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RESULTADOS = 200;

const entero = (valor, campo) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw invalido(`${campo} no válido`, { campo });
  return n;
};
export const idProveedorDe = (valor) => entero(valor, "id_proveedor");

function textoObligatorio(valor, { min, max, campo, etiqueta }) {
  const limpio = String(valor ?? "").trim().replace(/\s+/g, " ");
  if (limpio.length < min || limpio.length > max) throw invalido(`${etiqueta} debe tener entre ${min} y ${max} caracteres`, { campo });
  return limpio;
}

// Opcionales: vacío = sin dato (null). Si traen algo, deben ser válidos.
function opcional(valor, { max, campo, etiqueta, re, formato }) {
  const limpio = String(valor ?? "").trim();
  if (!limpio) return null;
  if (limpio.length > max) throw invalido(`${etiqueta} admite máximo ${max} caracteres`, { campo });
  if (re && !re.test(limpio)) throw invalido(formato, { campo });
  return campo === "correo" ? limpio.toLowerCase() : limpio;
}

function datosDe(body, { parcial }) {
  const tiene = (campo) => !parcial || Object.hasOwn(body ?? {}, campo);
  const datos = {};
  if (tiene("nombre_empresa")) datos.nombre_empresa = textoObligatorio(body?.nombre_empresa, { min: 3, max: 150, campo: "nombre_empresa", etiqueta: "El nombre de la empresa" });
  if (tiene("nit")) {
    const nit = String(body?.nit ?? "").trim();
    if (!NIT_RE.test(nit)) throw invalido("El NIT debe tener entre 5 y 40 caracteres (letras, números, punto o guion)", { campo: "nit" });
    datos.nit = nit;
  }
  if (tiene("telefono")) datos.telefono = opcional(body?.telefono, { max: 30, campo: "telefono", etiqueta: "El teléfono", re: TELEFONO_RE, formato: "Teléfono no válido (7 a 30 dígitos)" });
  if (tiene("correo")) datos.correo = opcional(body?.correo, { max: 120, campo: "correo", etiqueta: "El correo", re: CORREO_RE, formato: "Correo no válido" });
  if (tiene("direccion")) datos.direccion = opcional(body?.direccion, { max: 200, campo: "direccion", etiqueta: "La dirección" });
  if (Object.hasOwn(body ?? {}, "activo")) {
    if (typeof body.activo !== "boolean") throw invalido("activo debe ser verdadero o falso", { campo: "activo" });
    datos.activo = body.activo;
  }
  return datos;
}

// Quien actúa se relee en el central (no en la réplica del POS): solo roles con PROVEEDOR_GESTIONAR, que en este
// proyecto son el administrador de tienda y el general. El rechazo también se audita.
async function actorDe(idEmpleado) {
  const result = await central.query(
    `select e.id_empleado, e.id_tienda, e.nombre_completo, t.nombre as tienda
     from empleado e
     join tienda t on t.id_tienda = e.id_tienda
     where e.id_empleado = $1 and e.activo = true and e.fecha_baja is null
       and exists (select 1 from rol_permiso rp join permiso p on p.id_permiso = rp.id_permiso
                   where rp.id_rol = e.id_rol and p.codigo = 'PROVEEDOR_GESTIONAR')`,
    [idEmpleado],
  );
  if (result.rowCount === 0) {
    await central.query(
      `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, detalle)
       select $1, 'ACCESO_DENEGADO', 'proveedor', 'PROVEEDOR_GESTIONAR' where exists (select 1 from empleado where id_empleado = $1)`,
      [idEmpleado],
    );
    throw new ErrorNegocio(403, "ACCESO_DENEGADO", "Solo un administrador puede gestionar proveedores");
  }
  return result.rows[0];
}

async function publicar(client, idProveedor) {
  const fila = await client.query(
    "select id_proveedor, nombre_empresa, nit, telefono, correo, direccion, activo from proveedor where id_proveedor = $1",
    [idProveedor],
  );
  await client.query("select append_replica_evento(null, 'PROVEEDOR_UPSERT', 1, $1::jsonb)", [JSON.stringify(fila.rows[0])]);
}

async function auditar(client, actor, accion, idProveedor, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'proveedor', $3, $4)`,
    [actor.id_empleado, accion, idProveedor, `${detalle} (desde ${actor.tienda})`.slice(0, 400)],
  );
}

async function exigirNitLibre(client, nit, salvo = null) {
  const choque = await client.query(
    "select 1 from proveedor where lower(nit) = lower($1) and ($2::int is null or id_proveedor <> $2)",
    [nit, salvo],
  );
  if (choque.rowCount > 0) throw conflicto("NIT_DUPLICADO", "Ya existe un proveedor con ese NIT");
}

// El NIT es único también en la base: si dos altas simultáneas pasan la comprobación, la segunda cae aquí.
const comoConflicto = (error) => (error?.code === "23505" ? conflicto("NIT_DUPLICADO", "Ya existe un proveedor con ese NIT") : error);

const CAMPOS = "id_proveedor, nombre_empresa, nit, telefono, correo, direccion, activo";

// Criterio 1: registrar un proveedor.
export async function crearProveedor(idActor, key, body) {
  const actor = await actorDe(idActor);
  const datos = datosDe(body, { parcial: false });
  return conIdempotencia(central, { key, operacion: "PROVEEDOR_CREAR", idEmpleado: actor.id_empleado, body }, async (client) => {
    await exigirNitLibre(client, datos.nit);
    let creado;
    try {
      creado = await client.query(
        `insert into proveedor (nombre_empresa, nit, telefono, correo, direccion, activo)
         values ($1, $2, $3, $4, $5, $6) returning ${CAMPOS}`,
        [datos.nombre_empresa, datos.nit, datos.telefono, datos.correo, datos.direccion, datos.activo ?? true],
      );
    } catch (error) {
      throw comoConflicto(error);
    }
    const proveedor = creado.rows[0];
    await publicar(client, proveedor.id_proveedor);
    await auditar(client, actor, "PROVEEDOR_CREAR", proveedor.id_proveedor, `${proveedor.nombre_empresa} (NIT ${proveedor.nit})`);
    return { status: 201, body: proveedor };
  });
}

// Criterio 1: editar un proveedor (solo los campos enviados). Desactivarlo no toca las solicitudes ya hechas: solo
// impide generar nuevas.
export async function editarProveedor(idActor, key, idProveedor, body) {
  const actor = await actorDe(idActor);
  const datos = datosDe(body, { parcial: true });
  if (Object.keys(datos).length === 0) throw invalido("No hay campos para actualizar");
  return conIdempotencia(central, { key, operacion: `PROVEEDOR_EDITAR:${idProveedor}`, idEmpleado: actor.id_empleado, body }, async (client) => {
    const actual = await client.query(`select ${CAMPOS} from proveedor where id_proveedor = $1 for update`, [idProveedor]);
    if (actual.rowCount === 0) throw noEncontrado("El proveedor no existe");
    if (datos.nit) await exigirNitLibre(client, datos.nit, idProveedor);
    const anterior = actual.rows[0];
    const cambios = Object.keys(datos).filter((campo) => (datos[campo] ?? null) !== (anterior[campo] ?? null));
    if (cambios.length === 0) return { status: 200, body: anterior };
    const asignaciones = cambios.map((campo, i) => `${campo} = $${i + 2}`).join(", ");
    let editado;
    try {
      editado = await client.query(`update proveedor set ${asignaciones} where id_proveedor = $1 returning ${CAMPOS}`, [
        idProveedor,
        ...cambios.map((campo) => datos[campo]),
      ]);
    } catch (error) {
      throw comoConflicto(error);
    }
    await publicar(client, idProveedor);
    const accion = cambios.length === 1 && cambios[0] === "activo" ? (datos.activo ? "PROVEEDOR_ACTIVAR" : "PROVEEDOR_DESACTIVAR") : "PROVEEDOR_EDITAR";
    await auditar(client, actor, accion, idProveedor, `${anterior.nombre_empresa}: ${cambios.join(", ")}`);
    return { status: 200, body: editado.rows[0] };
  });
}

// Criterio 1: consultar. db: el central (consola) o la base local (POS, también sin conexión). Las tablas son equivalentes.
// En el POS cada proveedor trae sus solicitudes abiertas, para ver de un vistazo con quién se está esperando mercancía.
export async function listarProveedores(db, query = {}) {
  const termino = String(query.q ?? "").trim().toLowerCase();
  if (termino.length > 80) throw invalido("El término admite máximo 80 caracteres", { campo: "q" });
  const patron = `%${termino.replace(/[\\%_]/g, "\\$&")}%`;
  const incluirInactivos = ["1", "true"].includes(String(query.incluir_inactivos ?? ""));
  const esLocal = db === local;
  const tabla = esLocal ? "proveedor_ref" : "proveedor";
  const abiertas = esLocal
    ? `, (select count(*)::int from pedido p where p.id_proveedor = t.id_proveedor and p.estado in ('SOLICITADO', 'ENVIADO', 'RECIBIDO_PARCIAL')) as solicitudes_abiertas`
    : "";
  const filas = await db.query(
    `select t.id_proveedor, t.nombre_empresa, t.nit, t.telefono, t.correo, t.direccion, t.activo${abiertas}
     from ${tabla} t
     where ($2::boolean or t.activo)
       and ($1 = '%%' or lower(t.nombre_empresa) like $1 escape '\\' or lower(coalesce(t.nit, '')) like $1 escape '\\')
     order by t.activo desc, t.nombre_empresa
     limit ${MAX_RESULTADOS}`,
    [patron, incluirInactivos],
  );
  return { proveedores: filas.rows };
}

export async function detalleProveedor(db, idProveedor) {
  const tabla = db === local ? "proveedor_ref" : "proveedor";
  const fila = await db.query(`select ${CAMPOS} from ${tabla} where id_proveedor = $1`, [idProveedor]);
  if (fila.rowCount === 0) throw noEncontrado("El proveedor no existe");
  return fila.rows[0];
}
