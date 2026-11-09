import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora, pesos } from "./inventarioUi.jsx";
import { BarrasH, Indicador } from "./graficos.jsx";
import { dinero, entero, exportarExcel, nombreArchivo, porcentaje } from "./exportar.js";
import { Exportar, Periodo } from "./Reportes.jsx";

// HU-05: comparativo entre tiendas (criterio 3), en la consola del central. Sale de lo consolidado: puede ir unos
// minutos atrasado (RNF-13), por eso cada tienda muestra la hora de su última sincronización.

const hoyUtc = () => new Date().toISOString().slice(0, 10);
const cuando = (fecha) => (fecha ? fechaHora(fecha) : "nunca");

export default function ReportesRed({ session }) {
  const [periodo, setPeriodo] = useState(() => ({ desde: `${hoyUtc().slice(0, 8)}01`, hasta: hoyUtc() }));
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const r = await api(`/api/central/reportes/comparativo?${new URLSearchParams(periodo)}`, { token: session.token });
      if (r.ok) setDatos(r.data);
      else if (r.status === 503) setError(`Sin conexión con el nodo central. Última sincronización: ${cuando(r.data.ultima_sync)}.`);
      else setError(r.data.mensaje || "No se pudo generar el comparativo");
    } catch {
      setError("No hay respuesta del servidor");
    } finally {
      setCargando(false);
    }
  }, [periodo, session.token]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  function excel() {
    const p = datos.periodo;
    const metodos = datos.metodos;
    return exportarExcel(nombreArchivo("comparativo-red", p), [
      {
        nombre: "Comparativo",
        columnas: ["Tienda", "Ciudad", "Ingresos netos", "Facturas", "Ticket promedio", "Participación", "Agotados", "Bajo mínimo", "Sin reporte", "Última sync ventas", "Última sync stock"],
        anchos: [26, 16, 16, 10, 16, 13, 10, 12, 12, 20, 20],
        filas: datos.tiendas.map((t) => [
          t.nombre,
          t.ciudad,
          dinero(t.ingresos),
          entero(t.facturas),
          dinero(t.ticket_promedio),
          porcentaje(t.participacion),
          entero(t.agotados),
          entero(t.bajo_minimo),
          entero(t.sin_reporte),
          t.sin_datos ? "sin datos consolidados" : cuando(t.ultima_sync_ventas),
          cuando(t.ultima_sync_stock),
        ]),
      },
      {
        nombre: "Ingresos por método",
        columnas: ["Tienda", ...metodos.map((m) => m.metodo), "Total"],
        anchos: [26, ...metodos.map(() => 16), 16],
        filas: datos.tiendas.map((t) => [
          t.nombre,
          ...metodos.map((m) => dinero(t.metodos.find((x) => x.id_metodo_pago === m.id_metodo_pago)?.ingresos ?? 0)),
          dinero(t.ingresos),
        ]),
      },
      {
        nombre: "Resumen",
        columnas: ["Indicador", "Valor"],
        anchos: [28, 30],
        filas: [
          ["Periodo", `${p.desde} a ${p.hasta} (días ${p.zona})`],
          ["Generado", fechaHora(datos.generado_en)],
          ["Tiendas activas", entero(datos.totales.tiendas)],
          ["Ingresos netos de la red", dinero(datos.totales.ingresos)],
          ["Facturas", entero(datos.totales.facturas)],
          ["Ticket promedio", dinero(datos.totales.ticket_promedio)],
        ],
      },
    ]);
  }

  const t = datos?.totales;
  return (
    <article className="reporte">
      <header className="rep-cabecera">
        <div>
          <h2>Comparativo entre tiendas</h2>
          <p className="muted">
            Tiendas activas de la red
            {datos && <> · {fechaCorta(datos.periodo.desde)} a {fechaCorta(datos.periodo.hasta)} ({datos.periodo.dias} días, calendario {datos.periodo.zona}) · generado {fechaHora(datos.generado_en)}</>}
          </p>
        </div>
        <Exportar onExcel={excel} deshabilitado={!datos || cargando} />
      </header>
      <Periodo periodo={periodo} onCambiar={setPeriodo} cargando={cargando} />
      {error && <div className="error">{error}</div>}

      {datos && (
        <>
          <section className="rep-kpis" aria-label="Totales de la red">
            <Indicador titulo="Ingresos netos de la red" valor={pesos(t.ingresos)} />
            <Indicador titulo="Facturas" valor={t.facturas.toLocaleString("es-CO")} detalle={`ticket promedio ${pesos(t.ticket_promedio)}`} />
            <Indicador titulo="Tiendas activas" valor={t.tiendas} />
          </section>

          <section className="rep-bloque">
            <h3>Ingresos netos por tienda</h3>
            <BarrasH
              titulo="Ingresos netos por tienda"
              datos={datos.tiendas.map((x) => ({
                clave: x.id_tienda,
                etiqueta: x.nombre,
                valor: x.ingresos,
                texto: x.sin_datos ? "sin datos consolidados" : pesos(x.ingresos),
                detalle: x.sin_datos ? null : `${x.participacion}% · ${x.facturas} facturas`,
              }))}
            />
          </section>

          <section className="rep-bloque">
            <h3>Indicadores de stock por tienda</h3>
            <BarrasH
              titulo="Productos agotados por tienda"
              datos={datos.tiendas.map((x) => ({
                clave: x.id_tienda,
                etiqueta: x.nombre,
                valor: x.agotados + x.bajo_minimo,
                tono: x.agotados > 0 ? "agotado" : "bajo",
                texto: `${x.agotados} agotados · ${x.bajo_minimo} bajo mínimo`,
              }))}
            />
          </section>

          <section className="rep-bloque">
            <h3>Detalle</h3>
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Tienda</th><th className="num">Ingresos netos</th><th className="num">Facturas</th><th className="num">Ticket prom.</th>
                    <th className="num">Part.</th><th className="num">Agotados</th><th className="num">Bajo mín.</th><th className="num">Sin reporte</th>
                    <th>Última sync ventas</th><th>Última sync stock</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.tiendas.map((x) => (
                    <tr key={x.id_tienda}>
                      <td><strong>{x.nombre}</strong><div className="muted">{x.ciudad}</div></td>
                      {x.sin_datos ? (
                        <td colSpan="4" className="muted">Sin datos consolidados</td>
                      ) : (
                        <>
                          <td className="num">{pesos(x.ingresos)}</td>
                          <td className="num">{x.facturas}</td>
                          <td className="num">{pesos(x.ticket_promedio)}</td>
                          <td className="num">{x.participacion}%</td>
                        </>
                      )}
                      <td className="num">{x.agotados}</td>
                      <td className="num">{x.bajo_minimo}</td>
                      <td className="num">{x.sin_reporte}</td>
                      <td>{x.sin_datos ? "nunca" : cuando(x.ultima_sync_ventas)}</td>
                      <td>{cuando(x.ultima_sync_stock)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {datos.metodos.length > 0 && (
            <section className="rep-bloque">
              <h3>Ingresos netos por método de pago</h3>
              <div className="tabla-scroll">
                <table className="tabla">
                  <thead>
                    <tr><th>Tienda</th>{datos.metodos.map((m) => <th key={m.id_metodo_pago} className="num">{m.metodo}</th>)}</tr>
                  </thead>
                  <tbody>
                    {datos.tiendas.filter((x) => x.metodos.length > 0).map((x) => (
                      <tr key={x.id_tienda}>
                        <td>{x.nombre}</td>
                        {datos.metodos.map((m) => {
                          const fila = x.metodos.find((y) => y.id_metodo_pago === m.id_metodo_pago);
                          return <td key={m.id_metodo_pago} className="num">{fila ? pesos(fila.ingresos) : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="muted rep-nota">
            Datos consolidados por la sincronización de cada tienda: pueden ir unos minutos atrasados. Las anulaciones y devoluciones ya están
            descontadas de los ingresos, en el día de la nota. Una factura pagada con dos métodos cuenta como factura en cada uno. "Sin reporte":
            productos activos de los que la tienda aún no informó stock. La caducidad por lote solo se ve en el reporte de cada tienda.
          </p>
        </>
      )}
    </article>
  );
}
