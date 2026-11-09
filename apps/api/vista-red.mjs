import { central } from "./db.mjs";
import { config } from "./config.mjs";
import { invalido, noEncontrado } from "./errores.mjs";
import { link } from "./sync.mjs";
import { periodoDe, todas } from "./reportes.mjs";
import { etiquetaMetodo } from "./ventas.mjs";
import { estadoStock } from "./inventario/stock.mjs";
import { frescuraDe } from "./frescura.mjs";

// HU-16: vista consolidada de la red (RED_VISIBILIDAD, nodo central). Todo sale de lo que las tiendas consolidan en el
// central; cada tienda lleva su frescura: la hora de su última foto de stock, que llega cada 2 minutos aunque no haya
// movimientos (consolidación periódica), comparada con la hora del central. Nunca se muestra un número sin su hora.

const POR_PAGINA = 50;
const NORM = (columna) => `translate(lower(${columna}), 'áéíóúüñ', 'aeiouun')`;
const normalizar = (texto) => texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const redondear = (n) => Math.round(Number(n) * 100) / 100;

function entero(valor, campo, minimo) {
  if (valor == null || valor === "") return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < minimo) throw invalido(`${campo} no válida`, { campo });
  return n;
}

// Filtros comunes. tienda: una tienda activa. categoria: 0 = sin categoría.
async function filtrosDe(query, db) {
  const tienda = entero(query.tienda, "tienda", 1);
  const categoria = entero(query.categoria, "categoria", 0);
  const existe = await db.query(
    `select ($1::int is null or exists (select 1 from tienda where id_tienda = $1 and activa)) as tienda,
            ($2::int is null or $2 = 0 or exists (select 1 from categoria where id_categoria = $2)) as categoria`,
    [tienda, categoria],
  );
  if (!existe.rows[0].tienda) throw noEncontrado("La tienda no existe o está desactivada");
  if (!existe.rows[0].categoria) throw noEncontrado("La categoría no existe");
  return { tienda, categoria };
}

const SQL_TIENDAS = `
select t.id_tienda, t.nombre, t.ciudad,
       (select max(i.fecha_sincronizacion) from inventario_consolidado i where i.id_tienda = t.id_tienda) as ultima_foto,
       (select max(v.fecha_sincronizacion) from venta_consolidada v where v.id_tienda = t.id_tienda) as ultima_venta,
       (select to_char(min(c.fecha), 'YYYY-MM-DD') from venta_categoria_consolidada c where c.id_tienda = t.id_tienda) as categorias_desde,
       now()::timestamp as ahora
from tienda t
where t.activa and ($1::int is null or t.id_tienda = $1)
order by t.nombre`;

const SQL_VENTAS = `
select v.id_tienda, v.id_metodo_pago, mp.nombre as codigo, sum(v.total_vendido)::float8 as ingresos, sum(v.total_facturas)::int as facturas
from venta_consolidada v
join tienda t on t.id_tienda = v.id_tienda and t.activa
join metodo_pago mp on mp.id_metodo_pago = v.id_metodo_pago
where v.fecha between $1::date and $2::date and ($3::int is null or v.id_tienda = $3)
group by v.id_tienda, v.id_metodo_pago, mp.nombre`;

const SQL_CATEGORIAS = `
select v.id_tienda, v.id_categoria, coalesce(c.nombre, 'Sin categoría') as categoria,
       sum(v.unidades)::int as unidades, sum(v.ingresos)::float8 as ingresos
from venta_categoria_consolidada v
join tienda t on t.id_tienda = v.id_tienda and t.activa
left join categoria c on c.id_categoria = v.id_categoria
where v.fecha between $1::date and $2::date and ($3::int is null or v.id_tienda = $3) and ($4::int is null or v.id_categoria = $4)
group by v.id_tienda, v.id_categoria, c.nombre`;

// Inventario por tienda con la misma regla de HU-01: agotado <= 0, bajo <= mínimo. "Sin reporte": productos activos
// (de la categoría) de los que la tienda no envió stock.
const SQL_INVENTARIO = `
with med as (
  select id_medicamento from medicamento where activo and ($2::int is null or coalesce(id_categoria, 0) = $2)
)
select t.id_tienda,
       coalesce(sum(i.cantidad_disponible), 0)::int as unidades,
       count(i.id_medicamento)::int as con_reporte,
       (count(*) filter (where i.cantidad_disponible <= 0))::int as agotados,
       (count(*) filter (where i.cantidad_disponible > 0 and i.cantidad_disponible <= u.stock_minimo))::int as bajo_minimo,
       ((select count(*) from med) - count(i.id_medicamento))::int as sin_reporte
from tienda t
left join (inventario_consolidado i join med on med.id_medicamento = i.id_medicamento) on i.id_tienda = t.id_tienda
left join umbral_stock u on u.id_tienda = i.id_tienda and u.id_medicamento = i.id_medicamento
where t.activa and ($1::int is null or t.id_tienda = $1)
group by t.id_tienda`;

