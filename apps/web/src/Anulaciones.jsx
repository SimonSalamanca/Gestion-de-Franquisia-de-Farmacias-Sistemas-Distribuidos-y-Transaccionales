import { useRef, useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";

// HU-10: anular una factura completa o devolver parte de ella. El motivo es obligatorio. Se distinguen dos operaciones:
// "Anular factura completa" (toda la factura, solo si no tiene devoluciones) y "Devolver lo seleccionado" (parcial).
// Cada unidad vuelve al lote de donde salió. Todo ocurre en la base de la tienda: funciona sin conexión con el central.

const ETIQUETA = { ANULACION_TOTAL: "Anulación total", DEVOLUCION_PARCIAL: "Devolución parcial" };

export default function Anulaciones({ session }) {
  const token = session.token;
  const [numero, setNumero] = useState("");
  const [lista, setLista] = useState(null);
  const [estado, setEstado] = useState(null); // respuesta de /devoluciones
  const [cantidades, setCantidades] = useState({});
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);
  // La clave se mantiene mientras el cajero reintenta la misma operación (red caída, doble clic): no se duplica.
  const clave = useRef(crypto.randomUUID());

  async function buscar(event) {
    event?.preventDefault();
    setError("");
    setAviso("");
    setEstado(null);
    const q = numero.trim() ? `?numero=${encodeURIComponent(numero.trim())}` : "";
    const r = await api(`/api/local/historial/facturas${q}`, { token });
    if (!r.ok) return setError(r.data.mensaje || "No se pudo buscar");
    setLista(r.data.facturas);
  }

  async function abrir(id) {
    setError("");
    setAviso("");
    const r = await api(`/api/local/facturas/${id}/devoluciones`, { token });
    if (!r.ok) return setError(r.data.mensaje || "No se pudo abrir la factura");
    elegir(r.data);
  }

  function elegir(datos) {
    setEstado(datos);
    setCantidades({});
    setMotivo("");
    clave.current = crypto.randomUUID();
  }

  async function enviar(tipo) {
    setError("");
    setAviso("");
    const id = estado.factura.id_factura;
    let body = { motivo };
    if (tipo === "devolver") {
      const lineas = Object.entries(cantidades)
        .filter(([, q]) => Number(q) > 0)
        .map(([id_lote, q]) => ({ id_lote: Number(id_lote), cantidad: Number(q) }));
      if (lineas.length === 0) return setError("Indique cuántas unidades devuelve en al menos una línea");
      body = { motivo, lineas };
    }
    if (motivo.trim().length < 5) return setError("El motivo es obligatorio (mínimo 5 caracteres)");
    const que = tipo === "anular" ? `ANULAR por completo la factura ${estado.factura.numero_factura}` : "registrar esta devolución parcial";
    if (!window.confirm(`¿Confirma ${que}? Esta operación no se puede deshacer.`)) return;
    setOcupado(true);
    let r;
    try {
      r = await api(`/api/local/facturas/${id}/${tipo === "anular" ? "anular" : "devolver"}`, { method: "POST", token, key: clave.current, body });
    } catch {
      setOcupado(false);
      return setError("Sin respuesta del servidor. Puede reintentar: la operación no se duplicará.");
    }
    setOcupado(false);
    if (!r.ok) {
      if (r.status !== 0 && r.status < 500) clave.current = crypto.randomUUID();
      return setError(r.data.mensaje || "No se pudo registrar la operación");
    }
    setAviso(`${ETIQUETA[r.data.nota.tipo]} registrada: ${r.data.nota.numero_nota} por ${pesos(r.data.nota.total_devuelto)}. El stock volvió a sus lotes de origen.`);
    elegir({ factura: r.data.factura, lineas: r.data.lineas, notas: r.data.notas, pagos: r.data.pagos, anulable: r.data.anulable, devolvible: r.data.devolvible });
    setLista(null);
  }

  return (
    <article className="inventario">
      <header className="inv-cabecera"><h2>Anulaciones y devoluciones</h2></header>
      <form className="row" onSubmit={buscar} style={{ flexWrap: "wrap" }}>
        <input placeholder="N.º de factura (ej. T1-0000)" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={30} aria-label="Número de factura" />
        <button className="primary">Buscar</button>
      </form>
      {error && <div className="error">{error}</div>}
      {aviso && <div className="ok">{aviso}</div>}

      {lista && !estado && (
        <div className="tabla-scroll">
          <table className="tabla">
            <thead><tr><th>Factura</th><th>Fecha</th><th>Estado</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {lista.map((f) => (
                <tr key={f.id_factura}>
                  <td>{f.numero_factura}</td><td>{fechaHora(f.fecha_hora)}</td><td>{f.estado}</td><td className="num">{pesos(f.total)}</td>
                  <td><button className="ghost" onClick={() => abrir(f.id_factura)}>Seleccionar</button></td>
                </tr>
              ))}
              {lista.length === 0 && <tr><td colSpan={5} className="muted">No hay facturas con ese número.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {estado && (
        <div className="historial">
          <h3>Factura {estado.factura.numero_factura} · {pesos(estado.factura.total)} · <span className={`pill ${estado.factura.estado === "EMITIDA" ? "online" : "offline"}`}>{estado.factura.estado}</span></h3>
          <p className="muted">{fechaHora(estado.factura.fecha_hora)}</p>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead><tr><th>Medicamento</th><th>Lote</th><th className="num">Vendida</th><th className="num">Devuelta</th><th className="num">Puede devolver</th><th className="num">Devolver ahora</th></tr></thead>
              <tbody>
                {estado.lineas.map((l) => (
                  <tr key={l.id_lote}>
                    <td>{l.medicamento}</td><td>{l.numero_lote}</td>
                    <td className="num">{l.cantidad}</td><td className="num">{l.devuelta}</td><td className="num">{l.disponible}</td>
                    <td className="num">
                      <input type="number" min="0" max={l.disponible} style={{ width: 80 }} disabled={!estado.devolvible || l.disponible === 0}
                        value={cantidades[l.id_lote] ?? ""} onChange={(e) => setCantidades((c) => ({ ...c, [l.id_lote]: e.target.value }))}
                        aria-label={`Unidades a devolver de ${l.medicamento}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {estado.devolvible ? (
            <>
              <label>Motivo (obligatorio)</label>
              <textarea rows={2} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: producto equivocado, error de digitación…" style={{ width: "100%" }} />
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                <button className="primary" disabled={ocupado} onClick={() => enviar("devolver")}>Devolver lo seleccionado (parcial)</button>
                <button className="danger" disabled={ocupado || !estado.anulable} onClick={() => enviar("anular")}
                  title={estado.anulable ? "" : "La factura ya tiene devoluciones: no se puede anular completa"}>Anular factura completa</button>
              </div>
              {!estado.anulable && <p className="muted">Esta factura ya tiene devoluciones, así que no se puede anular completa.</p>}
            </>
          ) : (
            <div className="error">Esta factura ya no admite más operaciones ({estado.factura.estado === "ANULADA" ? "está anulada" : "todo fue devuelto"}).</div>
          )}

          {estado.notas.length > 0 && (
            <>
              <h4>Notas registradas</h4>
              <table className="tabla">
                <thead><tr><th>Nota</th><th>Tipo</th><th>Fecha</th><th>Usuario</th><th>Motivo</th><th className="num">Valor</th></tr></thead>
                <tbody>
                  {estado.notas.map((n) => (
                    <tr key={n.id_anulacion}>
                      <td>{n.numero_nota}</td><td>{ETIQUETA[n.tipo]}</td><td>{fechaHora(n.fecha_hora)}</td><td>{n.empleado}</td><td>{n.motivo}</td><td className="num">{pesos(n.total_devuelto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <button className="ghost" onClick={() => { setEstado(null); buscar(); }}>← Volver a la lista</button>
        </div>
      )}
    </article>
  );
}
