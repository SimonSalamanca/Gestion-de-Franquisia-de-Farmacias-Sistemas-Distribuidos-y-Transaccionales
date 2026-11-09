import { central, local } from "./db.mjs";
import { invalido } from "./errores.mjs";
import { link } from "./sync.mjs";
import { evaluarAlertas } from "./alertas.mjs";
import { etiquetaMetodo } from "./ventas.mjs";
import { frescuraDe } from "./frescura.mjs";

// HU-05: reportes y estadísticas. Dos reportes, cada uno en su nodo:
// - Tienda (local): ventas, métodos de pago, devoluciones, más vendidos, por día e inventario crítico. Funciona sin
//   conexión con el central (RNF-04).
// - Red (central): comparativo de ventas e indicadores de stock por tienda activa, con la hora de la última
//   sincronización de cada una (RNF-13).
// Solo lectura y agregación en SQL: una consulta por bloque, porque cada ida y vuelta a Neon cuesta ~130 ms (RNF-05).
// Los días son de calendario UTC, el mismo criterio con que HU-08 y HU-10 consolidan en el central.

export const MAX_DIAS = 366;
const DIA_MS = 86_400_000;
const MAX_CRITICOS = 100;
const MAX_LOTES_CADUCIDAD = 300;
const TOP_PRODUCTOS = 10;