export async function vistaConsolidada(query, db = central) {
  const periodo = periodoDe(query);
  const { tienda, categoria } = await filtrosDe(query, db);
  const [tiendas, ventas, categorias, inventario] = await todas(db, [
    () => db.query(SQL_TIENDAS, [tienda]),
    () => db.query(SQL_VENTAS, [periodo.desde, periodo.hasta, tienda]),
    () => db.query(SQL_CATEGORIAS, [periodo.desde, periodo.hasta, tienda, categoria]),
    () => db.query(SQL_INVENTARIO, [tienda, categoria]),
  ]);

  const porTienda = (filas) => {
    const mapa = new Map();
    for (const f of filas) mapa.set(f.id_tienda, [...(mapa.get(f.id_tienda) ?? []), f]);
    return mapa;
  };
  const ventasDe = porTienda(ventas.rows);
  const categoriasDe = porTienda(categorias.rows);
  const inventarioDe = new Map(inventario.rows.map((f) => [f.id_tienda, f]));
  const metodos = new Map();
  const totalCategorias = new Map();

  const filas = tiendas.rows.map((t) => {
    const frescura = frescuraDe(t.ultima_foto, t.ultima_venta, t.ahora);
    const vs = ventasDe.get(t.id_tienda) ?? [];
    const cs = categoriasDe.get(t.id_tienda) ?? [];
    for (const v of vs) metodos.set(v.id_metodo_pago, etiquetaMetodo(v.codigo));
    for (const c of cs) {
      const acum = totalCategorias.get(c.id_categoria) ?? { id_categoria: c.id_categoria, categoria: c.categoria, unidades: 0, ingresos: 0 };
      acum.unidades += c.unidades;
      acum.ingresos += c.ingresos;
      totalCategorias.set(c.id_categoria, acum);
    }
    const unidades = cs.reduce((s, c) => s + c.unidades, 0);
    const ingresosCategoria = cs.reduce((s, c) => s + c.ingresos, 0);
    // Con una categoría elegida, ventas e ingresos salen de venta_categoria_consolidada (sin facturas: una factura puede
    // tener varias categorías). Sin categoría, de venta_consolidada, que incluye las ventas anteriores a HU-16.
    const ingresos = categoria == null ? vs.reduce((s, v) => s + v.ingresos, 0) : ingresosCategoria;
    const facturas = categoria == null ? vs.reduce((s, v) => s + v.facturas, 0) : null;
    const inv = inventarioDe.get(t.id_tienda) ?? { unidades: 0, con_reporte: 0, agotados: 0, bajo_minimo: 0, sin_reporte: 0 };
    return {
      id_tienda: t.id_tienda,
      nombre: t.nombre,
      ciudad: t.ciudad,
      frescura,
      categorias_desde: t.categorias_desde,
      ventas: {
        ingresos: redondear(ingresos),
        facturas,
        unidades,
        ticket_promedio: facturas ? redondear(ingresos / facturas) : null,
        metodos: categoria == null
          ? vs.map((v) => ({ id_metodo_pago: v.id_metodo_pago, metodo: etiquetaMetodo(v.codigo), ingresos: redondear(v.ingresos), facturas: v.facturas }))
            .sort((a, b) => b.ingresos - a.ingresos)
          : [],
        categorias: cs.map((c) => ({ ...c, ingresos: redondear(c.ingresos) })).sort((a, b) => b.ingresos - a.ingresos),
      },
      inventario: { unidades: inv.unidades, con_reporte: inv.con_reporte, agotados: inv.agotados, bajo_minimo: inv.bajo_minimo, sin_reporte: inv.sin_reporte },
    };
  });

  const suma = (fn) => filas.reduce((s, f) => s + (fn(f) ?? 0), 0);
  const ingresos = suma((f) => f.ventas.ingresos);
  const facturas = categoria == null ? suma((f) => f.ventas.facturas) : null;
  const conDatos = filas.filter((f) => f.frescura.estado !== "SIN_DATOS");
  const desactualizadas = filas.filter((f) => f.frescura.estado === "DESACTUALIZADA");
  const sinDatos = filas.filter((f) => f.frescura.estado === "SIN_DATOS");
  const alDia = filas.filter((f) => f.frescura.estado === "AL_DIA");
  const categoriasDesde = filas.map((f) => f.categorias_desde).filter(Boolean).sort()[0] ?? null;
  return {
    periodo,
    filtros: { tienda, categoria },
    generado_en: new Date().toISOString(),
    ultima_sync: link.ultimaSync,
    max_retraso_min: config.consolidadoMaxRetrasoMin,
    frescura: {
      estado: desactualizadas.length > 0 ? "DESACTUALIZADA" : sinDatos.length > 0 && conDatos.length === 0 ? "SIN_DATOS" : sinDatos.length > 0 ? "INCOMPLETA" : "AL_DIA",
      // La red está completa hasta la foto más vieja entre las tiendas al día.
      actualizado_hasta: alDia.map((f) => f.frescura.ultima_actualizacion).sort((a, b) => new Date(a) - new Date(b))[0] ?? null,
      desactualizadas: desactualizadas.map((f) => ({ id_tienda: f.id_tienda, nombre: f.nombre, ...f.frescura })),
      sin_datos: sinDatos.map((f) => ({ id_tienda: f.id_tienda, nombre: f.nombre })),
    },
    // Las ventas por categoría existen desde que la tienda corre HU-16: antes de esa fecha el filtro no las incluye.
    categorias_desde: categoriasDesde,
    totales: {
      ingresos: redondear(ingresos),
      facturas,
      unidades: suma((f) => f.ventas.unidades),
      ticket_promedio: facturas ? redondear(ingresos / facturas) : null,
      inventario: {
        unidades: suma((f) => f.inventario.unidades),
        agotados: suma((f) => f.inventario.agotados),
        bajo_minimo: suma((f) => f.inventario.bajo_minimo),
        sin_reporte: suma((f) => f.inventario.sin_reporte),
      },
    },
    metodos: [...metodos].map(([id_metodo_pago, metodo]) => ({ id_metodo_pago, metodo })),
    categorias: [...totalCategorias.values()].map((c) => ({ ...c, ingresos: redondear(c.ingresos) })).sort((a, b) => b.ingresos - a.ingresos),
    tiendas: filas,
  };
}

