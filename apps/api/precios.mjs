import { central, local } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";

// HU-03: precio de red de cada medicamento con historial de vigencia (RF-02, regla de negocio 9).
// Un solo precio para toda la cadena. El central es el dueño (precio_medicamento): toda escritura va a su base
// con su auditoría y un PRECIO_UPSERT por cada fila que cambia. Las tiendas guardan el historial completo
// (precio_ref), con los precios programados, así que consultan y cobran el precio correcto sin conexión.
// Desde el POS, registrar exige conexión (503, igual que HU-07): las rutas lo envuelven con enCentral.

// Tolerancia para "ahora": la hora del navegador puede ir unos segundos atrás de la de la base.
const TOLERANCIA = "2 minutes";
const PRECIO_RE = /^\d{1,10}(\.\d{1,2})?$/;
const MAX_RESULTADOS = 50;

function precioDe(valor) {
  const texto = String(valor ?? "").trim().replace(",", ".");
  if (!PRECIO_RE.test(texto) || Number(texto) <= 0) {
    throw invalido("El precio debe ser mayor que cero, con máximo dos decimales", { campo: "precio" });
  }
  return texto;
}

function instanteDe(valor) {
  if (valor == null || valor === "") return null;
  const fecha = new Date(String(valor));
  if (Number.isNaN(fecha.getTime())) throw invalido("Fecha de inicio no válida", { campo: "desde" });
  return fecha.toISOString();
}

const entero = (valor, campo) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw invalido(`${campo} no válido`, { campo });
  return n;
};

// Quien registra se relee en el central (no en la réplica del POS): solo roles con PRECIO_GESTIONAR,
// que en este proyecto son el administrador de tienda y el administrador general (criterio 4).
async function actorDe(idEmpleado) {
  const result = await central.query(
    `select e.id_empleado, e.id_tienda, e.nombre_completo, t.nombre as tienda
     from empleado e
     join tienda t on t.id_tienda = e.id_tienda
     where e.id_empleado = $1 and e.activo = true and e.fecha_baja is null
       and exists (select 1 from rol_permiso rp join permiso p on p.id_permiso = rp.id_permiso
                   where rp.id_rol = e.id_rol and p.codigo = 'PRECIO_GESTIONAR')`,
    [idEmpleado],
  );
  if (result.rowCount === 0) {
    // La réplica del POS puede ir atrasada: el central es quien decide, y su rechazo también se audita.
    await central.query(
      `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, detalle)
       select $1, 'ACCESO_DENEGADO', 'medicamento', 'PRECIO_GESTIONAR' where exists (select 1 from empleado where id_empleado = $1)`,
      [idEmpleado],
    );
    throw new ErrorNegocio(403, "ACCESO_DENEGADO", "Solo un administrador puede modificar precios");
  }
  return result.rows[0];
}

// El inicio pedido, ya validado contra now() de la base: no puede quedar en el pasado. Si viene vacío o
// dentro de la tolerancia, rige desde ahora mismo (now() de esta transacción).
// Se devuelve como texto: un Date de JavaScript pierde los microsegundos y "ahora" quedaría una fracción
// antes de now(), con lo que el fin del precio anterior parecería pasado y el trigger lo rechazaría.
async function inicioDe(client, desde) {
  const result = await client.query(
    `select (case
              when $1::timestamptz is null then now()::timestamp
              when ($1::timestamptz at time zone 'UTC') < now()::timestamp - interval '${TOLERANCIA}' then null
              else greatest($1::timestamptz at time zone 'UTC', now()::timestamp)
            end)::text as inicio`,
    [desde],
  );
  if (result.rows[0].inicio == null) {
    throw invalido("La fecha de inicio no puede estar en el pasado: el historial refleja lo que realmente rigió", { campo: "desde" });
  }
  return result.rows[0].inicio;
}

// Cierra cada periodo con el inicio del siguiente. Devuelve las filas que cambiaron (para publicarlas).
// El trigger del central impide que esto altere un periodo que ya terminó.
async function recalcularFines(client, idMedicamento) {
  const cambiadas = await client.query(
    `update precio_medicamento p set fecha_fin_vigencia = s.siguiente
     from (
       select id_precio, lead(fecha_inicio_vigencia) over (order by fecha_inicio_vigencia) as siguiente
       from precio_medicamento where id_medicamento = $1
     ) s
     where p.id_precio = s.id_precio and p.fecha_fin_vigencia is distinct from s.siguiente
     returning p.id_precio`,
    [idMedicamento],
  );
  return cambiadas.rows.map((row) => row.id_precio);
}

