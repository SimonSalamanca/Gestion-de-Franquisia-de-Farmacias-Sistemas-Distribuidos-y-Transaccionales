import { useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";

// HU-09: historial de compras y reimpresión. Busca por cliente, número de factura o rango de fechas, muestra el
// historial de un cliente y reimprime cualquier factura tal como se emitió (solo se agrega el rótulo "COPIA n").
// Todo se lee de la base de la tienda: funciona igual sin conexión con el central.

const VACIO = { cliente: "", numero: "", desde: "", hasta: "" };

export default function Historial({ session }) {
  const token = session.token;
  const [filtros, setFiltros] = useState(VACIO);
  const [idCliente, setIdCliente] = useState(null);
  const [resumen, setResumen] = useState(null);
  const [facturas, setFacturas] = useState(null);
  const [siguiente, setSiguiente] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [factura, setFactura] = useState(null);
  const [clientes, setClientes] = useState(null);

  const cambiar = (campo) => (e) => setFiltros((f) => ({ ...f, [campo]: e.target.value }));

  async function consultar({ cliente = idCliente, filtrosActuales = filtros, cursor = null } = {}) {
    setOcupado(true);
    setError("");
    const params = new URLSearchParams();
    if (cliente) params.set("id_cliente", cliente);
    else if (filtrosActuales.cliente.trim()) params.set("cliente", filtrosActuales.cliente.trim());
    for (const k of ["numero", "desde", "hasta"]) if (filtrosActuales[k]) params.set(k, filtrosActuales[k].trim());
    if (cursor) params.set("cursor", cursor);
    try {
      const r = await api(`/api/local/historial/facturas?${params}`, { token });
      if (!r.ok) return setError(r.data.mensaje || "No se pudo consultar el historial");
      setFacturas((previas) => (cursor ? [...(previas || []), ...r.data.facturas] : r.data.facturas));
      setSiguiente(r.data.siguiente);
    } catch {
      setError("Sin respuesta del servidor. Intente de nuevo.");
    } finally {
      setOcupado(false);
    }
  }

  async function buscar(event) {
    event.preventDefault();
    setFactura(null);
    setResumen(null);
    setIdCliente(null);
    setClientes(null);
    // Con texto de cliente primero se elige a la persona (puede haber homónimos); sin él se busca de una vez.
    if (filtros.cliente.trim().length >= 2) {
      setOcupado(true);
      const r = await api(`/api/local/historial/clientes?q=${encodeURIComponent(filtros.cliente.trim())}`, { token });
      setOcupado(false);
      if (!r.ok) return setError(r.data.mensaje || "No se pudo buscar el cliente");
      setFacturas(null);
      setSiguiente(null);
      if (r.data.clientes.length === 1) return elegirCliente(r.data.clientes[0]);
      setClientes(r.data.clientes);
      if (r.data.clientes.length === 0) setError("No hay clientes con ese nombre o documento");
      return;
    }
    if (filtros.cliente.trim()) return setError("Escriba al menos 2 caracteres del cliente");
    consultar({ cliente: null });
  }

  async function elegirCliente(c) {
    setClientes(null);
    setIdCliente(c.id_cliente);
    const r = await api(`/api/local/historial/clientes/${c.id_cliente}`, { token });
    if (r.ok) setResumen(r.data);
    consultar({ cliente: c.id_cliente });
  }

  async function abrir(id, reimprimir) {
    setError("");
    const r = reimprimir
      ? await api(`/api/local/historial/facturas/${id}/reimprimir`, { method: "POST", token })
      : await api(`/api/local/historial/facturas/${id}`, { token });
    if (!r.ok) return setError(r.data.mensaje || "No se pudo abrir la factura");
    setFactura(r.data);
    if (reimprimir) setTimeout(() => window.print(), 100);
  }

  if (factura) return <FacturaImpresa factura={factura} onVolver={() => setFactura(null)} onReimprimir={() => abrir(factura.id_factura, true)} />;

  return (
    <div className="historial">
      <form onSubmit={buscar}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <input placeholder="Cliente (nombre o documento)" value={filtros.cliente} onChange={cambiar("cliente")} maxLength={100} aria-label="Cliente" />
          <input placeholder="N.º de factura (ej. T1-0000)" value={filtros.numero} onChange={cambiar("numero")} maxLength={30} aria-label="Número de factura" />
          <label className="muted">Desde <input type="date" value={filtros.desde} onChange={cambiar("desde")} /></label>
          <label className="muted">Hasta <input type="date" value={filtros.hasta} onChange={cambiar("hasta")} /></label>
          <button className="primary" disabled={ocupado}>{ocupado ? "Buscando…" : "Buscar"}</button>
          <button type="button" className="ghost" onClick={() => { setFiltros(VACIO); setFacturas(null); setResumen(null); setIdCliente(null); setClientes(null); setError(""); }}>Limpiar</button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}

      {clientes && clientes.length > 0 && (
        <div>
          <p className="muted">Varios clientes coinciden. Elija uno:</p>
          {clientes.map((c) => (
            <button key={c.id_cliente} className="ghost" onClick={() => elegirCliente(c)}>{c.nombre} · {c.documento || "sin documento"}</button>
          ))}
        </div>
      )}

      {resumen && (
        <div className="card">
          <strong>{resumen.nombre}</strong> · Documento {resumen.documento || "—"}
          {resumen.telefono && ` · ${resumen.telefono}`}
          {resumen.correo && ` · ${resumen.correo}`}
          <p className="muted">
            {resumen.compras} compra{resumen.compras === 1 ? "" : "s"} · Total comprado {pesos(resumen.total_comprado)}
            {resumen.ultima_compra ? ` · Última: ${fechaHora(resumen.ultima_compra)}` : ""}
          </p>
        </div>
      )}

      {facturas && (
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Factura</th><th>Fecha</th><th>Cliente</th><th>Cajero</th><th>Estado</th><th className="num">Total</th><th /></tr>
            </thead>
            <tbody>
              {facturas.map((f) => (
                <tr key={f.id_factura}>
                  <td>{f.numero_factura}</td>
                  <td>{fechaHora(f.fecha_hora)}</td>
                  <td>{f.cliente ? f.cliente.nombre : <span className="muted">Mostrador</span>}</td>
                  <td>{f.cajero}</td>
                  <td>{f.estado}</td>
                  <td className="num">{pesos(f.total)}</td>
                  <td>
                    <button className="ghost" onClick={() => abrir(f.id_factura, false)}>Ver</button>{" "}
                    <button className="ghost" onClick={() => abrir(f.id_factura, true)}>Reimprimir</button>
                  </td>
                </tr>
              ))}
              {facturas.length === 0 && <tr><td colSpan={7} className="muted">No hay facturas con esos criterios.</td></tr>}
            </tbody>
          </table>
          {siguiente && <button className="ghost" disabled={ocupado} onClick={() => consultar({ cursor: siguiente })}>Cargar más</button>}
        </div>
      )}
    </div>
  );
}

