import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora, pesos } from "./inventarioUi.jsx";
import { BarrasH, Columnas, Indicador, StockContraMinimo } from "./graficos.jsx";
import { dinero, entero, exportarExcel, exportarPdf, nombreArchivo } from "./exportar.js";

// HU-05: reporte de la tienda (criterios 1 y 2). Se calcula en el nodo local: funciona sin conexión con el central.
// Lo exportado (Excel o PDF) es exactamente lo que se ve, con el mismo periodo.

const hoyUtc = () => new Date().toISOString().slice(0, 10);
const restarDias = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const PRESETS = [
  ["Hoy", () => [hoyUtc(), hoyUtc()]],
  ["7 días", () => [restarDias(hoyUtc(), 6), hoyUtc()]],
  ["Este mes", () => [`${hoyUtc().slice(0, 8)}01`, hoyUtc()]],
  ["30 días", () => [restarDias(hoyUtc(), 29), hoyUtc()]],
  ["12 meses", () => [restarDias(hoyUtc(), 364), hoyUtc()]],
];
const TRAMOS = [
  ["VENCIDO", "Vencidos (bloqueados)", "agotado"],
  ["HASTA_7", "≤ 7 días", "bajo"],
  ["HASTA_30", "8–30 días", "media"],
  ["HASTA_90", "31–90 días", ""],
];
const unidades = (n) => `${Number(n).toLocaleString("es-CO")} u.`;

// Selector de periodo compartido con el comparativo de red. Los días son de calendario UTC (igual que el central).
export function Periodo({ periodo, onCambiar, cargando }) {
  const [desde, setDesde] = useState(periodo.desde);
  const [hasta, setHasta] = useState(periodo.hasta);
  useEffect(() => {
    setDesde(periodo.desde);
    setHasta(periodo.hasta);
  }, [periodo.desde, periodo.hasta]);
  return (
    <form
      className="rep-periodo no-print"
      onSubmit={(e) => {
        e.preventDefault();
        onCambiar({ desde, hasta });
      }}
    >
      <label>
        Desde
        <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} required />
      </label>
      <label>
        Hasta
        <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} required />
      </label>
      <button className="primary" disabled={cargando}>{cargando ? "Generando…" : "Generar"}</button>
      <div className="row rep-presets">
        {PRESETS.map(([etiqueta, rango]) => (
          <button
            type="button"
            key={etiqueta}
            className="ghost"
            onClick={() => {
              const [d, h] = rango();
              onCambiar({ desde: d, hasta: h });
            }}
          >
            {etiqueta}
          </button>
        ))}
      </div>
    </form>
  );
}