async function publicar(client, idsPrecio) {
  if (idsPrecio.length === 0) return;
  const filas = await client.query(
    `select p.id_precio, p.id_medicamento, p.precio, p.fecha_inicio_vigencia, p.fecha_fin_vigencia, p.id_empleado_registro,
            e.nombre_completo as registrado_por
     from precio_medicamento p left join empleado e on e.id_empleado = p.id_empleado_registro
     where p.id_precio = any($1::int[])
     order by p.fecha_inicio_vigencia`,
    [[...new Set(idsPrecio)]],
  );
  for (const fila of filas.rows) {
    await client.query("select append_replica_evento(null, 'PRECIO_UPSERT', 1, $1::jsonb)", [JSON.stringify(fila)]);
  }
}

async function auditar(client, actor, accion, idMedicamento, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'medicamento', $3, $4)`,
    [actor.id_empleado, accion, idMedicamento, `${detalle} (desde ${actor.tienda})`.slice(0, 400)],
  );
}

// Serializa los cambios de precio de un medicamento (dos administradores a la vez) y valida que exista.
async function bloquearMedicamento(client, idMedicamento) {
  const med = await client.query(
    "select id_medicamento, codigo_interno, nombre_comercial from medicamento where id_medicamento = $1 for update",
    [idMedicamento],
  );
  if (med.rowCount === 0) throw noEncontrado("El medicamento no existe");
  return med.rows[0];
}

async function exigirInicioLibre(client, idMedicamento, inicio, salvo = null) {
  const choque = await client.query(
    "select 1 from precio_medicamento where id_medicamento = $1 and fecha_inicio_vigencia = $2 and ($3::int is null or id_precio <> $3)",
    [idMedicamento, inicio, salvo],
  );
  if (choque.rowCount > 0) throw conflicto("PRECIO_DUPLICADO", "Ya hay un precio que empieza en ese mismo instante");
}

const pesos = (valor) => `$${Number(valor).toLocaleString("es-CO", { maximumFractionDigits: 2 })}`;

// Criterio 1: nuevo precio con la fecha desde la cual rige (ahora o futura).
export async function registrarPrecio(idActor, key, idMedicamento, body) {
  const actor = await actorDe(idActor);
  const precio = precioDe(body.precio);
  const desde = instanteDe(body.desde);
  return conIdempotencia(central, { key, operacion: `PRECIO_REGISTRAR:${idMedicamento}`, idEmpleado: actor.id_empleado, body }, async (client) => {
    const med = await bloquearMedicamento(client, idMedicamento);
    const inicio = await inicioDe(client, desde);
    await exigirInicioLibre(client, idMedicamento, inicio);
    const creado = await client.query(
      `insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia, id_empleado_registro)
       values ($1, $2, $3, $4) returning id_precio`,
      [idMedicamento, precio, inicio, actor.id_empleado],
    );
    const id = creado.rows[0].id_precio;
    const cambiadas = await recalcularFines(client, idMedicamento);
    await publicar(client, [id, ...cambiadas]);
    await auditar(client, actor, "PRECIO_REGISTRAR", idMedicamento, `${med.codigo_interno}: ${pesos(precio)} desde ${String(inicio).slice(0, 19)} UTC`);
    return { status: 201, body: { id_precio: id, ...(await historial(client, idMedicamento)) } };
  });
}

// Corregir un precio programado que aún no rige (nunca se cobró). Uno que ya rigió no se toca.
export async function corregirPrecio(idActor, key, idPrecio, body) {
  const actor = await actorDe(idActor);
  const precio = precioDe(body.precio);
  const desde = instanteDe(body.desde);
  return conIdempotencia(central, { key, operacion: `PRECIO_CORREGIR:${idPrecio}`, idEmpleado: actor.id_empleado, body }, async (client) => {
    const actual = await client.query("select id_medicamento from precio_medicamento where id_precio = $1", [idPrecio]);
    if (actual.rowCount === 0) throw noEncontrado("El precio no existe");
    const idMedicamento = actual.rows[0].id_medicamento;
    const med = await bloquearMedicamento(client, idMedicamento);
    const fila = await client.query(
      "select precio, fecha_inicio_vigencia::text as fecha_inicio_vigencia, fecha_inicio_vigencia > now()::timestamp as programado from precio_medicamento where id_precio = $1",
      [idPrecio],
    );
    if (!fila.rows[0].programado) {
      throw conflicto("PRECIO_EN_VIGOR", "Este precio ya empezó a regir y forma parte del historial. Registre un precio nuevo.");
    }
    const inicio = desde ? await inicioDe(client, desde) : fila.rows[0].fecha_inicio_vigencia;
    await exigirInicioLibre(client, idMedicamento, inicio, idPrecio);
    await client.query(
      "update precio_medicamento set precio = $2, fecha_inicio_vigencia = $3, id_empleado_registro = $4 where id_precio = $1",
      [idPrecio, precio, inicio, actor.id_empleado],
    );
    const cambiadas = await recalcularFines(client, idMedicamento);
    await publicar(client, [idPrecio, ...cambiadas]);
    await auditar(
      client,
      actor,
      "PRECIO_REPROGRAMAR",
      idMedicamento,
      `${med.codigo_interno}: precio #${idPrecio} ${pesos(fila.rows[0].precio)} → ${pesos(precio)} desde ${String(inicio).slice(0, 19)} UTC`,
    );
    return { status: 200, body: await historial(client, idMedicamento) };
  });
}

