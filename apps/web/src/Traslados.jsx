import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaHora } from "./inventarioUi.jsx";
import { useEnvio } from "./abastecimientoUi.jsx";

// HU-17: traslado de medicamentos entre tiendas. El administrador pide a otra tienda de la red las unidades que le faltan; el
// nodo central coordina el descuento en la tienda origen y el ingreso aquí como una sola operación, y si el ingreso falla
// repone el stock del origen solo. Solicitar exige conexión con el central; la lista se consulta en la tienda sin conexión.

const REFRESCO_MS = 10000;
const ESTADO_RED = {
  SOLICITADO: ["bajo", "Solicitado: esperando a la tienda origen"],
  EN_TRANSITO: ["media", "En tránsito: descontado en origen"],
  COMPLETADO: ["disponible", "Completado"],
  COMPENSANDO: ["agotado", "Falló el ingreso: reponiendo en origen"],
  COMPENSADO: ["agotado", "Revertido: el origen recuperó su stock"],
  FALLIDO: ["agotado", "Rechazado: la tienda origen no tenía stock"],
};

function mensajeError(r) {
  const { mensaje, ultima_sync: ultima, disponible } = r.data || {};
  const base = mensaje || "No se pudo completar la operación";
  if (r.status === 503) return `${base}. Solicitar un traslado requiere conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}.`;
  if (disponible != null && r.data?.codigo === "STOCK_INSUFICIENTE_ORIGEN") return `${base}.`;
  return base;
}

