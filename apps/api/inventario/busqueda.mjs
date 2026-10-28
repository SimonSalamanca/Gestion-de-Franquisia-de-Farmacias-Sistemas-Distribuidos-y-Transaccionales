import { central, local } from "../db.mjs";
import { ErrorNegocio, invalido, noEncontrado } from "../errores.mjs";
import { centralAlcanzable, link } from "../sync.mjs";
import { SQL_STOCK_VENDIBLE, estadoStock } from "./stock.mjs";

// HU-01 (RF-01, RF-03). La búsqueda en la tienda propia solo usa la base local (RNF-04);
// lo que cruza tiendas consulta el consolidado del central con un tope de tiempo (RNF-05).

const POR_PAGINA = 25;
// Solo para la búsqueda en otra tienda, donde el estado se calcula fuera de la base.
const MAX_COINCIDENCIAS = 5000;
// RNF-05: 95 % de búsquedas y consultas en < 2 s. Si el central tarda más, se responde sin la red.
export const TIMEOUT_RED_MS = 1500;
const ESTADOS = ["disponible", "bajo", "agotado"];

// Igual que en SQL: minúsculas y sin tildes, para que "acetaminofen" encuentre "Acetaminofén".
function normalizar(texto) {
  return texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const NORM = (columna) => `translate(lower(${columna}), 'áéíóúüñ', 'aeiouun')`;

function sinConexion() {
  return new ErrorNegocio(503, "SIN_CONEXION", "Existencias de la red no disponibles: sin conexión con el nodo central", {
    ultima_sync: link.ultimaSync,
  });
}

async function consultarCentral(sql, valores) {
  if (!centralAlcanzable()) throw sinConexion();
  let timer;
  try {
    return await Promise.race([
      central.query(sql, valores),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(sinConexion()), TIMEOUT_RED_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof ErrorNegocio) throw error;
    throw sinConexion();
  } finally {
    clearTimeout(timer);
  }
}

function enteroOpcional(valor, campo) {
  if (valor == null || valor === "") return null;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 1) throw invalido(`Filtro ${campo} no válido`, { campo });
  return numero;
}

// db: la base local por defecto; las pruebas pasan un cliente en transacción para revertir sus datos.
export async function buscar(query, ctx, db = local) {
  const termino = String(query.q ?? "").trim();
  const categoria = enteroOpcional(query.categoria, "categoria");
  const tiendaFiltro = enteroOpcional(query.tienda, "tienda");
  const tienda = tiendaFiltro ?? ctx.idTienda;
  const pagina = enteroOpcional(query.pagina, "pagina") ?? 1;
  const estado = query.estado ? String(query.estado).toLowerCase() : null;
  if (estado && !ESTADOS.includes(estado)) throw invalido("Estado de stock no válido", { campo: "estado" });
  // Sin término se puede explorar solo con filtros (p. ej. "todo lo agotado"); sin ninguno no hay búsqueda.
  const conFiltro = categoria != null || estado != null || tiendaFiltro != null;
  if (termino.length < 2 && !(termino.length === 0 && conFiltro)) {
    throw invalido("Escriba al menos 2 caracteres o elija un filtro", { campo: "q" });
  }
  if (termino.length > 80) throw invalido("El término admite máximo 80 caracteres", { campo: "q" });

  const normal = normalizar(termino);
  const patron = `%${normal.replace(/[\\%_]/g, "\\$&")}%`;
  const prefijo = `${normal.replace(/[\\%_]/g, "\\$&")}%`;
  // Catálogo local + stock propio con su estado, ya calculado en SQL para poder filtrar antes de paginar.
  const coincidenciasSql = `
    select m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo,
           m.id_categoria, c.nombre as categoria, m.requiere_receta, m.requiere_refrigeracion,
           coalesce(s.stock, 0)::int as stock_tienda, u.stock_minimo,
           case
             when coalesce(s.stock, 0) <= 0 then 'agotado'
             when u.stock_minimo is not null and s.stock <= u.stock_minimo then 'bajo'
             else 'disponible'
           end as estado_stock,
           case
             when ${NORM("m.codigo_interno")} = $4 then 0
             when ${NORM("m.nombre_comercial")} like $2 escape '\\' then 1
             else 2
           end as relevancia
    from medicamento_ref m
    left join categoria_ref c on c.id_categoria = m.id_categoria
    left join (${SQL_STOCK_VENDIBLE}) s on s.id_medicamento = m.id_medicamento
    left join umbral_stock_ref u on u.id_medicamento = m.id_medicamento
    where m.activo = true
      and (${NORM("m.nombre_comercial")} like $1 escape '\\'
           or ${NORM("m.principio_activo")} like $1 escape '\\'
           or ${NORM("m.codigo_interno")} like $1 escape '\\')
      and ($3::int is null or m.id_categoria = $3)`;
  const valores = [patron, prefijo, categoria, normal];
  const limpiar = ({ relevancia, total, ...row }) => ({ ...row, actualizado_en: null });

  // Tienda propia: filtro de estado, orden y paginación en la base local (sin tope de coincidencias).
  if (tienda === ctx.idTienda) {
    const filtrada = `select * from (${coincidenciasSql}) q where ($5::text is null or q.estado_stock = $5)`;
    const pag = await db.query(
      `select *, count(*) over () as total from (${filtrada}) f
       order by relevancia, nombre_comercial
       limit ${POR_PAGINA} offset $6`,
      [...valores, estado, (pagina - 1) * POR_PAGINA],
    );
    let total = pag.rowCount > 0 ? Number(pag.rows[0].total) : 0;
    if (pag.rowCount === 0 && pagina > 1) {
      total = Number((await db.query(`select count(*) as n from (${filtrada}) f`, [...valores, estado])).rows[0].n);
    }
    return {
      termino,
      tienda: { id_tienda: ctx.idTienda, propia: true },
      total,
      pagina,
      paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
      truncado: false,
      resultados: pag.rows.map(limpiar),
    };
  }

  // Otra tienda: el catálogo es local, el stock sale del consolidado del central, así que el
  // estado se calcula aquí sobre todas las coincidencias (hasta MAX_COINCIDENCIAS) antes de paginar.
  const coincidencias = await db.query(
    `${coincidenciasSql} order by relevancia, m.nombre_comercial limit ${MAX_COINCIDENCIAS}`,
    valores,
  );
  const red = await consultarCentral(
    `select t.id_tienda, t.nombre, ic.id_medicamento, ic.cantidad_disponible, ic.fecha_sincronizacion, u.stock_minimo
     from tienda t
     left join inventario_consolidado ic on ic.id_tienda = t.id_tienda and ic.id_medicamento = any($2::int[])
     left join umbral_stock u on u.id_tienda = t.id_tienda and u.id_medicamento = ic.id_medicamento
     where t.id_tienda = $1 and t.activa = true`,
    [tienda, coincidencias.rows.map((row) => row.id_medicamento)],
  );
  if (red.rowCount === 0) throw noEncontrado(`La tienda ${tienda} no existe o está inactiva`);
  const porMedicamento = new Map(red.rows.filter((row) => row.id_medicamento != null).map((row) => [row.id_medicamento, row]));
  const tiendaInfo = { id_tienda: tienda, nombre: red.rows[0].nombre, propia: false };
  let filas = coincidencias.rows.map((row) => {
    const dato = porMedicamento.get(row.id_medicamento);
    const stock = dato ? Number(dato.cantidad_disponible) : 0;
    const stockMinimo = dato?.stock_minimo ?? null;
    return {
      ...limpiar(row),
      stock_tienda: stock,
      stock_minimo: stockMinimo,
      estado_stock: estadoStock(stock, stockMinimo),
      actualizado_en: dato?.fecha_sincronizacion ?? null,
    };
  });

  if (estado) filas = filas.filter((row) => row.estado_stock === estado);
  const total = filas.length;
  const inicio = (pagina - 1) * POR_PAGINA;
  return {
    termino,
    tienda: tiendaInfo,
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    truncado: coincidencias.rowCount === MAX_COINCIDENCIAS,
    resultados: filas.slice(inicio, inicio + POR_PAGINA),
  };
}

// Criterio 2: otras tiendas de la red con su stock y la hora de su último reporte (RNF-13).
export async function existenciasEnRed(idMedicamento, query, ctx) {
  const id = enteroOpcional(idMedicamento, "id_medicamento");
  if (!id) throw invalido("Medicamento no válido");
  const tienda = enteroOpcional(query.tienda, "tienda");
  const estado = query.estado ? String(query.estado).toLowerCase() : null;
  if (estado && !ESTADOS.includes(estado)) throw invalido("Estado de stock no válido", { campo: "estado" });

  const result = await consultarCentral(
    `select t.id_tienda, t.nombre, t.ciudad, ic.cantidad_disponible as cantidad,
            ic.fecha_sincronizacion as actualizado_en, u.stock_minimo
     from inventario_consolidado ic
     join tienda t on t.id_tienda = ic.id_tienda and t.activa = true
     left join umbral_stock u on u.id_tienda = ic.id_tienda and u.id_medicamento = ic.id_medicamento
     where ic.id_medicamento = $1
       and ic.id_tienda <> $2
       and ($3::int is null or ic.id_tienda = $3)
     order by (ic.cantidad_disponible > 0) desc, ic.cantidad_disponible desc, t.nombre`,
    [id, ctx.idTienda, tienda],
  );
  let tiendas = result.rows.map((row) => ({
    ...row,
    cantidad: Number(row.cantidad),
    estado_stock: estadoStock(Number(row.cantidad), row.stock_minimo),
  }));
  if (estado) tiendas = tiendas.filter((row) => row.estado_stock === estado);
  return {
    id_medicamento: id,
    con_stock: tiendas.filter((row) => row.cantidad > 0).length,
    tiendas,
    consultado_en: new Date().toISOString(),
  };
}

export async function listarTiendas(ctx) {
  const result = await local.query(
    "select id_tienda, nombre, (id_tienda = $1) as propia from tienda_ref where activa = true order by (id_tienda = $1) desc, nombre",
    [ctx.idTienda],
  );
  return result.rows;
}

export async function listarCategorias() {
  const result = await local.query("select id_categoria, nombre from categoria_ref order by nombre");
  return result.rows;
}
