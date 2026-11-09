import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaHora } from "./inventarioUi.jsx";
import { ESTADOS, mensajeError, useEnvio } from "./abastecimientoUi.jsx";

// HU-13: solicitudes de reabastecimiento (RF-09). Todo es local: se generan y se consultan sin conexión con el central.
// La recepción de la mercancía se hace en "Lotes y recepción" (HU-02/HU-14); aquí se sigue el estado de cada solicitud.

const FILTROS = ["PENDIENTE", "ENVIADA", "RECIBIDA", "CANCELADA"];
const BASE = "/api/local/solicitudes";

function useProveedoresActivos(token) {
  const [proveedores, setProveedores] = useState([]);
  useEffect(() => {
    api("/api/local/proveedores", { token }).then((r) => {
      if (r.ok) setProveedores(r.data);
    });
  }, [token]);
  return proveedores;
}

function SelectorProveedor({ proveedores, valor, onChange }) {
  return (
    <select value={valor} onChange={(e) => onChange(e.target.value)} aria-label="Proveedor">
      <option value="">Elija el proveedor (obligatorio)</option>
      {proveedores.map((p) => <option key={p.id_proveedor} value={p.id_proveedor}>{p.nombre_empresa}</option>)}
    </select>
  );
}

export default function Solicitudes({ session }) {
  const token = session.token;
  const [filtro, setFiltro] = useState("");
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [nueva, setNueva] = useState(false);

  const cargar = useCallback(async () => {
    const r = await api(`${BASE}${filtro ? `?estado=${filtro}` : ""}`, { token });
    if (r.ok) {
      setDatos(r.data);
      setError("");
    } else setError(mensajeError(r));
  }, [token, filtro]);

  useEffect(() => {
    cargar();
  }, [cargar, version]);

  return (
    <div>
      <p className="muted">
        Pedidos de reabastecimiento a proveedores. Una solicitud nace de una alerta de stock bajo (desde Inventario &gt; Alertas) o se
        genera aquí a mano, y siempre lleva un proveedor. Se guardan en esta tienda aunque no haya conexión con el central.
      </p>
      <div className="row" role="group" aria-label="Filtrar por estado">
        <button className={filtro === "" ? "primary" : "ghost"} onClick={() => setFiltro("")}>Todas</button>
        {FILTROS.map((f) => (
          <button key={f} className={filtro === f ? "primary" : "ghost"} onClick={() => setFiltro(filtro === f ? "" : f)}>
            {ESTADOS[f].etiqueta} ({datos?.resumen?.[f] ?? 0})
          </button>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={() => setNueva((v) => !v)}>{nueva ? "Cerrar" : "Nueva solicitud manual"}</button>
      </div>
      {nueva && <FormManual token={token} onListo={() => { setNueva(false); setVersion((v) => v + 1); }} />}
      {error && <div className="error">{error}</div>}
      {datos && datos.solicitudes.length === 0 && <div className="inv-vacio">No hay solicitudes{filtro ? " con ese estado" : ""}.</div>}
      <ul className="inv-lista">
        {(datos?.solicitudes || []).map((s) => (
          <Solicitud key={s.id_pedido} s={s} token={token} onCambio={() => setVersion((v) => v + 1)} />
        ))}
      </ul>
    </div>
  );
}

function Solicitud({ s, token, onCambio }) {
  const { enviar, ocupado } = useEnvio(token);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [recepciones, setRecepciones] = useState(null);
  const estado = ESTADOS[s.estado_visible];
  const tieneRecepciones = ["RECIBIDA", "RECIBIDA_PARCIAL"].includes(s.estado_visible) || s.con_diferencia;

  // HU-14: la recepción queda ligada a la solicitud: quién recibió, cuándo, qué lote y qué diferencias quedaron.
  async function verRecepciones() {
    if (recepciones) return setRecepciones(null);
    const r = await api(`${BASE}/${s.id_pedido}/recepciones`, { token });
    if (r.ok) setRecepciones(r.data);
    else setError(mensajeError(r));
  }

  async function accion(nombre, body) {
    setError("");
    const r = await enviar(`${BASE}/${s.id_pedido}/${nombre}`, "POST", body);
    if (!r.ok) return setError(mensajeError(r));
    setCancelando(false);
    onCambio();
  }

  return (
    <li className="inv-item">
      <div className="inv-fila">
        <div>
          <strong>Solicitud {s.id_pedido}</strong> <span className={`pill ${estado.pill}`}>{estado.etiqueta}</span>{s.con_diferencia && <> <span className="pill bajo">Con diferencia</span></>} · {s.proveedor}
          <div className="muted">
            {s.origen_solicitud === "ALERTA_AUTOMATICA" ? "Desde una alerta de stock" : "Manual"} · {s.solicitante} · {fechaHora(s.fecha_solicitud)}
            {s.fecha_envio ? ` · enviada ${fechaHora(s.fecha_envio)}` : ""}
            {s.fecha_recepcion ? ` · recibida ${fechaHora(s.fecha_recepcion)}` : ""}
          </div>
          {s.estado_visible === "CANCELADA" && s.observaciones && <div className="muted">Motivo: {s.observaciones}</div>}
          <ul className="lineas">
            {s.lineas.map((l) => (
              <li key={l.id_medicamento}>
                {l.nombre_comercial} · pedidas {l.cantidad_solicitada}
                {Number(l.cantidad_recibida) > 0 ? ` · recibidas ${l.cantidad_recibida}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className="inv-stock">
          {s.estado_visible === "PENDIENTE" && <button className="ghost" disabled={ocupado} onClick={() => accion("enviar")}>Marcar como enviada</button>}
          {tieneRecepciones && <button className="ghost" onClick={verRecepciones}>{recepciones ? "Ocultar recepciones" : "Ver recepciones"}</button>}
          {(s.estado_visible === "PENDIENTE" || s.estado_visible === "ENVIADA") && (
            <button className="ghost" onClick={() => setCancelando((v) => !v)}>{cancelando ? "No cancelar" : "Cancelar"}</button>
          )}
        </div>
      </div>
      {(s.estado_visible === "PENDIENTE" || s.estado_visible === "ENVIADA") && (
        <p className="muted">La mercancía se recibe en «Lotes y recepción».</p>
      )}
      {recepciones && (
        <div className="historial">
          {recepciones.recepciones.length === 0 && <p className="muted">Sin recepciones registradas con este sistema.</p>}
          <ul className="lineas">
            {recepciones.recepciones.map((r) => (
              <li key={r.id_recepcion}>
                <strong>Recepción {r.id_recepcion}</strong> · {fechaHora(r.fecha_hora)} · {r.responsable}
                {r.documento_proveedor ? ` · documento ${r.documento_proveedor}` : ""}
                <ul className="lineas">
                  {r.lineas.map((x, i) => <li key={i}>{x.nombre_comercial}: {x.cantidad} u. · lote {x.numero_lote} · vence {x.fecha_caducidad}</li>)}
                </ul>
              </li>
            ))}
          </ul>
          {recepciones.diferencias.map((d) => (
            <div key={d.id_diferencia} className="muted">
              Diferencia: {d.nombre_comercial} · {d.tipo === "SOBRANTE" ? "sobran" : "faltan"} {Math.abs(d.diferencia)} (pedidas {d.cantidad_solicitada}, recibidas {d.cantidad_recibida}) · {d.responsable}, {fechaHora(d.fecha_hora)}. Motivo: {d.motivo}
            </div>
          ))}
        </div>
      )}
      {cancelando && (
        <form className="subform" onSubmit={(e) => { e.preventDefault(); accion("cancelar", { motivo }); }}>
          <input placeholder="Motivo de la cancelación (mínimo 5 caracteres)" value={motivo} onChange={(e) => setMotivo(e.target.value)} aria-label="Motivo" maxLength={300} />
          <button className="primary" disabled={ocupado || motivo.trim().length < 5}>Cancelar solicitud</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </li>
  );
}

// Criterio 3: solicitud manual, sin alerta activa. Medicamento por búsqueda; la cantidad la decide quien pide.
function FormManual({ token, onListo }) {
  const proveedores = useProveedoresActivos(token);
  const { enviar, ocupado } = useEnvio(token);
  const [idProveedor, setIdProveedor] = useState("");
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState([]);
  const [lineas, setLineas] = useState([]);
  const [observaciones, setObservaciones] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (texto.trim().length < 2) return setResultados([]);
    const timer = setTimeout(() => {
      api(`${BASE}/medicamentos?q=${encodeURIComponent(texto.trim())}`, { token }).then((r) => r.ok && setResultados(r.data.medicamentos));
    }, 300);
    return () => clearTimeout(timer);
  }, [token, texto]);

  const agregar = (m) => {
    if (lineas.some((l) => l.id_medicamento === m.id_medicamento)) return;
    setLineas((ls) => [...ls, { ...m, cantidad: String(Math.max((m.stock_minimo ?? 0) * 2 - m.stock, 1)) }]);
    setTexto("");
  };

  async function guardar(event) {
    event.preventDefault();
    setError("");
    if (!idProveedor) return setError("La solicitud necesita un proveedor");
    if (lineas.length === 0) return setError("Agregue al menos un producto");
    if (lineas.some((l) => !/^\d+$/.test(l.cantidad) || Number(l.cantidad) < 1)) return setError("Cada cantidad debe ser un entero mayor que cero");
    const r = await enviar(BASE, "POST", {
      id_proveedor: Number(idProveedor),
      observaciones: observaciones.trim() || undefined,
      lineas: lineas.map((l) => ({ id_medicamento: l.id_medicamento, cantidad: Number(l.cantidad) })),
    });
    if (!r.ok) return setError(mensajeError(r));
    onListo(r.data);
  }

  return (
    <form className="subform" onSubmit={guardar}>
      <strong>Nueva solicitud manual</strong>
      <SelectorProveedor proveedores={proveedores} valor={idProveedor} onChange={setIdProveedor} />
      <input placeholder="Buscar medicamento por nombre, principio activo o código" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar medicamento" />
      {resultados.length > 0 && (
        <ul className="inv-lista">
          {resultados.map((m) => (
            <li key={m.id_medicamento} className="inv-item">
              <div className="inv-fila">
                <div>
                  {m.nombre_comercial} <span className="muted">· stock {m.stock}{m.stock_minimo != null ? ` de un mínimo de ${m.stock_minimo}` : ""}</span>
                </div>
                <button type="button" className="ghost" onClick={() => agregar(m)}>Agregar</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {lineas.length > 0 && (
        <ul className="lineas">
          {lineas.map((l) => (
            <li key={l.id_medicamento}>
              {l.nombre_comercial}{" "}
              <input
                type="number"
                min="1"
                value={l.cantidad}
                onChange={(e) => setLineas((ls) => ls.map((x) => (x.id_medicamento === l.id_medicamento ? { ...x, cantidad: e.target.value } : x)))}
                aria-label={`Cantidad de ${l.nombre_comercial}`}
              />{" "}
              <button type="button" className="enlace" onClick={() => setLineas((ls) => ls.filter((x) => x.id_medicamento !== l.id_medicamento))}>Quitar</button>
            </li>
          ))}
        </ul>
      )}
      <input placeholder="Observaciones (opcional)" value={observaciones} onChange={(e) => setObservaciones(e.target.value)} aria-label="Observaciones" maxLength={300} />
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Generar solicitud"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

// Criterio 2: desde una alerta de stock bajo o agotado. El producto, la cantidad sugerida y el proveedor habitual salen de
// la alerta: no se vuelven a ingresar. Se muestra bajo la alerta en Inventario > Alertas.
export function SolicitudDeAlerta({ token, idAlerta, onListo }) {
  const proveedores = useProveedoresActivos(token);
  const { enviar, ocupado } = useEnvio(token);
  const [sugerencia, setSugerencia] = useState(null);
  const [idProveedor, setIdProveedor] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [error, setError] = useState("");
  const [creada, setCreada] = useState(null);

  useEffect(() => {
    api(`/api/local/alertas/${idAlerta}/solicitud`, { token }).then((r) => {
      if (!r.ok) return setError(mensajeError(r));
      setSugerencia(r.data);
      setCantidad(String(r.data.cantidad_sugerida));
      setIdProveedor(r.data.proveedor_sugerido ? String(r.data.proveedor_sugerido.id_proveedor) : "");
    });
  }, [token, idAlerta]);

  async function generar(event) {
    event.preventDefault();
    setError("");
    if (!idProveedor) return setError("La solicitud necesita un proveedor");
    if (!/^\d+$/.test(cantidad) || Number(cantidad) < 1) return setError("La cantidad debe ser un entero mayor que cero");
    const r = await enviar(BASE, "POST", { id_alerta: idAlerta, id_proveedor: Number(idProveedor), cantidad: Number(cantidad) });
    if (!r.ok) return setError(mensajeError(r));
    setCreada(r.data);
    onListo?.(r.data);
  }

  if (creada) return <div className="ok">Solicitud {creada.id_pedido} generada ({creada.proveedor}). Puede seguir su estado en el módulo Proveedores.</div>;
  return (
    <form className="subform" onSubmit={generar}>
      {error && <div className="error">{error}</div>}
      {sugerencia?.solicitud_abierta && (
        <div className="muted">Ya hay una solicitud {sugerencia.solicitud_abierta.estado_visible.toLowerCase().replace("_", " ")} para esta alerta (n.º {sugerencia.solicitud_abierta.id_pedido}).</div>
      )}
      {sugerencia && !sugerencia.solicitud_abierta && (
        <>
          <strong>Solicitud de reabastecimiento: {sugerencia.medicamento.nombre_comercial}</strong>
          <div className="muted">Stock {sugerencia.stock} de un mínimo de {sugerencia.stock_minimo}. Cantidad sugerida: {sugerencia.cantidad_sugerida}.</div>
          <div className="inv-filtros dos">
            <SelectorProveedor proveedores={proveedores} valor={idProveedor} onChange={setIdProveedor} />
            <input type="number" min="1" value={cantidad} onChange={(e) => setCantidad(e.target.value)} aria-label="Cantidad a pedir" />
          </div>
          <button className="primary" disabled={ocupado}>{ocupado ? "Generando…" : "Generar solicitud"}</button>
        </>
      )}
    </form>
  );
}
