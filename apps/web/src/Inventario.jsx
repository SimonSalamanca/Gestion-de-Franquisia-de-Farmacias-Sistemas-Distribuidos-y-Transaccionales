import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { DetalleMedicamento, Indicadores } from "./inventarioUi.jsx";

// HU-01: búsqueda de medicamentos con filtros combinables y existencias en la red (RF-01, RF-03).
// Refresca cada 5 s mientras la pantalla está visible; la red puede ir atrasada (RNF-13).

const ESPERA_TECLEO_MS = 300;
const REFRESCO_MS = 5000;
const DESACTUALIZADO_MS = 5 * 60 * 1000;
const FILTROS = ["q", "categoria", "estado", "tienda", "pagina"];
const ESTADOS = [
  ["disponible", "Disponible"],
  ["bajo", "Bajo"],
  ["agotado", "Agotado"],
];

function filtrosDeUrl() {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(FILTROS.map((campo) => [campo, params.get(campo) || ""]));
}

function reflejarEnUrl(filtros) {
  const params = new URLSearchParams();
  for (const campo of FILTROS) if (filtros[campo]) params.set(campo, filtros[campo]);
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

function hora(fecha) {
  return fecha ? new Date(fecha).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "sin dato";
}

function hace(fecha, ahora) {
  if (!fecha) return "sin reporte";
  const segundos = Math.max(0, Math.round((ahora - new Date(fecha).getTime()) / 1000));
  if (segundos < 60) return `actualizado hace ${segundos} s`;
  if (segundos < 3600) return `actualizado hace ${Math.round(segundos / 60)} min`;
  return `actualizado a las ${hora(fecha)}`;
}

function sinRed(ultimaSync) {
  return `Existencias de la red no disponibles — última sincronización ${hora(ultimaSync)}`;
}

export default function Inventario({ session, ultimaSync }) {
  const [filtros, setFiltros] = useState(filtrosDeUrl);
  const [termino, setTermino] = useState(filtros.q);
  const [categorias, setCategorias] = useState([]);
  const [tiendas, setTiendas] = useState([]);
  const [datos, setDatos] = useState(null);
  const [aviso, setAviso] = useState("");
  const [cargando, setCargando] = useState(false);
  // Panel "Disponible en otras tiendas" por medicamento: { abierto, datos, error }.
  const [red, setRed] = useState({});
  const [ahora, setAhora] = useState(() => Date.now());
  // HU-02: detalle del medicamento (condiciones especiales, lotes e historial) abierto en la lista.
  const [detalle, setDetalle] = useState(null);
  const pedido = useRef(0);
  // Refs para leer el valor actual sin volver a disparar la búsqueda cuando cambian.
  const ultimaSyncRef = useRef(ultimaSync);
  ultimaSyncRef.current = ultimaSync;
  const redRef = useRef(red);
  redRef.current = red;

  const llamar = useCallback((ruta) => api(ruta, { token: session.token }), [session.token]);

  useEffect(() => {
    llamar("/api/local/inventario/categorias").then((r) => r.ok && setCategorias(r.data));
    llamar("/api/local/inventario/tiendas").then((r) => r.ok && setTiendas(r.data));
  }, [llamar]);

  // Espera de 300 ms tras teclear antes de buscar.
  useEffect(() => {
    if (termino === filtros.q) return undefined;
    const timer = setTimeout(() => setFiltros((f) => ({ ...f, q: termino, pagina: "" })), ESPERA_TECLEO_MS);
    return () => clearTimeout(timer);
  }, [termino, filtros.q]);

  useEffect(() => reflejarEnUrl(filtros), [filtros]);

  const hayFiltro = Boolean(filtros.categoria || filtros.estado || filtros.tienda);
  const q = filtros.q.trim();
  const buscable = q.length >= 2 || (q.length === 0 && hayFiltro);

  const cargarRed = useCallback(
    async (id) => {
      const r = await llamar(`/api/local/inventario/red/${id}`);
      setRed((actual) => ({
        ...actual,
        [id]: {
          abierto: actual[id]?.abierto ?? true,
          datos: r.ok ? r.data : actual[id]?.datos ?? null,
          error: r.ok ? "" : r.status === 503 ? sinRed(r.data.ultima_sync || ultimaSyncRef.current) : r.data.mensaje || "No se pudo consultar la red",
        },
      }));
    },
    [llamar],
  );

  const buscar = useCallback(
    async ({ silencioso = false } = {}) => {
      if (!buscable) {
        setDatos(null);
        setAviso(q.length === 1 ? "Escriba al menos 2 caracteres o elija un filtro" : "");
        return;
      }
      const id = ++pedido.current;
      if (!silencioso) setCargando(true);
      const params = new URLSearchParams();
      for (const campo of FILTROS) if (filtros[campo]) params.set(campo, filtros[campo]);
      const r = await llamar(`/api/local/inventario/buscar?${params}`);
      if (id !== pedido.current) return; // llegó una búsqueda más nueva
      setCargando(false);
      setAhora(Date.now());
      if (!r.ok) {
        if (!silencioso || r.status !== 503) setDatos(null);
        if (r.status === 401) setAviso("Su sesión expiró. Vuelva a iniciar sesión.");
        else if (r.status === 503) setAviso(sinRed(r.data.ultima_sync || ultimaSyncRef.current));
        else setAviso(r.data.mensaje || "No se pudo buscar");
        return;
      }
      setAviso("");
      setDatos(r.data);
      // Criterio 2: sin stock en la tienda propia, la red se consulta sola (una vez; luego la refresca el ciclo).
      if (r.data.tienda.propia) {
        for (const item of r.data.resultados) {
          if (item.stock_tienda === 0 && !redRef.current[item.id_medicamento]) cargarRed(item.id_medicamento);
        }
      }
    },
    [buscable, q, filtros, llamar, cargarRed],
  );

  useEffect(() => {
    redRef.current = {};
    setRed({});
    buscar();
  }, [buscar]);

  // Refresco periódico de lo visible: resultados y paneles de red abiertos.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      buscar({ silencioso: true });
      for (const [id, panel] of Object.entries(redRef.current)) {
        if (panel.abierto) cargarRed(id);
      }
    }, REFRESCO_MS);
    return () => clearInterval(timer);
  }, [buscar, cargarRed]);

  function cambiar(campo, valor) {
    setFiltros((f) => ({ ...f, [campo]: valor, pagina: campo === "pagina" ? valor : "" }));
  }

  function alternarRed(id) {
    const panel = red[id];
    if (panel?.abierto) {
      setRed((actual) => ({ ...actual, [id]: { ...panel, abierto: false } }));
      return;
    }
    setRed((actual) => ({ ...actual, [id]: { abierto: true, datos: panel?.datos ?? null, error: "" } }));
    cargarRed(id);
  }

  const pagina = datos?.pagina ?? 1;

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Inventario</h2>
        <p className="muted">Busque por nombre comercial, principio activo o código.</p>
      </header>

      <div className="inv-filtros">
        <input
          className="inv-busqueda"
          placeholder="Ej.: acetaminofén, ibuprofeno, MED-004"
          value={termino}
          maxLength={80}
          autoFocus
          onChange={(event) => setTermino(event.target.value)}
          aria-label="Buscar medicamento"
        />
        <select value={filtros.tienda} onChange={(event) => cambiar("tienda", event.target.value)} aria-label="Tienda">
          {tiendas.map((tienda) => (
            <option key={tienda.id_tienda} value={tienda.propia ? "" : tienda.id_tienda}>
              {tienda.nombre}{tienda.propia ? " (esta tienda)" : ""}
            </option>
          ))}
        </select>
        <select value={filtros.categoria} onChange={(event) => cambiar("categoria", event.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {categorias.map((categoria) => (
            <option key={categoria.id_categoria} value={categoria.id_categoria}>{categoria.nombre}</option>
          ))}
        </select>
        <select value={filtros.estado} onChange={(event) => cambiar("estado", event.target.value)} aria-label="Estado de stock">
          <option value="">Cualquier estado</option>
          {ESTADOS.map(([valor, texto]) => <option key={valor} value={valor}>{texto}</option>)}
        </select>
      </div>

      {aviso && <div className="error">{aviso}</div>}
      {cargando && !datos && <p className="muted">Buscando…</p>}
      {!buscable && !aviso && <p className="muted">Escriba al menos 2 caracteres o elija un filtro para ver medicamentos.</p>}

      {datos && (
        <>
          <p className="muted inv-resumen">
            {datos.total} resultado{datos.total === 1 ? "" : "s"} en {datos.tienda.propia ? "esta tienda" : datos.tienda.nombre}
            {datos.truncado ? " (se muestran las primeras coincidencias; afine la búsqueda)" : ""}
          </p>
          {datos.total === 0 && (
            <div className="inv-vacio">
              {datos.termino ? `No se encontraron medicamentos para «${datos.termino}»` : "Ningún medicamento cumple los filtros elegidos"}
            </div>
          )}
          <ul className="inv-lista">
            {datos.resultados.map((item) => {
              const panel = red[item.id_medicamento];
              return (
                <li key={item.id_medicamento} className="inv-item">
                  <div className="inv-fila">
                    <div>
                      <button className="enlace" onClick={() => setDetalle(detalle === item.id_medicamento ? null : item.id_medicamento)}>
                        {item.nombre_comercial}
                      </button>
                      <div className="muted">
                        {item.principio_activo} · {item.codigo_interno}{item.categoria ? ` · ${item.categoria}` : ""}
                      </div>
                      <div className="inv-marcas"><Indicadores medicamento={item} /></div>
                    </div>
                    <div className="inv-stock">
                      <span className="inv-cantidad">{item.stock_tienda}</span>
                      <span className={`pill ${item.estado_stock}`}>{item.estado_stock}</span>
                      {!datos.tienda.propia && (
                        <span className={`muted inv-hace${item.actualizado_en && ahora - new Date(item.actualizado_en).getTime() > DESACTUALIZADO_MS ? " viejo" : ""}`}>
                          {hace(item.actualizado_en, ahora)}
                        </span>
                      )}
                      <button className="ghost" onClick={() => alternarRed(item.id_medicamento)}>
                        {panel?.abierto ? "Ocultar red" : "Ver en la red"}
                      </button>
                    </div>
                  </div>
                  {detalle === item.id_medicamento && (
                    <DetalleMedicamento token={session.token} idMedicamento={item.id_medicamento} onCerrar={() => setDetalle(null)} />
                  )}
                  {panel?.abierto && <PanelRed panel={panel} ahora={ahora} />}
                </li>
              );
            })}
          </ul>
          {datos.paginas > 1 && (
            <div className="row inv-paginas">
              <button className="ghost" disabled={pagina <= 1} onClick={() => cambiar("pagina", String(pagina - 1))}>Anterior</button>
              <span className="muted">Página {pagina} de {datos.paginas}</span>
              <button className="ghost" disabled={pagina >= datos.paginas} onClick={() => cambiar("pagina", String(pagina + 1))}>Siguiente</button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function PanelRed({ panel, ahora }) {
  if (panel.error) return <div className="inv-red error">{panel.error}</div>;
  if (!panel.datos) return <div className="inv-red muted">Consultando la red…</div>;
  const conStock = panel.datos.tiendas.filter((tienda) => tienda.cantidad > 0);
  return (
    <div className="inv-red">
      <strong>Disponible en otras tiendas</strong>
      {conStock.length === 0 && <p className="muted">Ninguna otra tienda de la red reporta existencias.</p>}
      {conStock.length > 0 && (
        <table>
          <tbody>
            {conStock.map((tienda) => {
              const viejo = tienda.actualizado_en && ahora - new Date(tienda.actualizado_en).getTime() > DESACTUALIZADO_MS;
              return (
                <tr key={tienda.id_tienda}>
                  <td>{tienda.nombre}{tienda.ciudad ? ` · ${tienda.ciudad}` : ""}</td>
                  <td className="num">{tienda.cantidad}</td>
                  <td><span className={`pill ${tienda.estado_stock}`}>{tienda.estado_stock}</span></td>
                  <td className={`muted inv-hace${viejo ? " viejo" : ""}`}>
                    {hace(tienda.actualizado_en, ahora)}{viejo ? " · desactualizado" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
