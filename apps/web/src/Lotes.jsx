import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { EstadoLote, HistorialLote, Indicadores, alertaCaducidad, fechaCorta } from "./inventarioUi.jsx";

// HU-02: lotes, registro manual, recepción de pedidos y ajustes (RF-02, RF-04, RF-23).
// Las escrituras van con Idempotency-Key: un doble clic o un reintento no duplica el movimiento.
// La clave se conserva mientras no haya respuesta (reintento) y se renueva tras cada respuesta.

const PESTANAS = [
  ["lotes", "Lotes"],
  ["registrar", "Registrar lote"],
  ["recibir", "Recibir pedido"],
];

function useEnvio(token) {
  const [ocupado, setOcupado] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const enviar = useCallback(
    async (ruta, body) => {
      setOcupado(true);
      try {
        const r = await api(ruta, { method: "POST", body, token, key });
        setKey(crypto.randomUUID());
        return r;
      } catch {
        return { ok: false, status: 0, data: { mensaje: "Sin respuesta del servidor. Puede reintentar: no se duplicará." } };
      } finally {
        setOcupado(false);
      }
    },
    [token, key],
  );
  return { enviar, ocupado };
}

function mensajeError(r) {
  const { mensaje, linea } = r.data || {};
  return mensaje ? (linea && !mensaje.startsWith("Línea") ? `Línea ${linea}: ${mensaje}` : mensaje) : "No se pudo completar la operación";
}

export default function Lotes({ session }) {
  const [pestana, setPestana] = useState("lotes");
  const [version, setVersion] = useState(0);
  const cambio = () => setVersion((v) => v + 1);
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Lotes y recepción</h2>
        <p className="muted">Cada entrada y ajuste queda registrado con responsable, fecha, hora y cantidad.</p>
      </header>
      <div className="pestanas" role="tablist">
        {PESTANAS.map(([id, texto]) => (
          <button key={id} role="tab" aria-selected={pestana === id} className={pestana === id ? "active" : ""} onClick={() => setPestana(id)}>
            {texto}
          </button>
        ))}
      </div>
      {pestana === "lotes" && <ListaLotes token={session.token} version={version} onCambio={cambio} />}
      {pestana === "registrar" && <RegistrarLote token={session.token} onCambio={cambio} />}
      {pestana === "recibir" && <RecibirPedido token={session.token} onCambio={cambio} />}
    </article>
  );
}