export default function Traslados({ session }) {
  const token = session.token;
  const [lista, setLista] = useState(null);
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    const r = await api("/api/local/traslados", { token });
    if (r.ok) {
      setLista(r.data.traslados);
      setError("");
    } else setError(mensajeError(r));
  }, [token]);
  useEffect(() => {
    cargar();
    const timer = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(timer);
  }, [cargar]);

  return (
    <div>
      <p className="muted">
        Pida a otra tienda de la red un medicamento que aquí no alcanza. El descuento en la tienda origen y el ingreso en esta tienda se
        coordinan como una sola operación: si el ingreso falla, la tienda origen recupera su stock automáticamente.
      </p>
      <Solicitar token={token} onListo={cargar} />
      {error && <div className="error">{error}</div>}
      <h3>Traslados de esta tienda</h3>
      {lista && lista.length === 0 && <div className="inv-vacio">Todavía no hay traslados.</div>}
      <ul className="inv-lista">
        {(lista || []).map((t) => {
          const [clase, texto] = ESTADO_RED[t.estado_red] ?? ["media", t.estado_red ?? t.estado_local];
          const esDestino = t.rol_tienda === "DESTINO";
          return (
            <li key={`${t.id_traslado}-${t.rol_tienda}`} className="inv-item">
              <div className="inv-fila">
                <div>
                  <strong>Traslado {t.id_traslado}</strong> <span className={`pill ${clase}`}>{texto}</span>
                  <div>
                    {esDestino ? `Recibe esta tienda desde ${t.tienda_origen}` : `Sale de esta tienda hacia ${t.tienda_destino}`} ·{" "}
                    {t.items.map((i) => `${i.cantidad} u. de ${i.nombre_comercial}`).join(", ")}
                  </div>
                  <div className="muted">
                    {fechaHora(t.fecha_hora)}
                    {t.solicitante ? ` · solicitó ${t.solicitante}` : ""}
                    {t.actualizado_en ? ` · actualizado ${fechaHora(t.actualizado_en)}` : ""}
                  </div>
                  {t.motivo && <div className="muted">Motivo: {t.motivo}</div>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Solicitar({ token, onListo }) {
  const { enviar, ocupado } = useEnvio(token);
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState([]);
  const [medicamento, setMedicamento] = useState(null);
  const [origenes, setOrigenes] = useState(null);
  const [idOrigen, setIdOrigen] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    if (medicamento || texto.trim().length < 2) return setResultados([]);
    const timer = setTimeout(() => {
      api(`/api/local/inventario/buscar?q=${encodeURIComponent(texto.trim())}`, { token }).then((r) => r.ok && setResultados(r.data.resultados ?? []));
    }, 300);
    return () => clearTimeout(timer);
  }, [token, texto, medicamento]);

  async function elegir(m) {
    setMedicamento(m);
    setResultados([]);
    setOrigenes(null);
    setIdOrigen("");
    setError("");
    setOk("");
    const r = await api(`/api/local/traslados/origenes?id_medicamento=${m.id_medicamento}`, { token });
    if (!r.ok) return setError(mensajeError(r));
    setOrigenes(r.data.origenes);
    if (r.data.origenes[0]) setIdOrigen(String(r.data.origenes[0].id_tienda));
  }

  async function solicitar(event) {
    event.preventDefault();
    setError("");
    setOk("");
    const origen = origenes?.find((o) => String(o.id_tienda) === idOrigen);
    if (!origen) return setError("Elija la tienda origen");
    if (!/^\d+$/.test(cantidad) || Number(cantidad) < 1) return setError("La cantidad debe ser un entero mayor que cero");
    if (Number(cantidad) > origen.disponible) return setError(`${origen.nombre} tiene ${origen.disponible} unidades disponibles para trasladar`);
    const r = await enviar("/api/local/traslados", "POST", { id_tienda_origen: origen.id_tienda, id_medicamento: medicamento.id_medicamento, cantidad: Number(cantidad) });
    if (!r.ok) return setError(mensajeError(r));
    setOk(`Traslado ${r.data.id_traslado} solicitado a ${r.data.tienda_origen}. La tienda origen lo descuenta en su próxima sincronización y las unidades ingresan aquí después.`);
    setMedicamento(null);
    setTexto("");
    setCantidad("");
    setOrigenes(null);
    onListo();
  }

  return (
    <form className="subform" onSubmit={solicitar}>
      <strong>Solicitar un traslado</strong>
      {!medicamento && (
        <input placeholder="Buscar el medicamento por nombre, principio activo o código" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar medicamento" />
      )}
      {resultados.length > 0 && (
        <ul className="inv-lista">
          {resultados.map((m) => (
            <li key={m.id_medicamento} className="inv-item">
              <div className="inv-fila">
                <div>
                  {m.nombre_comercial} <span className="muted">· aquí hay {m.stock_tienda}</span>
                </div>
                <button type="button" className="ghost" onClick={() => elegir(m)}>Elegir</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {medicamento && (
        <>
          <p>
            <strong>{medicamento.nombre_comercial}</strong> · en esta tienda hay {medicamento.stock_tienda}{" "}
            <button type="button" className="enlace" onClick={() => { setMedicamento(null); setOrigenes(null); }}>Cambiar</button>
          </p>
          {origenes && origenes.length === 0 && <div className="inv-vacio">Ninguna otra tienda de la red tiene unidades disponibles de este medicamento.</div>}
          {origenes && origenes.length > 0 && (
            <div className="inv-filtros dos">
              <select value={idOrigen} onChange={(e) => setIdOrigen(e.target.value)} aria-label="Tienda origen">
                {origenes.map((o) => (
                  <option key={o.id_tienda} value={o.id_tienda}>
                    {o.nombre} ({o.ciudad}) · {o.disponible} disponibles{o.al ? ` al ${fechaHora(o.al)}` : ""}
                  </option>
                ))}
              </select>
              <input type="number" min="1" placeholder="Cantidad" value={cantidad} onChange={(e) => setCantidad(e.target.value)} aria-label="Cantidad a trasladar" />
            </div>
          )}
          {origenes && origenes.length > 0 && <button className="primary" disabled={ocupado}>{ocupado ? "Solicitando…" : "Solicitar traslado"}</button>}
        </>
      )}
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
    </form>
  );
}