export function Exportar({ onExcel, deshabilitado }) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="row no-print rep-exportar">
      <button
        className="ghost"
        disabled={deshabilitado || ocupado}
        onClick={async () => {
          setOcupado(true);
          setError("");
          try {
            await onExcel();
          } catch {
            setError("No se pudo generar el archivo Excel");
          } finally {
            setOcupado(false);
          }
        }}
      >
        {ocupado ? "Generando Excel…" : "Descargar Excel"}
      </button>
      <button className="ghost" disabled={deshabilitado} onClick={exportarPdf}>Imprimir / PDF</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export default function Reportes({ session }) {
  const [periodo, setPeriodo] = useState(() => ({ desde: `${hoyUtc().slice(0, 8)}01`, hasta: hoyUtc() }));
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const r = await api(`/api/local/reportes/tienda?${new URLSearchParams(periodo)}`, { token: session.token });
      if (r.ok) setDatos(r.data);
      else setError(r.data.mensaje || "No se pudo generar el reporte");
    } catch {
      setError("No hay respuesta del servidor");
    } finally {
      setCargando(false);
    }
  }, [periodo, session.token]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const v = datos?.ventas;
  const inv = datos?.inventario;

  function excel() {
    const p = datos.periodo;
    return exportarExcel(nombreArchivo("reporte-tienda", p), [
      {
        nombre: "Resumen",
        columnas: ["Indicador", "Valor"],
        anchos: [32, 18],
        filas: [
          ["Tienda", session.tienda],
          ["Periodo", `${p.desde} a ${p.hasta} (días ${p.zona})`],
          ["Generado", fechaHora(datos.generado_en)],
          ["Facturas", entero(v.facturas)],
          ["Unidades vendidas", entero(v.unidades_vendidas)],
          ["Unidades devueltas", entero(v.unidades_devueltas)],
          ["Unidades netas", entero(v.unidades_netas)],
          ["Ingresos brutos", dinero(v.ingresos_brutos)],
          ["Reintegros (anulaciones y devoluciones)", dinero(v.reintegros)],
          ["Ingresos netos", dinero(v.ingresos_netos)],
          ["Ticket promedio", dinero(v.ticket_promedio)],
        ],
      },
      {
        nombre: "Por método de pago",
        columnas: ["Método", "Facturas", "Ingresos", "Notas", "Reintegros", "Ingresos netos"],
        filas: v.por_metodo.map((m) => [m.metodo, entero(m.facturas), dinero(m.ingresos), entero(m.notas), dinero(m.reintegros), dinero(m.ingresos_netos)]),
      },
      {
        nombre: "Más vendidos",
        columnas: ["Código", "Medicamento", "Vendidas", "Devueltas", "Netas", "Ingresos netos"],
        anchos: [14, 34, 10, 10, 10, 16],
        filas: v.mas_vendidos.map((m) => [m.codigo_interno, m.nombre_comercial, entero(m.unidades_vendidas), entero(m.unidades_devueltas), entero(m.unidades_netas), dinero(m.ingresos_netos)]),
      },
      {
        nombre: "Por día",
        columnas: ["Día", "Unidades netas", "Ingresos netos"],
        filas: v.por_dia.map((d) => [d.dia, entero(d.unidades), dinero(d.ingresos)]),
      },
      {
        nombre: "Stock crítico",
        columnas: ["Código", "Medicamento", "Situación", "Nivel", "Stock vendible", "Mínimo"],
        anchos: [14, 34, 12, 10, 14, 10],
        filas: inv.criticos.map((c) => [c.codigo_interno, c.nombre_comercial, c.tipo === "STOCK_AGOTADO" ? "Agotado" : "Bajo", c.nivel, entero(c.stock), entero(c.stock_minimo)]),
      },
      {
        nombre: "Caducidad",
        columnas: ["Tramo", "Lote", "Medicamento", "Caduca", "Días", "Unidades", "Estado"],
        anchos: [22, 16, 34, 12, 8, 10, 12],
        filas: inv.caducidad.lotes.map((l) => [TRAMOS.find(([t]) => t === l.tramo)[1], l.numero_lote, l.nombre_comercial, l.fecha_caducidad, entero(l.dias), entero(l.cantidad_disponible), l.estado]),
      },
    ]);
  }

  return (
    <article className="reporte">
      <header className="rep-cabecera">
        <div>
          <h2>Reportes de la tienda</h2>
          <p className="muted">
            {session.tienda}
            {datos && <> · {fechaCorta(datos.periodo.desde)} a {fechaCorta(datos.periodo.hasta)} ({datos.periodo.dias} días, calendario {datos.periodo.zona}) · generado {fechaHora(datos.generado_en)}</>}
          </p>
        </div>
        <Exportar onExcel={excel} deshabilitado={!datos || cargando} />
      </header>
      <Periodo periodo={periodo} onCambiar={setPeriodo} cargando={cargando} />
      {error && <div className="error">{error}</div>}

      {v && (
        <>
          <section className="rep-kpis" aria-label="Resumen de ventas">
            <Indicador titulo="Ingresos netos" valor={pesos(v.ingresos_netos)} detalle={`brutos ${pesos(v.ingresos_brutos)}`} />
            <Indicador titulo="Unidades netas" valor={v.unidades_netas.toLocaleString("es-CO")} detalle={`${v.unidades_vendidas} vendidas · ${v.unidades_devueltas} devueltas`} />
            <Indicador titulo="Facturas" valor={v.facturas.toLocaleString("es-CO")} detalle={`ticket promedio ${pesos(v.ticket_promedio)}`} />
            <Indicador titulo="Anulaciones y devoluciones" valor={v.notas.toLocaleString("es-CO")} detalle={`reintegrado ${pesos(v.reintegros)}`} />
          </section>

          <section className="rep-bloque">
            <h3>Ingresos por método de pago</h3>
            <BarrasH
              titulo="Ingresos netos por método de pago"
              datos={v.por_metodo.map((m) => ({ clave: m.id_metodo_pago, etiqueta: m.metodo, valor: m.ingresos_netos, detalle: `${m.facturas} factura${m.facturas === 1 ? "" : "s"}` }))}
              formato={pesos}
            />
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr><th>Método</th><th className="num">Facturas</th><th className="num">Ingresos</th><th className="num">Reintegros</th><th className="num">Netos</th></tr>
                </thead>
                <tbody>
                  {v.por_metodo.map((m) => (
                    <tr key={m.id_metodo_pago}>
                      <td>{m.metodo}</td>
                      <td className="num">{m.facturas}</td>
                      <td className="num">{pesos(m.ingresos)}</td>
                      <td className="num">{m.reintegros ? pesos(m.reintegros) : "—"}</td>
                      <td className="num"><strong>{pesos(m.ingresos_netos)}</strong></td>
                    </tr>
                  ))}
                  {v.por_metodo.length === 0 && <tr><td colSpan="5" className="muted">Sin ventas en el periodo.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="muted rep-nota">
              Una factura pagada con dos métodos cuenta en cada uno, por eso la suma de facturas por método puede ser mayor que el total.
              Las unidades no se reparten por método (el pago es de la factura, no de cada línea): se muestran por producto y por día.
            </p>
          </section>

          <section className="rep-bloque">
            <h3>Ingresos netos por día</h3>
            <Columnas titulo="Ingresos netos por día" datos={v.por_dia.map((d) => ({ etiqueta: d.dia, valor: d.ingresos }))} formato={pesos} />
          </section>

          <section className="rep-bloque">
            <h3>Más vendidos (unidades netas)</h3>
            <BarrasH
              titulo="Medicamentos más vendidos"
              datos={v.mas_vendidos.map((m) => ({ clave: m.id_medicamento, etiqueta: m.nombre_comercial, valor: m.unidades_netas, detalle: pesos(m.ingresos_netos) }))}
              formato={unidades}
            />
          </section>
        </>
      )}

      {inv && (
        <>
          <section className="rep-bloque">
            <h3>Stock crítico</h3>
            <p className="muted">Productos agotados o en su mínimo o por debajo, según los umbrales de esta tienda (alertas de HU-04). La marca vertical es el mínimo.</p>
            <StockContraMinimo datos={inv.criticos} />
          </section>

          <section className="rep-bloque">
            <h3>Caducidad</h3>
            <BarrasH
              titulo="Unidades por tramo de caducidad"
              datos={TRAMOS.map(([clave, etiqueta, tono]) => ({
                clave,
                etiqueta,
                tono,
                valor: inv.caducidad.tramos[clave].unidades,
                detalle: `${inv.caducidad.tramos[clave].lotes} lote${inv.caducidad.tramos[clave].lotes === 1 ? "" : "s"}`,
              }))}
              formato={unidades}
            />
            {inv.caducidad.lotes.length > 0 && (
              <div className="tabla-scroll">
                <table className="tabla">
                  <thead>
                    <tr><th>Medicamento</th><th>Lote</th><th>Caduca</th><th className="num">Días</th><th className="num">Unidades</th><th>Estado</th></tr>
                  </thead>
                  <tbody>
                    {inv.caducidad.lotes.map((l) => (
                      <tr key={l.id_lote} className={l.tramo === "VENCIDO" ? "vencido" : l.tramo === "HASTA_7" ? "por-vencer" : undefined}>
                        <td>{l.nombre_comercial}</td>
                        <td>{l.numero_lote}</td>
                        <td>{fechaCorta(l.fecha_caducidad)}</td>
                        <td className="num">{l.dias < 0 ? `vencido hace ${-l.dias}` : l.dias}</td>
                        <td className="num">{l.cantidad_disponible}</td>
                        <td>{l.estado}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {inv.caducidad.lotes_truncados && <p className="muted">Se muestran los {inv.caducidad.lotes.length} lotes más próximos a caducar.</p>}
          </section>
        </>
      )}
    </article>
  );
}
