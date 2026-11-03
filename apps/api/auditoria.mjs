import { central, local } from "./db.mjs";
import { invalido } from "./errores.mjs";

// HU-07: consulta del registro de auditoría (RNF-10) y subida de la auditoría de cada tienda al central.
// Las tablas son de solo inserción (triggers en db/*/0X_hu07_*.sql): aquí solo se lee y se copia.

const POR_PAGINA = 50;
const ACCION_RE = /^[A-Z_]{3,80}$/;
// Una fila más nueva que esto puede tener vecinas con id menor aún sin confirmar (transacciones en curso):
// se reenvía hasta que se estabiliza y el cursor no la salta. El central descarta los reenvíos.
const ESTABLE = "2 minutes";
const LOTE_SUBIDA = 500;

function instante(valor, campo) {
  if (valor == null || valor === "") return null;
  const fecha = new Date(String(valor));
  if (Number.isNaN(fecha.getTime())) throw invalido("Fecha no válida", { campo });
  return fecha.toISOString();
}

// Filtros comunes. desde/hasta son instantes ISO: el navegador convierte el día local a UTC.
function filtrosDe(query) {
  const usuario = String(query.usuario ?? "").trim();
  if (usuario.length > 60) throw invalido("El usuario admite máximo 60 caracteres", { campo: "usuario" });
  const accion = query.accion ? String(query.accion).trim().toUpperCase() : null;
  if (accion && !ACCION_RE.test(accion)) throw invalido("Tipo de acción no válido", { campo: "accion" });
  const desde = instante(query.desde, "desde");
  const hasta = instante(query.hasta, "hasta");
  if (desde && hasta && desde > hasta) throw invalido("La fecha inicial es posterior a la final", { campo: "desde" });
  const pagina = query.pagina ? Number(query.pagina) : 1;
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 10000) throw invalido("Página no válida", { campo: "pagina" });
  return {
    usuario: usuario ? `%${usuario.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null,
    accion,
    desde,
    hasta,
    pagina,
  };
}

function respuesta(filas, pagina) {
  const total = filas.length > 0 ? Number(filas[0].total) : 0;
  return {
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    registros: filas.map(({ total: _total, ...fila }) => fila),
  };
}

// Auditoría de esta tienda, en su base local: funciona sin conexión con el central.
export async function auditoriaLocal(query) {
  const f = filtrosDe(query);
  const [filas, acciones] = await Promise.all([
    local.query(
      `select r.id_registro, r.fecha_hora, r.accion, r.entidad_afectada, r.id_entidad_afectada, r.detalle,
              e.usuario, e.nombre_completo, count(*) over () as total
       from registro_actividad r
       left join empleado_ref e on e.id_empleado = r.id_empleado
       where ($1::text is null or lower(e.usuario) like $1 escape '\\' or lower(e.nombre_completo) like $1 escape '\\')
         and ($2::text is null or r.accion = $2)
         and ($3::timestamptz is null or r.fecha_hora >= ($3::timestamptz at time zone 'UTC'))
         and ($4::timestamptz is null or r.fecha_hora <= ($4::timestamptz at time zone 'UTC'))
       order by r.fecha_hora desc, r.id_registro desc
       limit ${POR_PAGINA} offset $5`,
      [f.usuario, f.accion, f.desde, f.hasta, (f.pagina - 1) * POR_PAGINA],
    ),
    local.query("select distinct accion from registro_actividad order by accion"),
  ]);
  return { origen: "local", ...respuesta(filas.rows, f.pagina), acciones: acciones.rows.map((row) => row.accion) };
}

// Auditoría de toda la red en el central: lo que registra el central (cuentas, tiendas, logins de la consola)
// y lo que suben las tiendas. tienda = "central" filtra solo lo del central; un número, una tienda.
// Con soloCuentasDe, solo las acciones del central sobre cuentas de esa tienda (vista del admin de tienda).
export async function auditoriaRed(query, { soloCuentasDe = null } = {}) {
  const f = filtrosDe(query);
  let tienda = null;
  let soloCentral = false;
  if (query.tienda === "central") soloCentral = true;
  else if (query.tienda) {
    tienda = Number(query.tienda);
    if (!Number.isInteger(tienda) || tienda < 1) throw invalido("Tienda no válida", { campo: "tienda" });
  }
  const origenes = `
    select 'central'::text as origen, null::int as id_tienda, a.id_registro::bigint as id_registro, a.id_empleado,
           a.accion, a.entidad_afectada, a.id_entidad_afectada, a.fecha_hora, a.detalle
    from registro_actividad_central a
    where ($6::int is null or (a.entidad_afectada = 'empleado'
           and exists (select 1 from empleado o where o.id_empleado = a.id_entidad_afectada and o.id_tienda = $6)))
    union all
    select 'tienda', t.id_tienda, t.id_registro, t.id_empleado, t.accion, t.entidad_afectada, t.id_entidad_afectada, t.fecha_hora, t.detalle
    from auditoria_tienda t
    where $6::int is null`;
  const valores = [f.usuario, f.accion, f.desde, f.hasta, (f.pagina - 1) * POR_PAGINA, soloCuentasDe, tienda, soloCentral];
  const filtro = `
    where ($1::text is null or lower(e.usuario) like $1 escape '\\' or lower(e.nombre_completo) like $1 escape '\\')
      and ($2::text is null or x.accion = $2)
      and ($3::timestamptz is null or x.fecha_hora >= ($3::timestamptz at time zone 'UTC'))
      and ($4::timestamptz is null or x.fecha_hora <= ($4::timestamptz at time zone 'UTC'))
      and ($7::int is null or x.id_tienda = $7)
      and (not $8::boolean or x.origen = 'central')`;
  const [filas, acciones] = await Promise.all([
    central.query(
      `select x.origen, x.id_tienda, ti.nombre as tienda, x.id_registro, x.fecha_hora, x.accion, x.entidad_afectada,
              x.id_entidad_afectada, x.detalle, e.usuario, e.nombre_completo, count(*) over () as total
       from (${origenes}) x
       left join empleado e on e.id_empleado = x.id_empleado
       left join tienda ti on ti.id_tienda = x.id_tienda
       ${filtro}
       order by x.fecha_hora desc, x.origen, x.id_registro desc
       limit ${POR_PAGINA} offset $5`,
      valores,
    ),
    central.query(
      `select accion from registro_actividad_central union select accion from auditoria_tienda order by accion`,
    ),
  ]);
  return { origen: soloCuentasDe ? "cuentas" : "red", ...respuesta(filas.rows, f.pagina), acciones: acciones.rows.map((row) => row.accion) };
}

// Ciclo de sincronización: sube al central la auditoría nueva de esta tienda, en un solo insert por lote.
// Idempotente por (id_tienda, id_registro). El cursor avanza solo sobre filas estables (ver ESTABLE).
export async function subirAuditoria(idTienda) {
  const cursor = await local.query("select ultimo_registro_enviado from auditoria_cursor where id_tienda = $1", [idTienda]);
  const desde = Number(cursor.rows[0]?.ultimo_registro_enviado || 0);
  const filas = await local.query(
    `select id_registro, id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle,
            to_char(fecha_hora, 'YYYY-MM-DD"T"HH24:MI:SS.US') as fecha_hora,
            fecha_hora < now()::timestamp - interval '${ESTABLE}' as estable
     from registro_actividad
     where id_registro > $1
     order by id_registro
     limit ${LOTE_SUBIDA}`,
    [desde],
  );
  if (filas.rowCount === 0) return { enviados: 0, cursor: desde };
  await central.query(
    `insert into auditoria_tienda (id_tienda, id_registro, id_empleado, accion, entidad_afectada, id_entidad_afectada, fecha_hora, detalle)
     select $1, a.id_registro, a.id_empleado, a.accion, a.entidad_afectada, a.id_entidad_afectada, a.fecha_hora::timestamp, a.detalle
     from jsonb_to_recordset($2::jsonb) as a(
       id_registro int, id_empleado int, accion varchar, entidad_afectada varchar, id_entidad_afectada int, fecha_hora text, detalle varchar
     )
     on conflict (id_tienda, id_registro) do nothing`,
    [idTienda, JSON.stringify(filas.rows.map(({ estable: _estable, ...fila }) => fila))],
  );
  let nuevo = desde;
  for (const fila of filas.rows) {
    if (!fila.estable) break;
    nuevo = fila.id_registro;
  }
  if (nuevo > desde) {
    await local.query(
      `insert into auditoria_cursor (id_tienda, ultimo_registro_enviado, enviado_en) values ($1, $2, now())
       on conflict (id_tienda) do update set ultimo_registro_enviado = excluded.ultimo_registro_enviado, enviado_en = now()`,
      [idTienda, nuevo],
    );
  }
  return { enviados: filas.rowCount, cursor: nuevo };
}