// Misma factura que se emitió; la copia solo agrega el rótulo. window.print() imprime solo esta zona (styles.css).
function FacturaImpresa({ factura, onVolver, onReimprimir }) {
  return (
    <div className="historial">
      <div className="row no-print">
        <button className="ghost" onClick={onVolver}>← Volver al historial</button>
        <button className="primary" onClick={onReimprimir}>Reimprimir</button>
      </div>
      <div className="factura-impresion">
        <h3>Factura {factura.numero_factura}{factura.reimpresion ? ` — COPIA ${factura.reimpresion}` : ""}</h3>
        <p className="muted">
          {fechaHora(factura.fecha_hora)} · Cajero: {factura.cajero}
          {factura.cliente ? ` · Cliente: ${factura.cliente}` : ""} · Estado: {factura.estado}
        </p>
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Medicamento</th><th>Lote</th><th className="num">Cant.</th><th className="num">Precio</th><th className="num">Impuesto</th><th className="num">Subtotal</th></tr>
            </thead>
            <tbody>
              {factura.lineas.map((l) => (
                <tr key={`${l.id_medicamento}-${l.lote}`}>
                  <td>{l.medicamento}{l.codigo_receta && <div className="muted">Receta {l.codigo_receta}</div>}</td>
                  <td>{l.lote}</td>
                  <td className="num">{l.cantidad}</td>
                  <td className="num">{pesos(l.precio_unitario)}</td>
                  <td className="num">{pesos(l.impuesto)} ({Number(l.tasa_impuesto)}%)</td>
                  <td className="num">{pesos(l.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Subtotal {pesos(factura.subtotal)} · Impuestos {pesos(factura.impuestos)}</p>
        <p><strong>Total {pesos(factura.total)}</strong></p>
        <p className="muted">Pagos: {factura.pagos.map((p) => `${p.metodo} ${pesos(p.monto)}`).join(" · ")}</p>
      </div>
    </div>
  );
}