function fechaIso(valor, campo) {
  const texto = String(valor ?? "").trim();
  const fecha = new Date(`${texto}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== texto) {
    throw invalido("Fecha no válida: use AAAA-MM-DD", { campo });
  }
  return fecha;
}

// Periodo inclusivo [desde, hasta]. Por defecto, el mes en curso hasta hoy.
export function periodoDe(query = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const desdeTxt = query.desde || `${hoy.slice(0, 8)}01`;
  const hastaTxt = query.hasta || hoy;
  const desde = fechaIso(desdeTxt, "desde");
  const hasta = fechaIso(hastaTxt, "hasta");
  if (desde > hasta) throw invalido("La fecha inicial es posterior a la final", { campo: "desde" });
  const dias = (hasta - desde) / DIA_MS + 1;
  if (dias > MAX_DIAS) throw invalido(`El periodo no puede superar ${MAX_DIAS} días`, { campo: "hasta" });
  return { desde: desdeTxt, hasta: hastaTxt, dias, zona: "UTC" };
}

// Ventas de la tienda. Brutas: facturas del periodo en cualquier estado. Devoluciones: notas de HU-10 del periodo,
// en el día de la nota (igual que el central). Netos = brutos − devoluciones.
const VENTAS_SQL = `
with f as (
  select id_factura, fecha_hora::date as dia from factura
  where fecha_hora >= $1::date and fecha_hora < $2::date + 1
), lineas as (
  select f.dia, l.id_medicamento, d.cantidad, d.subtotal_linea + coalesce(d.impuesto_linea, 0) as importe
  from f join detalle_factura d on d.id_factura = f.id_factura join lote l on l.id_lote = d.id_lote
), n as (
  select id_anulacion, fecha_hora::date as dia from anulacion_devolucion
  where fecha_hora >= $1::date and fecha_hora < $2::date + 1
), dev as (
  select n.dia, l.id_medicamento, dd.cantidad_devuelta as cantidad, dd.subtotal_devuelto + dd.impuesto_devuelto as importe
  from n join detalle_devolucion dd on dd.id_anulacion = n.id_anulacion join lote l on l.id_lote = dd.id_lote
), pv as (
  select fp.id_metodo_pago, sum(fp.monto) as monto, count(*) as facturas
  from f join factura_metodo_pago fp on fp.id_factura = f.id_factura group by fp.id_metodo_pago
), pd as (
  select dp.id_metodo_pago, sum(dp.monto) as monto, count(*) as notas
  from n join devolucion_pago dp on dp.id_anulacion = n.id_anulacion group by dp.id_metodo_pago
), prod as (
  select id_medicamento, sum(vend) as vendidas, sum(devu) as devueltas, sum(imp) as ingresos
  from (
    select id_medicamento, cantidad as vend, 0 as devu, importe as imp from lineas
    union all
    select id_medicamento, 0, cantidad, -importe from dev
  ) x group by id_medicamento
), dias as (
  select d::date as dia from generate_series($1::date, $2::date, interval '1 day') d
)
select jsonb_build_object(
  'facturas', (select count(*) from f),
  'unidades_vendidas', (select coalesce(sum(cantidad), 0) from lineas),
  'ingresos_brutos', (select coalesce(sum(monto), 0) from pv),
  'notas', (select count(*) from n),
  'unidades_devueltas', (select coalesce(sum(cantidad), 0) from dev),
  'reintegros', (select coalesce(sum(monto), 0) from pd),
  'por_metodo', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id_metodo_pago', m.id_metodo_pago, 'codigo', m.nombre,
             'ingresos', coalesce(pv.monto, 0), 'facturas', coalesce(pv.facturas, 0),
             'reintegros', coalesce(pd.monto, 0), 'notas', coalesce(pd.notas, 0),
             'ingresos_netos', coalesce(pv.monto, 0) - coalesce(pd.monto, 0)
           ) order by coalesce(pv.monto, 0) - coalesce(pd.monto, 0) desc, m.nombre), '[]'::jsonb)
    from metodo_pago_ref m
    left join pv on pv.id_metodo_pago = m.id_metodo_pago
    left join pd on pd.id_metodo_pago = m.id_metodo_pago
    where pv.id_metodo_pago is not null or pd.id_metodo_pago is not null
  ),
  'mas_vendidos', (
    select coalesce(jsonb_agg(t order by t.unidades_netas desc, t.ingresos_netos desc), '[]'::jsonb)
    from (
      select m.id_medicamento, m.codigo_interno, m.nombre_comercial,
             p.vendidas as unidades_vendidas, p.devueltas as unidades_devueltas,
             p.vendidas - p.devueltas as unidades_netas, p.ingresos as ingresos_netos
      from prod p join medicamento_ref m on m.id_medicamento = p.id_medicamento
      where p.vendidas - p.devueltas > 0
      order by p.vendidas - p.devueltas desc, p.ingresos desc, m.nombre_comercial
      limit ${TOP_PRODUCTOS}
    ) t
  ),
  'por_dia', (
    select jsonb_agg(jsonb_build_object(
             'dia', to_char(dias.dia, 'YYYY-MM-DD'),
             'unidades', coalesce(v.unidades, 0) - coalesce(r.unidades, 0),
             'ingresos', coalesce(v.importe, 0) - coalesce(r.importe, 0)
           ) order by dias.dia)
    from dias
    left join (select dia, sum(cantidad) as unidades, sum(importe) as importe from lineas group by dia) v on v.dia = dias.dia
    left join (select dia, sum(cantidad) as unidades, sum(importe) as importe from dev group by dia) r on r.dia = dias.dia
  )
) as ventas`;

// Inventario crítico (criterio 2): las alertas de stock de HU-04 y los lotes con unidades que caducan en 90 días o
// menos (o ya vencidos), por tramos. Mismas reglas que el panel de alertas.
const INVENTARIO_SQL = `
with cad as (
  select l.id_lote, l.numero_lote, l.fecha_caducidad, l.cantidad_disponible, l.estado,
         l.fecha_caducidad - current_date as dias,
         case when l.fecha_caducidad < current_date then 'VENCIDO'
              when l.fecha_caducidad <= current_date + 7 then 'HASTA_7'
              when l.fecha_caducidad <= current_date + 30 then 'HASTA_30'
              else 'HASTA_90' end as tramo,
         m.id_medicamento, m.codigo_interno, m.nombre_comercial
  from lote l join medicamento_ref m on m.id_medicamento = l.id_medicamento
  where l.cantidad_disponible > 0 and l.fecha_caducidad <= current_date + 90
)
select jsonb_build_object(
  'alertas_por_tipo', (
    select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'nivel', nivel, 'total', total) order by tipo, nivel), '[]'::jsonb)
    from (select tipo, nivel, count(*) as total from alerta where estado = 'ACTIVA' group by tipo, nivel) a
  ),
  'criticos', (
    select coalesce(jsonb_agg(c order by c.orden, c.prioridad, c.nombre_comercial), '[]'::jsonb)
    from (
      select a.tipo, a.nivel, case a.nivel when 'CRITICA' then 0 when 'ALTA' then 1 else 2 end as orden, a.prioridad,
             m.id_medicamento, m.codigo_interno, m.nombre_comercial,
             coalesce((a.detalle->>'stock')::int, 0) as stock, (a.detalle->>'stock_minimo')::int as stock_minimo
      from alerta a join medicamento_ref m on m.id_medicamento = a.id_medicamento
      where a.estado = 'ACTIVA' and a.tipo in ('STOCK_AGOTADO', 'STOCK_BAJO')
      order by orden, a.prioridad, m.nombre_comercial
      limit ${MAX_CRITICOS}
    ) c
  ),
  'tramos', (
    select coalesce(jsonb_agg(jsonb_build_object('tramo', tramo, 'lotes', lotes, 'unidades', unidades)), '[]'::jsonb)
    from (select tramo, count(*) as lotes, sum(cantidad_disponible) as unidades from cad group by tramo) t
  ),
  'lotes', (
    select coalesce(jsonb_agg(c order by c.fecha_caducidad, c.id_lote), '[]'::jsonb)
    from (
      select id_lote, numero_lote, to_char(fecha_caducidad, 'YYYY-MM-DD') as fecha_caducidad, cantidad_disponible,
             estado, dias, tramo, id_medicamento, codigo_interno, nombre_comercial
      from cad order by fecha_caducidad, id_lote limit ${MAX_LOTES_CADUCIDAD}
    ) c
  )
) as inventario`;

const TRAMOS = ["VENCIDO", "HASTA_7", "HASTA_30", "HASTA_90"];

// Con un pool, las consultas van en paralelo; con un cliente (una transacción, como en las pruebas), en serie: un cliente
// de pg no admite consultas simultáneas.
export async function todas(db, consultas) {
  if ("totalCount" in db) return Promise.all(consultas.map((c) => c()));
  const resultados = [];
  for (const c of consultas) resultados.push(await c());
  return resultados;
}


export async function reporteTienda(query, db = local) {
  const periodo = periodoDe(query);
  // Igual que el panel de HU-04: se evalúa antes, para no mostrar un estado viejo. Si falla, se usa lo último calculado.
  await evaluarAlertas().catch((error) => console.error("reportes: alertas", error.message));
  const [ventas, inventario] = await todas(db, [
    () => db.query(VENTAS_SQL, [periodo.desde, periodo.hasta]),
    () => db.query(INVENTARIO_SQL),
  ]);
  const v = ventas.rows[0].ventas;
  const inv = inventario.rows[0].inventario;
  const tramos = Object.fromEntries(TRAMOS.map((t) => [t, { lotes: 0, unidades: 0 }]));
  for (const t of inv.tramos) tramos[t.tramo] = { lotes: t.lotes, unidades: t.unidades };
  return {
    periodo,
    generado_en: new Date().toISOString(),
    ventas: {
      ...v,
      unidades_netas: v.unidades_vendidas - v.unidades_devueltas,
      ingresos_netos: redondear(v.ingresos_brutos - v.reintegros),
      ticket_promedio: v.facturas ? redondear(v.ingresos_brutos / v.facturas) : 0,
      por_metodo: v.por_metodo.map((m) => ({ ...m, metodo: etiquetaMetodo(m.codigo) })),
    },
    inventario: {
      alertas_por_tipo: inv.alertas_por_tipo,
      criticos: inv.criticos.map(({ orden, prioridad, ...c }) => c),
      caducidad: { tramos, lotes: inv.lotes, lotes_truncados: inv.lotes.length === MAX_LOTES_CADUCIDAD },
    },
  };
}

// Comparativo de red. venta_consolidada ya trae las devoluciones restadas (HU-10); total_facturas cuenta la factura
// en cada método con que se pagó, así que el total de facturas de una tienda puede superar sus ventas reales cuando
// hubo pagos combinados (se aclara en la pantalla).
const RED_SQL = `
with v as (
  select id_tienda, id_metodo_pago, sum(total_vendido) as ingresos, sum(total_facturas) as facturas
  from venta_consolidada where fecha between $1::date and $2::date
  group by id_tienda, id_metodo_pago
), vt as (
  select v.id_tienda, sum(v.ingresos) as ingresos, sum(v.facturas) as facturas,
         jsonb_agg(jsonb_build_object('id_metodo_pago', v.id_metodo_pago, 'codigo', mp.nombre, 'ingresos', v.ingresos, 'facturas', v.facturas)
                   order by v.ingresos desc) as metodos
  from v join metodo_pago mp on mp.id_metodo_pago = v.id_metodo_pago
  group by v.id_tienda
), ult as (
  select id_tienda, max(fecha_sincronizacion) as sync from venta_consolidada group by id_tienda
), s as (
  select i.id_tienda,
         count(*) filter (where i.cantidad_disponible <= 0) as agotados,
         count(*) filter (where i.cantidad_disponible > 0 and i.cantidad_disponible <= u.stock_minimo) as bajo_minimo,
         count(*) as con_reporte,
         max(i.fecha_sincronizacion) as sync
  from inventario_consolidado i
  join medicamento m on m.id_medicamento = i.id_medicamento and m.activo
  left join umbral_stock u on u.id_tienda = i.id_tienda and u.id_medicamento = i.id_medicamento
  group by i.id_tienda
), activos as (
  select count(*) as total from medicamento where activo
)
select t.id_tienda, t.nombre, t.ciudad,
       coalesce(vt.ingresos, 0)::float8 as ingresos, coalesce(vt.facturas, 0)::int as facturas,
       coalesce(vt.metodos, '[]'::jsonb) as metodos,
       vt.id_tienda is not null as con_ventas, ult.sync as ultima_sync_ventas,
       coalesce(s.agotados, 0)::int as agotados, coalesce(s.bajo_minimo, 0)::int as bajo_minimo,
       greatest(activos.total - coalesce(s.con_reporte, 0), 0)::int as sin_reporte,
       s.sync as ultima_sync_stock,
       now()::timestamp as ahora
