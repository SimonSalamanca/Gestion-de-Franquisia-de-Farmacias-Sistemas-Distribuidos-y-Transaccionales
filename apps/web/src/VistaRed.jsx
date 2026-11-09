import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora, pesos } from "./inventarioUi.jsx";
import { BarrasH, Indicador } from "./graficos.jsx";
import { Periodo } from "./Reportes.jsx";

// HU-16: vista consolidada de la red (RED_VISIBILIDAD). Monitoreo vivo: se refresca sola y cada tienda muestra la hora
// de su última información. Una tienda que no envió su información reciente se marca, nunca se muestra como actual.

const REFRESCO_MS = 30000;
const hoyUtc = () => new Date().toISOString().slice(0, 10);
const PARAMS = { desde: "vr_desde", hasta: "vr_hasta", tienda: "vr_tienda", categoria: "vr_categoria" };

function filtrosDeUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    desde: p.get(PARAMS.desde) || `${hoyUtc().slice(0, 8)}01`,
    hasta: p.get(PARAMS.hasta) || hoyUtc(),
    tienda: p.get(PARAMS.tienda) || "",
    categoria: p.get(PARAMS.categoria) || "",
  };
}

// Los filtros quedan en la URL para compartir la vista o volver a ella.
function filtrosAUrl(filtros) {
  const p = new URLSearchParams(window.location.search);
  for (const [clave, param] of Object.entries(PARAMS)) {
    if (filtros[clave]) p.set(param, filtros[clave]);
    else p.delete(param);
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${p}`);
}

function hace(minutos) {
  if (minutos == null) return "";
  if (minutos < 1) return "hace menos de 1 min";
  if (minutos < 60) return `hace ${minutos} min`;
  if (minutos < 48 * 60) return `hace ${Math.floor(minutos / 60)} h`;
  return `hace ${Math.floor(minutos / 1440)} días`;
}

export function Frescura({ frescura }) {
  if (frescura.estado === "SIN_DATOS") return <span className="pill media">Sin datos</span>;
  if (frescura.estado === "DESACTUALIZADA") {
    return <span className="pill agotado" title={`Última información: ${fechaHora(frescura.ultima_actualizacion)}`}>Desactualizada · {hace(frescura.minutos)}</span>;
  }
  return <span className="pill disponible">Al día · {hace(frescura.minutos)}</span>;
}

function AvisoFrescura({ datos }) {
  const f = datos.frescura;
  if (f.estado === "AL_DIA") {
    return (
      <div className="ok vr-aviso" role="status">
        Toda la red está al día: información hasta {fechaHora(f.actualizado_hasta)} (se considera al día si llegó en los últimos {datos.max_retraso_min} min).
      </div>
    );
  }
  return (
    <div className="error vr-aviso" role="alert">
      {f.desactualizadas.length > 0 && (
        <p>
          <strong>{f.desactualizadas.length === 1 ? "Una tienda no ha enviado" : `${f.desactualizadas.length} tiendas no han enviado`} su información reciente.</strong>{" "}
          Sus cifras son de la hora indicada, no actuales:{" "}
          {f.desactualizadas.map((t, i) => (
            <span key={t.id_tienda}>{i > 0 ? "; " : ""}<strong>{t.nombre}</strong> (última {fechaHora(t.ultima_actualizacion)}, {hace(t.minutos)})</span>
          ))}
          .
        </p>
      )}
      {f.sin_datos.length > 0 && (
        <p>
          Sin datos consolidados (nunca enviaron información): {f.sin_datos.map((t) => t.nombre).join(", ")}.
        </p>
      )}
      {f.actualizado_hasta && <p className="muted">Las tiendas al día tienen información hasta {fechaHora(f.actualizado_hasta)}.</p>}
    </div>
  );
}

export default function VistaRed({ session }) {
  const token = session.token;
  const [filtros, setFiltros] = useState(filtrosDeUrl);
  const [opciones, setOpciones] = useState({ tiendas: [], categorias: [] });
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [actualizado, setActualizado] = useState(null);

  useEffect(() => {
    api("/api/central/red/filtros", { token }).then((r) => r.ok && setOpciones(r.data));
  }, [token]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const q = new URLSearchParams({ desde: filtros.desde, hasta: filtros.hasta });
      if (filtros.tienda) q.set("tienda", filtros.tienda);
      if (filtros.categoria) q.set("categoria", filtros.categoria);
      const r = await api(`/api/central/red/consolidado?${q}`, { token });
      if (r.ok) {
        setDatos(r.data);
        setError("");
        setActualizado(new Date());
      } else if (r.status === 503) {
        setError(`Sin conexión con el nodo central: la vista de red no está disponible. Última sincronización: ${r.data.ultima_sync ? fechaHora(r.data.ultima_sync) : "nunca"}.`);
      } else setError(r.data.mensaje || "No se pudo cargar la vista de red");
    } catch {
      setError("No hay respuesta del servidor");
    } finally {
      setCargando(false);
    }
  }, [filtros, token]);

  // Se refresca sola mientras la pestaña está visible.
  useEffect(() => {
    filtrosAUrl(filtros);
    cargar();
    const timer = setInterval(() => document.visibilityState === "visible" && cargar(), REFRESCO_MS);
    return () => clearInterval(timer);
  }, [cargar, filtros]);

  const cambiar = (cambio) => setFiltros((f) => ({ ...f, ...cambio }));
  const conCategoria = Boolean(filtros.categoria);
  const nombreCategoria = opciones.categorias.find((c) => String(c.id_categoria) === filtros.categoria)?.nombre;
  const t = datos?.totales;

  return (
    <article className="reporte vista-red">
      <header className="rep-cabecera">
        <div>
          <h2>Vista de red</h2>
          <p className="muted">
            Inventario, ventas e ingresos consolidados de las tiendas activas. Se actualiza solo cada {REFRESCO_MS / 1000} s
            {actualizado && <> · consultado {actualizado.toLocaleTimeString()}</>}.
          </p>
        </div>
        <button className="ghost" onClick={cargar} disabled={cargando}>{cargando ? "Actualizando…" : "Actualizar"}</button>
      </header>

      <div className="vr-filtros">
        <label>
          Tienda
          <select value={filtros.tienda} onChange={(e) => cambiar({ tienda: e.target.value })}>
            <option value="">Todas las tiendas</option>
            {opciones.tiendas.map((x) => <option key={x.id_tienda} value={x.id_tienda}>{x.nombre}</option>)}
          </select>
        </label>
        <label>
          Categoría
          <select value={filtros.categoria} onChange={(e) => cambiar({ categoria: e.target.value })}>
            <option value="">Todas las categorías</option>
            {opciones.categorias.map((c) => <option key={c.id_categoria} value={c.id_categoria}>{c.nombre}</option>)}
          </select>
        </label>
      </div>
      <Periodo periodo={filtros} onCambiar={(p) => cambiar(p)} cargando={cargando} />
      {error && <div className="error">{error}</div>}

      {datos && (
        <>
          <AvisoFrescura datos={datos} />

          <section className="rep-kpis" aria-label="Totales">
            <Indicador titulo={conCategoria ? `Ingresos netos · ${nombreCategoria ?? "categoría"}` : "Ingresos netos"} valor={pesos(t.ingresos)} detalle={`${fechaCorta(datos.periodo.desde)} a ${fechaCorta(datos.periodo.hasta)}`} />
            <Indicador titulo="Facturas" valor={t.facturas == null ? "—" : t.facturas.toLocaleString("es-CO")} detalle={t.facturas == null ? "no aplica a una categoría" : `ticket promedio ${pesos(t.ticket_promedio ?? 0)}`} />
            <Indicador titulo="Unidades vendidas" valor={t.unidades.toLocaleString("es-CO")} detalle={datos.categorias_desde ? `registradas desde ${fechaCorta(datos.categorias_desde)}` : "aún sin registro por categoría"} />
            <Indicador titulo="Inventario en la red" valor={`${t.inventario.unidades.toLocaleString("es-CO")} u.`} detalle={`${t.inventario.agotados} agotados · ${t.inventario.bajo_minimo} bajo mínimo`} />
          </section>
          {datos.categorias_desde && datos.categorias_desde > datos.periodo.desde && (
            <p className="muted rep-nota">
              Las ventas por categoría y las unidades se registran desde el {fechaCorta(datos.categorias_desde)}: las ventas anteriores del periodo solo cuentan en los
              ingresos totales (sin filtro de categoría).
            </p>
          )}

          <section className="rep-bloque">
            <h3>Tiendas</h3>
            <div className="tabla-scroll">
              <table className="tabla vr-tiendas">
                <thead>
                  <tr>
                    <th>Tienda</th><th>Información</th><th className="num">Ingresos netos</th><th className="num">Facturas</th><th className="num">Unidades</th>
                    <th className="num">Stock (u.)</th><th className="num">Agotados</th><th className="num">Bajo mín.</th><th className="num">Sin reporte</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.tiendas.map((x) => {
                    const vieja = x.frescura.estado !== "AL_DIA";
                    return (
                      <tr key={x.id_tienda} className={vieja ? "vr-vieja" : undefined}>
                        <td><strong>{x.nombre}</strong><div className="muted">{x.ciudad}</div></td>
                        <td>
                          <Frescura frescura={x.frescura} />
                          <div className="muted">{x.frescura.ultima_actualizacion ? `datos de ${fechaHora(x.frescura.ultima_actualizacion)}` : "nunca envió información"}</div>
                        </td>
                        {x.frescura.estado === "SIN_DATOS" ? (
                          <td colSpan="7" className="muted">Sin datos consolidados</td>
                        ) : (
                          <>
                            <td className="num">{pesos(x.ventas.ingresos)}</td>
                            <td className="num">{x.ventas.facturas ?? "—"}</td>
                            <td className="num">{x.ventas.unidades}</td>
                            <td className="num">{x.inventario.unidades}</td>
                            <td className="num">{x.inventario.agotados}</td>
                            <td className="num">{x.inventario.bajo_minimo}</td>
                            <td className="num">{x.inventario.sin_reporte}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rep-bloque">
            <h3>Ingresos netos por tienda</h3>
            <BarrasH
              titulo="Ingresos netos por tienda"
              datos={datos.tiendas.map((x) => ({
                clave: x.id_tienda,
                etiqueta: x.nombre,
                valor: x.ventas.ingresos,
                tono: x.frescura.estado === "DESACTUALIZADA" ? "bajo" : undefined,
                texto: x.frescura.estado === "SIN_DATOS" ? "sin datos" : pesos(x.ventas.ingresos),
                detalle: x.frescura.estado === "DESACTUALIZADA" ? `datos de ${fechaHora(x.frescura.ultima_actualizacion)}` : null,
              }))}
            />
          </section>

          <section className="rep-bloque">
            <h3>{conCategoria ? `Ventas de ${nombreCategoria ?? "la categoría"}` : "Ventas por categoría"}</h3>
            <BarrasH
              titulo="Ingresos netos por categoría"
              datos={datos.categorias.map((c) => ({ clave: c.id_categoria, etiqueta: c.categoria, valor: c.ingresos, detalle: `${c.unidades} u.` }))}
              formato={pesos}
            />
          </section>

          {!conCategoria && datos.metodos.length > 0 && (
            <section className="rep-bloque">
              <h3>Ingresos netos por método de pago</h3>
              <div className="tabla-scroll">
                <table className="tabla">
                  <thead>
                    <tr><th>Tienda</th>{datos.metodos.map((m) => <th key={m.id_metodo_pago} className="num">{m.metodo}</th>)}</tr>
                  </thead>
                  <tbody>
                    {datos.tiendas.filter((x) => x.ventas.metodos.length > 0).map((x) => (
                      <tr key={x.id_tienda}>
                        <td>{x.nombre}</td>
                        {datos.metodos.map((m) => {
                          const fila = x.ventas.metodos.find((y) => y.id_metodo_pago === m.id_metodo_pago);
                          return <td key={m.id_metodo_pago} className="num">{fila ? pesos(fila.ingresos) : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <InventarioRed token={token} filtros={filtros} tiendas={datos.tiendas} />

          <p className="muted rep-nota">
            Cada tienda envía su información al nodo central cada pocos segundos y una foto completa de su stock cada 2 minutos, aunque no venda. Una tienda pasa a
            "desactualizada" si su última información tiene más de {datos.max_retraso_min} minutos. Días de calendario {datos.periodo.zona}; las anulaciones y devoluciones
            ya están descontadas en el día de la nota.
          </p>
        </>
      )}
    </article>
  );
}

const ETIQUETA_ESTADO = { agotado: "agotado", bajo: "bajo", disponible: "", sin_reporte: "sin reporte" };

function InventarioRed({ token, filtros, tiendas }) {
  const [q, setQ] = useState("");
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const ultimo = useRef(0);

  useEffect(() => setPagina(1), [q, filtros.tienda, filtros.categoria]);

  useEffect(() => {
    const id = ++ultimo.current;
    const timer = setTimeout(async () => {
      const p = new URLSearchParams({ pagina: String(pagina) });
      if (q.trim()) p.set("q", q.trim());
      if (filtros.tienda) p.set("tienda", filtros.tienda);
      if (filtros.categoria) p.set("categoria", filtros.categoria);
      const r = await api(`/api/central/red/inventario?${p}`, { token });
      if (id !== ultimo.current) return; // llegó una respuesta vieja
      if (r.ok) {
        setDatos(r.data);
        setError("");
      } else setError(r.data.mensaje || "No se pudo cargar el inventario de la red");
    }, 250);
    return () => clearTimeout(timer);
  }, [q, pagina, filtros.tienda, filtros.categoria, token]);

  const vieja = new Map(tiendas.map((x) => [x.id_tienda, x.frescura.estado !== "AL_DIA"]));
  const columnas = datos?.productos[0]?.tiendas.map((x) => tiendas.find((y) => y.id_tienda === x.id_tienda) ?? { id_tienda: x.id_tienda, nombre: `Tienda ${x.id_tienda}` }) ?? [];

  return (
    <section className="rep-bloque">
      <h3>Inventario por producto</h3>
      <input className="vr-buscar" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, principio activo o código" aria-label="Buscar producto en la red" />
      {error && <div className="error">{error}</div>}
      {datos && datos.productos.length === 0 && <p className="muted">Ningún producto coincide.</p>}
      {datos && datos.productos.length > 0 && (
        <>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Producto</th>
                  {columnas.map((c) => <th key={c.id_tienda} className="num">{c.nombre}{vieja.get(c.id_tienda) ? " *" : ""}</th>)}
                  <th className="num">Total red</th>
                </tr>
              </thead>
              <tbody>
                {datos.productos.map((p) => (
                  <tr key={p.id_medicamento}>
                    <td><strong>{p.nombre_comercial}</strong><div className="muted">{p.codigo_interno} · {p.categoria}</div></td>
                    {p.tiendas.map((x) => (
                      <td key={x.id_tienda} className="num" title={x.sincronizado ? `Foto de ${fechaHora(x.sincronizado)}${x.stock_minimo != null ? ` · mínimo ${x.stock_minimo}` : ""}` : "La tienda no ha informado este producto"}>
                        {x.cantidad == null ? <span className="muted">—</span> : x.cantidad}
                        {ETIQUETA_ESTADO[x.estado] && <div><span className={`pill ${x.estado === "sin_reporte" ? "media" : x.estado}`}>{ETIQUETA_ESTADO[x.estado]}</span></div>}
                      </td>
                    ))}
                    <td className="num"><strong>{p.total_red}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row inv-paginas">
            <button className="ghost" disabled={pagina <= 1} onClick={() => setPagina((n) => n - 1)}>Anterior</button>
            <span className="muted">Página {datos.pagina} de {datos.paginas} · {datos.total} productos</span>
            <button className="ghost" disabled={pagina >= datos.paginas} onClick={() => setPagina((n) => n + 1)}>Siguiente</button>
          </div>
          {[...vieja.values()].some(Boolean) && <p className="muted rep-nota">* Tienda desactualizada: sus cantidades son de su última foto, no actuales.</p>}
        </>
      )}
    </section>
  );
}
