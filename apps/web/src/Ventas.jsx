import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";
import { ValidarCodigo } from "./Recetas.jsx";

// HU-08: caja. Se arma el carrito, el servidor calcula el subtotal con el precio vigente y el impuesto de cada
// medicamento, el cajero reparte el pago entre uno o varios métodos y se emite la factura en una sola transacción.
// Todo corre en la base de la tienda: vende igual sin conexión con el central (excepto validar un controlado nuevo).

const centavos = (texto) => Math.round(Number(String(texto || "0").replace(",", ".")) * 100);
const aDecimal = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const MONTO_RE = /^\d{0,10}([.,]\d{0,2})?$/;

function mensajeError(r) {
  const { mensaje, codigo, ultima_sync: ultima } = r.data || {};
  if (r.status === 503) return `Sin conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}.`;
  if (codigo === "RECETA_REQUERIDA") return `${mensaje}. Elija o valide la receta del paciente.`;
  return mensaje || "No se pudo registrar la venta";
}

// caja: estado de la caja (Caja.jsx). Con la caja cerrada no se arma la venta: el servidor la rechazaría al cobrar.
export default function Ventas({ session, caja }) {
  const token = session.token;
  const cerrada = Boolean(caja && !caja.abierta);
  const buscador = useRef(null);
  const [validando, setValidando] = useState(null); // id_medicamento de la línea que valida una receta nueva
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState([]);
  const [carrito, setCarrito] = useState([]); // { med, cantidad, id_receta, recetas }
  const [calculo, setCalculo] = useState(null);
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState({});
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [factura, setFactura] = useState(null);
  // La clave se mantiene mientras el cajero reintenta la misma venta (red caída, doble clic): no se factura dos veces.
  const claveVenta = useRef(crypto.randomUUID());

  useEffect(() => {
    api("/api/local/ventas/metodos-pago", { token }).then((r) => r.ok && setMetodos(r.data.metodos));
  }, [token]);

  useEffect(() => {
    if (busqueda.trim().length < 2) return setResultados([]);
    const timer = setTimeout(() => {
      api(`/api/local/inventario/buscar?q=${encodeURIComponent(busqueda.trim())}`, { token }).then((r) => r.ok && setResultados(r.data.resultados));
    }, 300);
    return () => clearTimeout(timer);
  }, [busqueda, token]);

  const lineasApi = carrito.map((l) => ({ id_medicamento: l.med.id_medicamento, cantidad: Number(l.cantidad) || 0, id_receta: l.id_receta || null }));
  const lineasKey = JSON.stringify(lineasApi);

  // Vista previa: el mismo cálculo que hará la venta.
  useEffect(() => {
    if (carrito.length === 0 || lineasApi.some((l) => l.cantidad < 1)) return setCalculo(null);
    const timer = setTimeout(() => {
      api("/api/local/ventas/calcular", { method: "POST", body: { lineas: lineasApi }, token }).then((r) => setCalculo(r.ok ? r.data : null));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineasKey, token]);

  const agregar = useCallback(
    async (med) => {
      if (carrito.some((l) => l.med.id_medicamento === med.id_medicamento)) return;
      let recetas = [];
      if (med.requiere_receta) {
        const r = await api(`/api/local/recetas?id_medicamento=${med.id_medicamento}&solo_utilizables=1`, { token });
        if (r.ok) recetas = r.data.recetas;
      }
      setCarrito((c) => [...c, { med, cantidad: "1", id_receta: recetas[0]?.id_receta ?? "", recetas }]);
      // Controlado sin receta utilizable: se abre de una vez la validación en su línea.
      if (med.requiere_receta && recetas.length === 0) setValidando(med.id_medicamento);
      setBusqueda("");
      buscador.current?.focus();
    },
    [carrito, token],
  );

  // Enter agrega el primer resultado que se puede vender; Esc limpia la búsqueda.
  function teclaBusqueda(event) {
    if (event.key === "Escape") return setBusqueda("");
    if (event.key !== "Enter") return;
    event.preventDefault();
    const primero = resultados.find((m) => m.stock_tienda > 0 && m.precio != null);
    if (primero) agregar(primero);
  }

  const cambiar = (id, campos) => setCarrito((c) => c.map((l) => (l.med.id_medicamento === id ? { ...l, ...campos } : l)));
  const quitar = (id) => setCarrito((c) => c.filter((l) => l.med.id_medicamento !== id));

  // preferida: la receta recién validada en la línea queda elegida.
  async function refrescarRecetas(linea, preferida) {
    const r = await api(`/api/local/recetas?id_medicamento=${linea.med.id_medicamento}&solo_utilizables=1`, { token });
    if (r.ok) {
      const existe = (id) => id && r.data.recetas.some((x) => String(x.id_receta) === String(id));
      const id = existe(preferida) ? preferida : linea.id_receta || r.data.recetas[0]?.id_receta || "";
      cambiar(linea.med.id_medicamento, { recetas: r.data.recetas, id_receta: id });
    }
  }

  const total = calculo ? centavos(calculo.total) : 0;
  const pagado = Object.values(pagos).reduce((s, v) => s + centavos(v), 0);
  const restante = total - pagado;
  const faltaReceta = carrito.some((l) => l.med.requiere_receta && !l.id_receta);
  const puede = calculo?.puede_vender && restante === 0 && total > 0 && !faltaReceta && !ocupado && !cerrada;

  // Ctrl+Enter confirma la venta cuando todo está listo (mismas condiciones que el botón).
  const venderRef = useRef(null);
  venderRef.current = puede ? vender : null;
  useEffect(() => {
    const alTeclear = (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && venderRef.current) {
        event.preventDefault();
        venderRef.current();
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, []);

  async function vender() {
    setError("");
    setOcupado(true);
    const body = {
      lineas: lineasApi,
      pagos: Object.entries(pagos).filter(([, v]) => centavos(v) > 0).map(([id, v]) => ({ id_metodo_pago: Number(id), monto: aDecimal(centavos(v)) })),
    };
    let r;
    try {
      r = await api("/api/local/ventas", { method: "POST", body, token, key: claveVenta.current });
    } catch {
      r = { ok: false, status: 0, data: { mensaje: "Sin respuesta del servidor. Puede reintentar: la factura no se duplicará." } };
    }
    setOcupado(false);
    if (r.status === 0) return setError(mensajeError(r));
    // Respuesta definitiva (éxito o rechazo): la próxima venta usa otra clave.
    claveVenta.current = crypto.randomUUID();
    if (!r.ok) return setError(mensajeError(r));
    setFactura(r.data);
    setCarrito([]);
    setPagos({});
    setCalculo(null);
  }

  if (factura) return <FacturaEmitida factura={factura} onNueva={() => setFactura(null)} />;

  return (
    <div>
      <h3>Nueva venta</h3>
      <input
        ref={buscador}
        autoFocus
        disabled={cerrada}
        placeholder={cerrada ? "La caja está cerrada: no se pueden registrar ventas" : "Buscar medicamento por nombre, principio activo o código"}
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        onKeyDown={teclaBusqueda}
        aria-label="Buscar medicamento"
        aria-describedby="ayuda-busqueda"
      />
      <p id="ayuda-busqueda" className="m-0 mt-1.5 text-[12.5px] text-tenue">
        Enter agrega el primer resultado · Esc limpia la búsqueda · Ctrl + Enter confirma la venta cuando el pago está completo.
      </p>
      {resultados.length > 0 && (
        <ul className="inv-lista">
          {resultados.slice(0, 8).map((m) => (
            <li key={m.id_medicamento} className="inv-item">
              <div className="inv-fila">
                <div>
                  <strong>{m.nombre_comercial}</strong> {m.requiere_receta && <span className="badge receta">℞ Requiere receta</span>}
                  <div className="muted">{m.principio_activo} · stock {m.stock_tienda}</div>
                </div>
                <div className="inv-stock">
                  <strong>{pesos(m.precio)}</strong>
                  <button className="ghost" disabled={m.stock_tienda <= 0 || m.precio == null} onClick={() => agregar(m)}>Agregar</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {carrito.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Medicamento</th><th className="num">Cantidad</th><th className="num">Impuesto</th><th className="num">Subtotal</th><th /></tr>
            </thead>
            <tbody>
              {carrito.map((l) => {
                const fila = calculo?.lineas.find((x) => x.id_medicamento === l.med.id_medicamento);
                return (
                  <tr key={l.med.id_medicamento}>
                    <td>
                      {l.med.nombre_comercial}
                      {fila && !fila.stock_suficiente && <div className="error">Stock insuficiente</div>}
                      {l.med.requiere_receta && (
                        <div className="mt-2">
                          {l.recetas.length > 0 && (
                            <select value={l.id_receta} onChange={(e) => cambiar(l.med.id_medicamento, { id_receta: e.target.value })} aria-label={`Receta de ${l.med.nombre_comercial}`}>
                              <option value="">Receta del paciente…</option>
                              {l.recetas.map((r) => (
                                <option key={r.id_receta} value={r.id_receta}>{r.codigo_receta || `Receta ${r.id_receta}`} · {r.paciente}</option>
                              ))}
                            </select>
                          )}
                          {validando === l.med.id_medicamento ? (
                            // Validación en la misma venta (antes había que ir a la pestaña Recetas y volver).
                            <div className="mt-2 rounded-lg border border-linea bg-suave px-3 pb-3">
                              <ValidarCodigo
                                token={token}
                                onListo={(receta) => {
                                  setValidando(null);
                                  refrescarRecetas(l, receta.id_receta);
                                }}
                              />
                              <button type="button" className="enlace mt-2 text-[13px]" onClick={() => setValidando(null)}>Cancelar</button>
                            </div>
                          ) : (
                            <button type="button" className="enlace mt-1 text-[13px]" onClick={() => setValidando(l.med.id_medicamento)}>
                              {l.recetas.length === 0 ? "Validar la receta del paciente" : "Validar otra receta"}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <input type="number" min="1" step="1" value={l.cantidad} aria-label={`Cantidad de ${l.med.nombre_comercial}`} onChange={(e) => cambiar(l.med.id_medicamento, { cantidad: e.target.value })} />
                    </td>
                    <td className="num">{fila ? `${pesos(fila.impuesto)} (${fila.tasa_impuesto}%)` : "—"}</td>
                    <td className="num">{fila ? pesos(fila.subtotal) : "—"}</td>
                    <td><button type="button" className="enlace" onClick={() => quitar(l.med.id_medicamento)}>Quitar</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {calculo && (
        <div className="historial">
          <p>Subtotal {pesos(calculo.subtotal)} · Impuestos {pesos(calculo.impuestos)}</p>
          <p><strong>Total {pesos(calculo.total)}</strong></p>
          {calculo.problemas.map((p) => <div key={p.codigo + p.id_medicamento} className="error">{p.mensaje}</div>)}

          <strong>Pago (puede combinar métodos)</strong>
          <div className="inv-filtros dos">
            {metodos.map((m) => (
              <span key={m.id_metodo_pago}>
                <label>{m.etiqueta}</label>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={pagos[m.id_metodo_pago] ?? ""}
                  aria-label={`Monto en ${m.etiqueta}`}
                  onChange={(e) => MONTO_RE.test(e.target.value) && setPagos((p) => ({ ...p, [m.id_metodo_pago]: e.target.value }))}
                />
                <button type="button" className="enlace" disabled={restante <= 0} onClick={() => setPagos((p) => ({ ...p, [m.id_metodo_pago]: aDecimal(centavos(p[m.id_metodo_pago]) + restante) }))}>
                  Completar
                </button>
              </span>
            ))}
          </div>
          <p className={restante === 0 ? "ok" : "muted"}>
            {restante === 0 ? "El pago cubre el total." : restante > 0 ? `Falta ${pesos(aDecimal(restante))}` : `Se pasa por ${pesos(aDecimal(-restante))}`}
          </p>
          {faltaReceta && <div className="error">Un medicamento controlado necesita su receta.</div>}
          <button className="primary" disabled={!puede} onClick={vender}>{ocupado ? "Registrando…" : "Confirmar venta y emitir factura"}</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function FacturaEmitida({ factura, onNueva }) {
  return (
    <div className="historial">
      <h3>Factura {factura.numero_factura}</h3>
      <p className="muted">
        {fechaHora(factura.fecha_hora)} · Cajero: {factura.cajero}
        {factura.cliente ? ` · Paciente: ${factura.cliente}` : ""}
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
      <div className="ok">Venta registrada. El stock y la factura quedaron guardados en esta tienda.</div>
      <button className="primary" autoFocus onClick={onNueva}>Nueva venta</button>
    </div>
  );
}