from tienda t
cross join activos
left join vt on vt.id_tienda = t.id_tienda
left join ult on ult.id_tienda = t.id_tienda
left join s on s.id_tienda = t.id_tienda
where t.activa = true
order by coalesce(vt.ingresos, 0) desc, t.nombre`;

export async function comparativoRed(query, db = central) {
  const periodo = periodoDe(query);
  const filas = (await db.query(RED_SQL, [periodo.desde, periodo.hasta])).rows;
  const totalIngresos = filas.reduce((s, f) => s + f.ingresos, 0);
  const totalFacturas = filas.reduce((s, f) => s + f.facturas, 0);
  const metodos = new Map();
  const tiendas = filas.map((f) => {
    const porMetodo = f.metodos.map((m) => ({ ...m, metodo: etiquetaMetodo(m.codigo) }));
    for (const m of porMetodo) metodos.set(m.id_metodo_pago, m.metodo);
    return {
      ...f,
      ingresos: redondear(f.ingresos),
      metodos: porMetodo,
      ticket_promedio: f.facturas ? redondear(f.ingresos / f.facturas) : 0,
      participacion: totalIngresos > 0 ? redondear((f.ingresos / totalIngresos) * 100) : 0,
      // Nunca consolidó ventas (distinto de "no vendió en el periodo").
      sin_datos: f.ultima_sync_ventas == null,
      // HU-16: si la tienda no envió su información reciente, el comparativo lo dice (RNF-13).
      frescura: frescuraDe(f.ultima_sync_stock, f.ultima_sync_ventas, f.ahora),
    };
  });
  return {
    periodo,
    generado_en: new Date().toISOString(),
    ultima_sync: link.ultimaSync,
    totales: {
      ingresos: redondear(totalIngresos),
      facturas: totalFacturas,
      ticket_promedio: totalFacturas ? redondear(totalIngresos / totalFacturas) : 0,
      tiendas: tiendas.length,
    },
    metodos: [...metodos].map(([id_metodo_pago, metodo]) => ({ id_metodo_pago, metodo })),
    tiendas,
  };
}

function redondear(n) {
  return Math.round(Number(n) * 100) / 100;
}
