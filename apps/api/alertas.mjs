import { local, runtime, withTx } from "./db.mjs";
import { invalido, noEncontrado } from "./errores.mjs";
import { encolarStockSnapshot } from "./inventario/stock.mjs";

// HU-04: alertas de stock bajo y de caducidad (RF-03, RNF-04). Todo es local: la tienda se alerta sola aunque no alcance al
// central. Las reglas viven en la vista alertas_calculadas y la pasada de evaluación en la función evaluar_alertas()
// (db/local/08_hu04_alertas.sql): bloquea los lotes vencidos, crea y actualiza las alertas y resuelve las que ya no aplican.

const TIPOS = ["LOTE_VENCIDO", "STOCK_AGOTADO", "STOCK_BAJO", "CADUCIDAD_PROXIMA", "SIN_UMBRAL"];
const NIVELES = ["CRITICA", "ALTA", "MEDIA"];
const MAX_RESULTADOS = 200;

// Una pasada de evaluación. Si bloqueó lotes, el stock vendible de esos medicamentos cambió sin ningún movimiento:
// se encola su nuevo stock para el central en la misma transacción.
export async function evaluarAlertas() {
  return withTx(local, async (client) => {
    const { r } = (await client.query("select evaluar_alertas() as r")).rows[0];
    if (r.medicamentos?.length > 0) {
      await encolarStockSnapshot(client, { idTienda: runtime.tiendaId, idsMedicamento: r.medicamentos });
    }
    return r;
  });
}

// Panel único: todas las alertas activas, de la más urgente a la menos. Dentro de un nivel: lo más vencido, lo más
// cercano a caducar o lo más escaso primero. Con estado=RESUELTA se consulta el historial reciente.
export async function listarAlertas(query) {
  const estado = String(query.estado ?? "ACTIVA").toUpperCase();
  if (!["ACTIVA", "RESUELTA"].includes(estado)) throw invalido("Estado no válido", { campo: "estado" });
  const tipo = query.tipo ? String(query.tipo).toUpperCase() : null;
  if (tipo && !TIPOS.includes(tipo)) throw invalido("Tipo de alerta no válido", { campo: "tipo" });
  const nivel = query.nivel ? String(query.nivel).toUpperCase() : null;
  if (nivel && !NIVELES.includes(nivel)) throw invalido("Nivel no válido", { campo: "nivel" });
  const filas = await local.query(
    `select a.id_alerta, a.tipo, a.nivel, a.estado, a.detalle, a.creada_en, a.actualizada_en, a.resuelta_en, a.vista_en,
            e.nombre_completo as vista_por, m.id_medicamento, m.codigo_interno, m.nombre_comercial, l.id_lote, l.numero_lote
     from alerta a
     join medicamento_ref m on m.id_medicamento = a.id_medicamento
     left join lote l on l.id_lote = a.id_lote
     left join empleado_ref e on e.id_empleado = a.id_empleado_vista
     where a.estado = $1 and ($2::text is null or a.tipo = $2) and ($3::text is null or a.nivel = $3)
     order by case a.nivel when 'CRITICA' then 0 when 'ALTA' then 1 else 2 end, a.prioridad, a.creada_en, a.id_alerta
     limit ${MAX_RESULTADOS}`,
    [estado, tipo, nivel],
  );
  return { estado, alertas: filas.rows };
}

// Contadores para el indicador de la barra superior: activas y sin ver, por nivel.
export async function resumenAlertas() {
  const filas = await local.query(
    `select nivel, count(*)::int as total, (count(*) filter (where vista_en is null))::int as sin_ver
     from alerta where estado = 'ACTIVA' group by nivel`,
  );
  const resumen = Object.fromEntries(NIVELES.map((n) => [n, { total: 0, sin_ver: 0 }]));
  for (const f of filas.rows) resumen[f.nivel] = { total: f.total, sin_ver: f.sin_ver };
  return {
    por_nivel: resumen,
    total: NIVELES.reduce((s, n) => s + resumen[n].total, 0),
    sin_ver: NIVELES.reduce((s, n) => s + resumen[n].sin_ver, 0),
    // Lo que más urge: críticas y altas sin ver (el indicador se enciende con esto).
    urgentes_sin_ver: resumen.CRITICA.sin_ver + resumen.ALTA.sin_ver,
  };
}

// El empleado confirma que la vio. La primera confirmación queda; repetirla no cambia nada.
export async function marcarVista(sesion, idAlerta) {
  const r = await local.query(
    `update alerta set id_empleado_vista = coalesce(id_empleado_vista, $2), vista_en = coalesce(vista_en, now())
     where id_alerta = $1 returning id_alerta, estado, vista_en`,
    [idAlerta, sesion.id_empleado],
  );
  if (r.rowCount === 0) throw noEncontrado("La alerta no existe");
  return r.rows[0];
}
