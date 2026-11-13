import { local } from "./db.mjs";
import { invalido, noEncontrado } from "./errores.mjs";
import { auditar } from "./inventario/lotes.mjs";
import { facturaDe } from "./ventas.mjs";
import { veDatosPersonales } from "./recetas.mjs";
import { abrirDocumento, hmacDocumento } from "./datos-personales.mjs";

// HU-09: historial de compras y reimpresión de facturas. Solo lectura sobre la base de la tienda: funciona igual sin
// conexión con el central y nunca modifica una factura (son inmutables por trigger, HU-03/HU-08). Reimprimir solo deja
// una huella en la auditoría. La búsqueda usa paginación por cursor (fecha_hora, id_factura) sobre índices, así que el
// tiempo por página no crece con el tamaño del histórico. Los datos personales del cliente se enmascaran salvo para
// quien tiene permiso de verlos (regla 15) y cada consulta del historial de un cliente queda auditada (RNF-10).

const POR_PAGINA = 25;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERO_RE = /^[A-Za-z0-9-]{1,30}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?)\|(\d{1,10})$/;

const texto = (v) => String(v ?? "").trim();
const enmascarar = (doc) => (doc ? `****${String(doc).slice(-4)}` : null);
const patron = (t) => `%${t.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

function fecha(valor, campo) {
  const t = texto(valor);
  if (!t) return null;
  const d = new Date(`${t}T00:00:00Z`);
  if (!FECHA_RE.test(t) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) throw invalido("Fecha no válida (AAAA-MM-DD)", { campo });
  return t;
}

function idEntero(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) throw invalido(`${campo} no válido`, { campo });
  return n;
}

const cliente = (c, completo) => ({
  id_cliente: c.id_cliente,
  nombre: c.nombre,
  documento: completo && c.documento_cifrado ? abrirDocumento(c.documento_cifrado) : c.documento_identidad,
});

// Clientes por nombre (parte) o documento exacto, para elegir de quién ver el historial.
export async function buscarClientes(sesion, query) {
  const q = texto(query.q);
  if (q.length < 2) throw invalido("Escriba al menos 2 caracteres del nombre o el documento", { campo: "q" });
  if (q.length > 100) throw invalido("La búsqueda admite máximo 100 caracteres", { campo: "q" });
  const completo = veDatosPersonales(sesion);
  const r = await local.query(
    `select id_cliente, nombre, documento_identidad, documento_cifrado from cliente
     where lower(nombre) like $1 escape '\\' or documento_hmac = $2
     order by nombre limit 20`,
    [patron(q), hmacDocumento(q)],
  );
  // Quien ve el documento completo de varios clientes deja constancia (docs/seguridad/datos-personales.md).
  if (completo && r.rows.length > 0) {
    await auditar(local, sesion.id_empleado, "CLIENTE_DATOS_CONSULTAR", "cliente", null, `Documento completo de ${r.rows.length} cliente(s) buscado(s) por "${q.slice(0, 40)}"`);
  }
  return { clientes: r.rows.map((c) => cliente(c, completo)) };
}

// Resumen del cliente (cuántas compras y cuánto): auditado porque expone datos personales.
export async function resumenCliente(sesion, idCliente) {
  const completo = veDatosPersonales(sesion);
  const r = await local.query(
    `select c.id_cliente, c.nombre, c.documento_identidad, c.documento_cifrado, c.telefono, c.correo,
            count(f.id_factura)::int as compras,
            coalesce(sum(f.total) filter (where f.estado <> 'ANULADA'), 0)::text as total_comprado,
            max(f.fecha_hora) as ultima_compra
     from cliente c left join factura f on f.id_cliente = c.id_cliente
     where c.id_cliente = $1 group by c.id_cliente`,
    [idCliente],
  );
  if (r.rowCount === 0) throw noEncontrado("El cliente no existe");
  const c = r.rows[0];
  await auditar(local, sesion.id_empleado, "CLIENTE_DATOS_CONSULTAR", "cliente", idCliente, "Consulta del historial de compras del cliente");
  return {
    ...cliente(c, completo),
    telefono: completo ? c.telefono : null,
    correo: completo ? c.correo : null,
    compras: c.compras,
    total_comprado: c.total_comprado,
    ultima_compra: c.ultima_compra,
  };
}

// Búsqueda de facturas por cliente (id o texto), número (prefijo) y rango de fechas (inclusive). Todos los filtros son
// opcionales y se combinan; sin filtros lista las más recientes. Devuelve una página y el cursor de la siguiente.
export async function buscarFacturas(sesion, query) {
  const idCliente = query.id_cliente ? idEntero(query.id_cliente, "id_cliente") : null;
  const clienteTxt = texto(query.cliente);
  if (clienteTxt.length > 100) throw invalido("La búsqueda de cliente admite máximo 100 caracteres", { campo: "cliente" });
  const numero = texto(query.numero).toUpperCase();
  if (numero && !NUMERO_RE.test(numero)) throw invalido("Número de factura no válido", { campo: "numero" });
  const desde = fecha(query.desde, "desde");
  const hasta = fecha(query.hasta, "hasta");
  if (desde && hasta && desde > hasta) throw invalido("La fecha inicial es posterior a la final", { campo: "desde" });
  let cursor = null;
  if (query.cursor) {
    const m = CURSOR_RE.exec(texto(query.cursor));
    if (!m) throw invalido("Cursor no válido", { campo: "cursor" });
    cursor = { fecha: m[1].replace("T", " "), id: Number(m[3]) };
  }
  const completo = veDatosPersonales(sesion);

  const r = await local.query(
    `select f.id_factura, f.numero_factura, f.fecha_hora, f.fecha_hora::text as fecha_texto, f.total::text, f.estado,
            c.id_cliente, c.nombre, c.documento_identidad, c.documento_cifrado, e.nombre_completo as cajero
     from factura f
     left join cliente c on c.id_cliente = f.id_cliente
     left join empleado_ref e on e.id_empleado = f.id_empleado
     where ($1::int is null or f.id_cliente = $1)
       and ($2::text is null or f.numero_factura like $2)
       and ($3::date is null or f.fecha_hora >= $3::date)
       and ($4::date is null or f.fecha_hora < $4::date + 1)
       and ($5::text is null or f.id_cliente in (select id_cliente from cliente where lower(nombre) like $5 escape '\\' or documento_hmac = $6))
       and ($7::timestamp is null or (f.fecha_hora, f.id_factura) < ($7::timestamp, $8::int))
     order by f.fecha_hora desc, f.id_factura desc
     limit ${POR_PAGINA + 1}`,
    [
      idCliente,
      numero ? `${numero}%` : null,
      desde,
      hasta,
      clienteTxt ? patron(clienteTxt) : null,
      clienteTxt ? hmacDocumento(clienteTxt) : null,
      cursor?.fecha ?? null,
      cursor?.id ?? null,
    ],
  );
  const hayMas = r.rows.length > POR_PAGINA;
  const filas = r.rows.slice(0, POR_PAGINA);
  const ultima = filas[filas.length - 1];

  // Ver compras de un cliente expone sus datos: queda en la auditoría.
  if (filas.some((f) => f.id_cliente != null) && (idCliente != null || clienteTxt)) {
    await auditar(local, sesion.id_empleado, "CLIENTE_DATOS_CONSULTAR", "factura", null, "Búsqueda de facturas por cliente");
  }
  return {
    facturas: filas.map((f) => ({
      id_factura: f.id_factura,
      numero_factura: f.numero_factura,
      fecha_hora: f.fecha_hora,
      total: f.total,
      estado: f.estado,
      cajero: f.cajero,
      cliente: f.id_cliente ? cliente(f, completo) : null,
    })),
    siguiente: hayMas ? `${ultima.fecha_texto}|${ultima.id_factura}` : null,
  };
}

// Ver una factura: exactamente la que se emitió (precios, tasas y lotes fijados en cada línea).
export async function verFactura(idFactura) {
  return facturaDe(local, idFactura);
}

// Reimpresión: devuelve la misma factura sin tocarla y registra quién y cuándo. `copias` cuenta las impresiones
// anteriores, para rotular la copia ("COPIA n"); el contenido es idéntico al original.
export async function reimprimirFactura(sesion, idFactura) {
  const factura = await facturaDe(local, idFactura);
  const previas = await local.query(
    "select count(*)::int as n from registro_actividad where accion = 'FACTURA_REIMPRIMIR' and entidad_afectada = 'factura' and id_entidad_afectada = $1",
    [idFactura],
  );
  await auditar(local, sesion.id_empleado, "FACTURA_REIMPRIMIR", "factura", idFactura, `Reimpresión de ${factura.numero_factura}`);
  return { ...factura, reimpresion: previas.rows[0].n + 1 };
}