// Productos × tiendas, paginado. Cada celda: stock consolidado, mínimo, estado (regla de HU-01) y hora de la foto.
export async function inventarioRed(query, db = central) {
  const { tienda, categoria } = await filtrosDe(query, db);
  const pagina = entero(query.pagina, "pagina", 1) ?? 1;
  const q = normalizar(String(query.q ?? "").trim()).slice(0, 80);
  const filas = await db.query(
    `with m as (
       select m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo, m.id_categoria, count(*) over () as total
       from medicamento m
       where m.activo and ($1::int is null or coalesce(m.id_categoria, 0) = $1)
         and ($2::text = '' or ${NORM("m.nombre_comercial")} like '%' || $2 || '%' or ${NORM("m.principio_activo")} like '%' || $2 || '%'
              or lower(m.codigo_interno) like '%' || $2 || '%')
       order by m.nombre_comercial, m.id_medicamento
       limit ${POR_PAGINA} offset $3
     )
     select m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo, m.total::int as total,
            coalesce(c.nombre, 'Sin categoría') as categoria,
            jsonb_agg(jsonb_build_object(
              'id_tienda', t.id_tienda, 'cantidad', i.cantidad_disponible, 'stock_minimo', u.stock_minimo,
              'sincronizado', to_char(i.fecha_sincronizacion, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ) order by t.nombre) as tiendas
     from m
     cross join tienda t
     left join inventario_consolidado i on i.id_tienda = t.id_tienda and i.id_medicamento = m.id_medicamento
     left join umbral_stock u on u.id_tienda = t.id_tienda and u.id_medicamento = m.id_medicamento
     left join categoria c on c.id_categoria = m.id_categoria
     where t.activa and ($4::int is null or t.id_tienda = $4)
     group by m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo, m.total, c.nombre
     order by m.nombre_comercial, m.id_medicamento`,
    [categoria, q, (pagina - 1) * POR_PAGINA, tienda],
  );
  const total = filas.rows[0]?.total ?? 0;
  return {
    pagina,
    por_pagina: POR_PAGINA,
    total,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    productos: filas.rows.map(({ total: _, tiendas, ...p }) => ({
      ...p,
      total_red: tiendas.reduce((s, x) => s + (x.cantidad ?? 0), 0),
      tiendas: tiendas.map((x) => ({ ...x, estado: x.cantidad == null ? "sin_reporte" : estadoStock(x.cantidad, x.stock_minimo) })),
    })),
  };
}

export async function listarCategoriasRed(db = central) {
  const filas = await db.query("select id_categoria, nombre from categoria order by nombre");
  return { categorias: [...filas.rows, { id_categoria: 0, nombre: "Sin categoría" }] };
}

export async function listarTiendasRed(db = central) {
  const filas = await db.query("select id_tienda, nombre, ciudad from tienda where activa order by nombre");
  return { tiendas: filas.rows };
}