// Criterio 5: el historial con cada precio, su inicio y fin, quién lo registró y su estado.
// db: el central (consola) o la base local (POS, también sin conexión). Las tablas son equivalentes.
export async function historial(db, idMedicamento) {
  const tabla = db === local ? "precio_ref" : "precio_medicamento";
  const medicamentos = db === local ? "medicamento_ref" : "medicamento";
  const med = await db.query(
    `select id_medicamento, codigo_interno, nombre_comercial, principio_activo from ${medicamentos} where id_medicamento = $1`,
    [idMedicamento],
  );
  if (med.rowCount === 0) throw noEncontrado("El medicamento no existe");
  const quien = db === local ? "p.registrado_por" : "e.nombre_completo";
  const union = db === local ? "" : "left join empleado e on e.id_empleado = p.id_empleado_registro";
  const filas = await db.query(
    `select p.id_precio, p.precio, p.fecha_inicio_vigencia, p.fecha_fin_vigencia, ${quien} as registrado_por,
            case
              when p.fecha_inicio_vigencia > now()::timestamp then 'PROGRAMADO'
              when p.fecha_fin_vigencia is null or p.fecha_fin_vigencia > now()::timestamp then 'VIGENTE'
              else 'ANTERIOR'
            end as estado
     from ${tabla} p ${union}
     where p.id_medicamento = $1
     order by p.fecha_inicio_vigencia desc`,
    [idMedicamento],
  );
  const vigente = filas.rows.find((fila) => fila.estado === "VIGENTE") || null;
  return { medicamento: med.rows[0], vigente, historial: filas.rows };
}

// Medicamentos con su precio vigente y el próximo programado, para elegir cuál consultar o cambiar.
export async function listarPrecios(db, query = {}) {
  const termino = String(query.q ?? "").trim().toLowerCase();
  if (termino.length > 80) throw invalido("El término admite máximo 80 caracteres", { campo: "q" });
  const tabla = db === local ? "precio_ref" : "precio_medicamento";
  const medicamentos = db === local ? "medicamento_ref" : "medicamento";
  const patron = `%${termino.replace(/[\\%_]/g, "\\$&")}%`;
  const filas = await db.query(
    `select m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo,
            (select precio from ${tabla} p where p.id_medicamento = m.id_medicamento and p.fecha_inicio_vigencia <= now()::timestamp
             order by p.fecha_inicio_vigencia desc limit 1) as precio_vigente,
            -- Dentro de un JSON el timestamp sale sin zona y el navegador lo leería como hora local: va con Z.
            (select json_build_object('precio', p.precio, 'desde', to_char(p.fecha_inicio_vigencia, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             from ${tabla} p
             where p.id_medicamento = m.id_medicamento and p.fecha_inicio_vigencia > now()::timestamp
             order by p.fecha_inicio_vigencia limit 1) as proximo
     from ${medicamentos} m
     where m.activo = true
       and ($1 = '%%' or lower(m.nombre_comercial) like $1 escape '\\' or lower(m.principio_activo) like $1 escape '\\'
            or lower(m.codigo_interno) like $1 escape '\\')
     order by m.nombre_comercial
     limit ${MAX_RESULTADOS}`,
    [patron],
  );
  return { medicamentos: filas.rows.map((fila) => ({ ...fila, id_medicamento: Number(fila.id_medicamento) })) };
}

export const idMedicamentoDe = (valor) => entero(valor, "id_medicamento");
export const idPrecioDe = (valor) => entero(valor, "id_precio");