function ListaLotes({ token, version, onCambio }) {
  const [estado, setEstado] = useState("DISPONIBLE");
  const [vence, setVence] = useState("");
  const [lotes, setLotes] = useState(null);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState(null); // { id, modo: "historial" | "ajuste" }

  useEffect(() => {
    const params = new URLSearchParams();
    if (estado) params.set("estado", estado);
    if (vence) params.set("vence_en_dias", vence);
    api(`/api/local/lotes?${params}`, { token }).then((r) => {
      if (r.ok) {
        setLotes(r.data);
        setError("");
      } else setError(r.data.mensaje || "No se pudieron cargar los lotes");
    });
  }, [token, estado, vence, version]);

  const alternar = (id, modo) => setAbierto(abierto?.id === id && abierto.modo === modo ? null : { id, modo });

  return (
    <>
      <div className="inv-filtros dos">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado del lote">
          <option value="">Todos los estados</option>
          <option value="DISPONIBLE">Disponibles</option>
          <option value="AGOTADO">Agotados</option>
          <option value="BLOQUEADO">Bloqueados</option>
        </select>
        <select value={vence} onChange={(e) => setVence(e.target.value)} aria-label="Vencimiento">
          <option value="">Cualquier caducidad</option>
          <option value="30">Vencen en 30 días o menos</option>
          <option value="90">Vencen en 90 días o menos</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {lotes && lotes.length === 0 && <div className="inv-vacio">No hay lotes con esos filtros.</div>}
      <ul className="inv-lista">
        {(lotes || []).map((lote) => (
          <li key={lote.id_lote} className={`inv-item ${alertaCaducidad(lote)}`}>
            <div className="inv-fila">
              <div>
                <strong>{lote.nombre_comercial}</strong>
                <div className="muted">
                  Lote {lote.numero_lote} · {lote.proveedor} · vence {fechaCorta(lote.fecha_caducidad)}
                </div>
                <div className="inv-marcas"><Indicadores medicamento={lote} /></div>
              </div>
              <div className="inv-stock">
                <span className="inv-cantidad">{lote.cantidad_disponible}</span>
                <EstadoLote lote={lote} />
                <button className="ghost" onClick={() => alternar(lote.id_lote, "historial")}>Historial</button>
                <button className="ghost" onClick={() => alternar(lote.id_lote, "ajuste")}>Ajustar</button>
              </div>
            </div>
            {abierto?.id === lote.id_lote && abierto.modo === "historial" && <HistorialLote token={token} idLote={lote.id_lote} version={version} />}
            {abierto?.id === lote.id_lote && abierto.modo === "ajuste" && (
              <AjusteLote
                token={token}
                lote={lote}
                onListo={() => {
                  setAbierto({ id: lote.id_lote, modo: "historial" });
                  onCambio();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function AjusteLote({ token, lote, onListo }) {
  const { enviar, ocupado } = useEnvio(token);
  const [sentido, setSentido] = useState("RESTA");
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");

  async function guardar(event) {
    event.preventDefault();
    setError("");
    if (!(Number(cantidad) > 0)) return setError("La cantidad debe ser mayor que cero");
    if (motivo.trim().length < 5) return setError("El motivo es obligatorio (mínimo 5 caracteres)");
    const r = await enviar(`/api/local/lotes/${lote.id_lote}/ajustes`, { sentido, cantidad: Number(cantidad), motivo: motivo.trim() });
    if (!r.ok) return setError(mensajeError(r));
    onListo();
  }

  return (
    <form className="subform" onSubmit={guardar}>
      <div className="inv-filtros tres">
        <select value={sentido} onChange={(e) => setSentido(e.target.value)} aria-label="Sentido del ajuste">
          <option value="RESTA">Resta (merma, rotura, vencido)</option>
          <option value="SUMA">Suma (sobrante de conteo)</option>
        </select>
        <input type="number" min="1" placeholder="Cantidad" value={cantidad} onChange={(e) => setCantidad(e.target.value)} aria-label="Cantidad" />
        <input placeholder="Motivo (obligatorio)" maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} aria-label="Motivo" />
      </div>
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Registrar ajuste"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

// Selector de medicamento: busca en el catálogo local con la ruta de HU-01.
function ElegirMedicamento({ token, valor, onElegir }) {
  const [texto, setTexto] = useState("");
  const [opciones, setOpciones] = useState([]);

  useEffect(() => {
    if (texto.trim().length < 2) {
      setOpciones([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      api(`/api/local/inventario/buscar?q=${encodeURIComponent(texto.trim())}`, { token }).then((r) => r.ok && setOpciones(r.data.resultados));
    }, 300);
    return () => clearTimeout(timer);
  }, [texto, token]);

  if (valor) {
    return (
      <div className="elegido">
        <div>
          <strong>{valor.nombre_comercial}</strong> <span className="muted">{valor.codigo_interno}</span>
          <div className="inv-marcas"><Indicadores medicamento={valor} /></div>
        </div>
        <button type="button" className="ghost" onClick={() => onElegir(null)}>Cambiar</button>
      </div>
    );
  }
  return (
    <div>
      <input placeholder="Escriba nombre, principio activo o código" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Medicamento" />
      {opciones.length > 0 && (
        <ul className="opciones">
          {opciones.slice(0, 8).map((m) => (
            <li key={m.id_medicamento}>
              <button type="button" onClick={() => onElegir(m)}>
                {m.nombre_comercial} <span className="muted">{m.codigo_interno}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const VACIO = { numero_lote: "", fecha_caducidad: "", id_proveedor: "", cantidad: "", observaciones: "" };

function RegistrarLote({ token, onCambio }) {
  const { enviar, ocupado } = useEnvio(token);
  const [proveedores, setProveedores] = useState([]);
  const [medicamento, setMedicamento] = useState(null);
  const [form, setForm] = useState(VACIO);
  const [error, setError] = useState({ mensaje: "", campo: "" });
  const [listo, setListo] = useState(null);

  useEffect(() => {
    api("/api/local/proveedores", { token }).then((r) => r.ok && setProveedores(r.data));
  }, [token]);

  const campo = (nombre) => (e) => setForm((f) => ({ ...f, [nombre]: e.target.value }));
  const marca = (nombre) => (error.campo === nombre ? "invalido" : "");

  async function guardar(event) {
    event.preventDefault();
    setListo(null);
    // Ayuda en el cliente; la validación que cuenta es la del API.
    const faltante = !medicamento
      ? ["id_medicamento", "Elija el medicamento"]
      : !form.id_proveedor
        ? ["id_proveedor", "El proveedor es obligatorio"]
        : !form.numero_lote.trim()
          ? ["numero_lote", "El número de lote es obligatorio"]
          : !form.fecha_caducidad
            ? ["fecha_caducidad", "La fecha de caducidad es obligatoria"]
            : !(Number(form.cantidad) > 0)
              ? ["cantidad", "La cantidad debe ser mayor que cero"]
              : null;
    if (faltante) return setError({ campo: faltante[0], mensaje: faltante[1] });
    setError({ mensaje: "", campo: "" });
    const r = await enviar("/api/local/lotes", {
      id_medicamento: medicamento.id_medicamento,
      id_proveedor: Number(form.id_proveedor),
      numero_lote: form.numero_lote.trim(),
      fecha_caducidad: form.fecha_caducidad,
      cantidad: Number(form.cantidad),
      observaciones: form.observaciones.trim() || undefined,
    });
    if (!r.ok) return setError({ mensaje: mensajeError(r), campo: r.data?.campo || "" });
    setListo(r.data);
    setForm(VACIO);
    setMedicamento(null);
    onCambio();
  }

  return (
    <form className="formulario" onSubmit={guardar}>
      <label>Medicamento</label>
      <div className={marca("id_medicamento")}><ElegirMedicamento token={token} valor={medicamento} onElegir={setMedicamento} /></div>
      {medicamento?.requiere_refrigeracion && <p className="aviso-frio">❄ Medicamento refrigerado: guárdelo entre 2 y 8 °C al recibirlo.</p>}
      <label>Proveedor</label>
      <select className={marca("id_proveedor")} value={form.id_proveedor} onChange={campo("id_proveedor")}>
        <option value="">Elija el proveedor</option>
        {proveedores.map((p) => <option key={p.id_proveedor} value={p.id_proveedor}>{p.nombre_empresa}</option>)}
      </select>
      <div className="inv-filtros tres">
        <div>
          <label>Número de lote</label>
          <input className={marca("numero_lote")} maxLength={60} value={form.numero_lote} onChange={campo("numero_lote")} />
        </div>
        <div>
          <label>Fecha de caducidad</label>
          <input className={marca("fecha_caducidad")} type="date" value={form.fecha_caducidad} onChange={campo("fecha_caducidad")} />
        </div>
        <div>
          <label>Cantidad</label>
          <input className={marca("cantidad")} type="number" min="1" value={form.cantidad} onChange={campo("cantidad")} />
        </div>
      </div>
      <label>Observaciones (opcional)</label>
      <input maxLength={300} value={form.observaciones} onChange={campo("observaciones")} />
      <button className="primary full" disabled={ocupado}>{ocupado ? "Registrando…" : "Registrar lote"}</button>
      {error.mensaje && <div className="error">{error.mensaje}</div>}
      {listo && (
        <div className="ok">
          {listo.nuevo ? "Lote registrado" : "Entrada sumada al lote existente"}: {listo.numero_lote} de {listo.nombre_comercial}, saldo {listo.cantidad_disponible} u.
        </div>
      )}
    </form>
  );
}

function RecibirPedido({ token, onCambio }) {
  const { enviar, ocupado } = useEnvio(token);
  const [pedidos, setPedidos] = useState(null);
  const [elegido, setElegido] = useState(null);
  const [lineas, setLineas] = useState({});
  const [error, setError] = useState("");
  const [listo, setListo] = useState(null);

  const cargar = useCallback(() => {
    api("/api/local/pedidos", { token }).then((r) => {
      if (r.ok) setPedidos(r.data);
      else setError(r.data.mensaje || "No se pudieron cargar los pedidos");
    });
  }, [token]);
  useEffect(cargar, [cargar]);

  function elegir(pedido) {
    setElegido(pedido);
    setError("");
    setListo(null);
    setLineas(
      Object.fromEntries(
        pedido.lineas
          .filter((l) => l.cantidad_solicitada > l.cantidad_recibida)
          .map((l) => [l.id_medicamento, { numero_lote: "", fecha_caducidad: "", cantidad: String(l.cantidad_solicitada - l.cantidad_recibida) }]),
      ),
    );
  }

  const cambiar = (id, campo) => (e) => setLineas((ls) => ({ ...ls, [id]: { ...ls[id], [campo]: e.target.value } }));

  async function recibir(event) {
    event.preventDefault();
    setError("");
    // Las líneas con cantidad vacía o 0 no se reciben ahora (recepción parcial).
    const enviadas = Object.entries(lineas)
      .filter(([, l]) => Number(l.cantidad) > 0)
      .map(([id, l]) => ({ id_medicamento: Number(id), numero_lote: l.numero_lote.trim(), fecha_caducidad: l.fecha_caducidad, cantidad: Number(l.cantidad) }));
    if (enviadas.length === 0) return setError("Indique al menos una línea con cantidad");
    const r = await enviar(`/api/local/pedidos/${elegido.id_pedido}/recepcion`, { lineas: enviadas });
    if (!r.ok) return setError(mensajeError(r));
    setListo(r.data);
    setElegido(null);
    cargar();
    onCambio();
  }

  if (!pedidos) return error ? <div className="error">{error}</div> : <p className="muted">Cargando pedidos…</p>;
  return (
    <>
      {listo && <div className="ok">Pedido {listo.id_pedido} recibido: {listo.estado === "RECIBIDO_TOTAL" ? "completo" : "parcial"} ({listo.lotes.length} lote(s)).</div>}
      {pedidos.length === 0 && <div className="inv-vacio">No hay pedidos pendientes de recibir.</div>}
      {!elegido && (
        <ul className="inv-lista">
          {pedidos.map((p) => (
            <li key={p.id_pedido} className="inv-item">
              <div className="inv-fila">
                <div>
                  <strong>Pedido {p.id_pedido}</strong> · {p.proveedor}
                  <div className="muted">{p.estado === "RECIBIDO_PARCIAL" ? "Recibido en parte" : "Solicitado"} · {p.lineas.length} producto(s)</div>
                </div>
                <button className="primary" onClick={() => elegir(p)}>Recibir</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {elegido && (
        <form className="formulario" onSubmit={recibir}>
          <p>
            <strong>Pedido {elegido.id_pedido}</strong> · proveedor {elegido.proveedor} (no se puede cambiar)
          </p>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Medicamento</th>
                  <th className="num">Pendiente</th>
                  <th>Número de lote</th>
                  <th>Caducidad</th>
                  <th>Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {elegido.lineas
                  .filter((l) => lineas[l.id_medicamento])
                  .map((l) => (
                    <tr key={l.id_medicamento}>
                      <td>
                        {l.nombre_comercial}
                        {l.requiere_refrigeracion && <div><span className="badge frio">❄ Refrigeración 2–8 °C</span></div>}
                      </td>
                      <td className="num">{l.cantidad_solicitada - l.cantidad_recibida}</td>
                      <td><input value={lineas[l.id_medicamento].numero_lote} maxLength={60} onChange={cambiar(l.id_medicamento, "numero_lote")} aria-label="Número de lote" /></td>
                      <td><input type="date" value={lineas[l.id_medicamento].fecha_caducidad} onChange={cambiar(l.id_medicamento, "fecha_caducidad")} aria-label="Caducidad" /></td>
                      <td><input type="number" min="0" value={lineas[l.id_medicamento].cantidad} onChange={cambiar(l.id_medicamento, "cantidad")} aria-label="Cantidad" /></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button className="primary" disabled={ocupado}>{ocupado ? "Recibiendo…" : "Confirmar recepción"}</button>
            <button type="button" className="ghost" onClick={() => setElegido(null)}>Volver</button>
          </div>
          {error && <div className="error">{error}</div>}
        </form>
      )}
    </>
  );
}
