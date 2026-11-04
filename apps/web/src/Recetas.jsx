import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora } from "./inventarioUi.jsx";

// HU-12: recetas médicas para los medicamentos que la requieren (RF-08). El cajero escribe o escanea el código de la
// receta: el nodo central (EPS simulada) comprueba que sea auténtica, vigente y no reclamada, y la reserva para esta
// tienda. Sin conexión con el central no se valida un controlado nuevo. El documento del paciente aparece enmascarado
// salvo para quien puede consultar la auditoría. La venta (HU-08) usará la receta validada aquí.

function useEnvio(token) {
  const [ocupado, setOcupado] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const enviar = useCallback(
    async (ruta, method, body) => {
      setOcupado(true);
      try {
        const r = await api(ruta, { method, body, token, key });
        // Una clave nueva solo tras una respuesta definitiva: si la red falla, el reintento no duplica.
        if (r.status !== 0) setKey(crypto.randomUUID());
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

const hoyLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const sumarDias = (iso, dias) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + dias * 86400000).toISOString().slice(0, 10);

export default function Recetas({ session }) {
  const [documento, setDocumento] = useState("");
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState(null);
  const [elegida, setElegida] = useState(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);

  useEffect(() => {
    api("/api/local/recetas/politica", { token: session.token }).then((r) => r.ok && setManual(r.data.registro_manual));
  }, [session.token]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = new URLSearchParams();
      if (texto.trim()) query.set("q", texto.trim());
      if (documento.trim()) query.set("documento", documento.trim());
      api(`/api/local/recetas?${query}`, { token: session.token }).then((r) => {
        if (r.ok) {
          setLista(r.data.recetas);
          setError("");
        } else setError(r.data.mensaje || "No se pudo consultar las recetas");
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [session.token, texto, documento, version]);

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Recetas médicas</h2>
        <p className="muted">
          Los medicamentos controlados no se venden sin una receta vigente que los incluya. Escriba o escanee el código de la receta:
          el nodo central verifica que sea auténtica, esté vigente y no se haya reclamado, y la reserva para esta tienda. Al
          dispensarla se da de baja y no puede usarse en otra sucursal.
        </p>
      </header>

      <ValidarCodigo token={session.token} onListo={(receta) => { setElegida(receta.id_receta); setVersion((v) => v + 1); }} />
      {manual && <NuevaReceta token={session.token} onListo={(receta) => { setElegida(receta.id_receta); setVersion((v) => v + 1); }} />}

      <h3>Recetas registradas</h3>
      <div className="inv-filtros dos">
        <input placeholder="Buscar por médico o paciente" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar por médico o paciente" />
        <input placeholder="Documento exacto del paciente" value={documento} onChange={(e) => setDocumento(e.target.value)} aria-label="Documento del paciente" />
      </div>
      {error && <div className="error">{error}</div>}
      {lista && lista.length === 0 && <div className="inv-vacio">No hay recetas con ese criterio.</div>}
      <ul className="inv-lista">
        {(lista || []).map((r) => (
          <li key={r.id_receta} className="inv-item">
            <div className="inv-fila">
              <div>
                <button className="enlace" onClick={() => setElegida(elegida === r.id_receta ? null : r.id_receta)}>
                  Receta {r.id_receta}{r.codigo_receta ? ` · ${r.codigo_receta}` : ""} · {r.medico_prescriptor}
                </button>
                <div className="muted">
                  Paciente {r.paciente} ({r.paciente_documento}) · emitida {fechaCorta(r.fecha_emision)} · vence {fechaCorta(r.vence)}
                </div>
                <div className="muted">{r.medicamentos.map((m) => `${m.nombre_comercial} ${m.cantidad_dispensada}/${m.cantidad_autorizada}`).join(" · ")}</div>
              </div>
              <div className="inv-stock">
                <span className={`pill ${r.utilizable ? "disponible" : "agotado"}`}>{estadoReceta(r)}</span>
                {r.origen === "CENTRAL" && r.utilizable && <LiberarReceta token={session.token} id={r.id_receta} onListo={() => setVersion((v) => v + 1)} />}
              </div>
            </div>
            {elegida === r.id_receta && <Detalle token={session.token} id={r.id_receta} />}
          </li>
        ))}
      </ul>
    </article>
  );
}

function estadoReceta(r) {
  if (r.utilizable) return r.origen === "CENTRAL" ? `reservada hasta ${fechaHora(r.reservada_hasta)}` : "utilizable";
  if (r.origen === "CENTRAL") return r.dispensada ? "dispensada" : "reserva terminada";
  if (!r.vigente) return "vencida";
  return r.utilizable ? "utilizable" : "registro manual desactivado";
}

function mensajeError(r) {
  const { mensaje, ultima_sync: ultima } = r.data || {};
  if (r.status === 503) {
    return `Sin conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}. No se puede validar una receta de un medicamento controlado; los de venta libre siguen disponibles.`;
  }
  return mensaje || "No se pudo completar la operación";
}

function LiberarReceta({ token, id, onListo }) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  async function liberar() {
    setOcupado(true);
    const r = await api(`/api/local/recetas/${id}/liberar`, { method: "POST", token });
    setOcupado(false);
    if (r.ok) onListo();
    else setError(mensajeError(r));
  }
  return (
    <>
      <button className="ghost" disabled={ocupado} onClick={liberar}>Liberar reserva</button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

// Criterio 1: el cajero escribe o escanea (el lector de barras escribe como un teclado y termina con Enter).
function ValidarCodigo({ token, onListo }) {
  const [codigo, setCodigo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function validar(event) {
    event.preventDefault();
    setError("");
    setOk("");
    if (!codigo.trim()) return setError("Escriba o escanee el código de la receta");
    setOcupado(true);
    const r = await api("/api/local/recetas/codigo", { method: "POST", body: { codigo: codigo.trim() }, token });
    setOcupado(false);
    if (!r.ok) return setError(mensajeError(r));
    setOk(`Receta ${r.data.codigo_receta} válida y reservada para esta tienda hasta ${fechaHora(r.data.reservada_hasta)}. Ya puede usarse en la venta.`);
    setCodigo("");
    onListo(r.data);
  }

  return (
    <form className="subform" onSubmit={validar}>
      <strong>Validar receta con el nodo central</strong>
      <div className="inv-filtros dos">
        <input autoFocus placeholder="Código de la receta (escanee o escriba)" value={codigo} onChange={(e) => setCodigo(e.target.value)} aria-label="Código de la receta" maxLength={40} autoComplete="off" />
        <button className="primary" disabled={ocupado}>{ocupado ? "Validando…" : "Validar receta"}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
    </form>
  );
}

function Detalle({ token, id }) {
  const [receta, setReceta] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/api/local/recetas/${id}`, { token }).then((r) => (r.ok ? setReceta(r.data) : setError(r.data.mensaje || "No se pudo abrir la receta")));
  }, [token, id]);
  if (error) return <div className="error">{error}</div>;
  if (!receta) return null;
  return (
    <div className="historial">
      <strong>Detalle de la receta {receta.id_receta}</strong>
      <p className="muted">
        Registrada {fechaHora(receta.fecha_registro)} por {receta.registrada_por || "—"}.{" "}
        {receta.datos_completos ? "Datos personales completos (consulta auditada)." : "Datos personales protegidos para su rol."}
      </p>
      <p>
        Paciente: <strong>{receta.paciente}</strong> · Documento: {receta.paciente_documento}
        {receta.datos_completos && <> · Tel.: {receta.paciente_telefono || "—"} · Correo: {receta.paciente_correo || "—"}</>}
      </p>
      <div className="tabla-scroll">
        <table className="tabla">
          <thead>
            <tr><th>Medicamento</th><th className="num">Autorizado</th><th className="num">Dispensado</th><th className="num">Saldo</th></tr>
          </thead>
          <tbody>
            {receta.medicamentos.map((m) => (
              <tr key={m.id_medicamento}>
                <td>{m.nombre_comercial}<div className="muted">{m.principio_activo}</div></td>
                <td className="num">{m.cantidad_autorizada}</td>
                <td className="num">{m.cantidad_dispensada}</td>
                <td className="num"><strong>{m.saldo}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const VACIO = { medico: "", fecha: "", nombre: "", documento: "", telefono: "", correo: "" };

function NuevaReceta({ token, onListo }) {
  const { enviar, ocupado } = useEnvio(token);
  const [campos, setCampos] = useState({ ...VACIO, fecha: hoyLocal() });
  const [lineas, setLineas] = useState([]);
  const [busqueda, setBusqueda] = useState("");
  const [opciones, setOpciones] = useState([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const poner = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.value }));

  useEffect(() => {
    const timer = setTimeout(() => {
      api(`/api/local/recetas/medicamentos?q=${encodeURIComponent(busqueda.trim())}`, { token }).then((r) => r.ok && setOpciones(r.data.medicamentos));
    }, 250);
    return () => clearTimeout(timer);
  }, [token, busqueda]);

  const agregar = (med) => {
    if (lineas.some((l) => l.id_medicamento === med.id_medicamento)) return;
    setLineas([...lineas, { ...med, cantidad: "1" }]);
    setBusqueda("");
  };

  async function guardar(event) {
    event.preventDefault();
    setError("");
    setOk("");
    if (!campos.medico.trim()) return setError("El médico prescriptor es obligatorio");
    if (!campos.fecha) return setError("La fecha de la receta es obligatoria");
    if (campos.fecha > hoyLocal()) return setError("La fecha de la receta no puede ser futura");
    if (!campos.nombre.trim() || !campos.documento.trim()) return setError("Nombre y documento del paciente son obligatorios");
    if (lineas.length === 0) return setError("Agregue al menos un medicamento a la receta");
    if (lineas.some((l) => !/^\d+$/.test(l.cantidad) || Number(l.cantidad) < 1)) return setError("Cada cantidad debe ser un entero mayor que cero");
    const r = await enviar("/api/local/recetas", "POST", {
      medico_prescriptor: campos.medico.trim(),
      fecha_emision: campos.fecha,
      cliente: { nombre: campos.nombre.trim(), documento_identidad: campos.documento.trim(), telefono: campos.telefono.trim(), correo: campos.correo.trim() },
      medicamentos: lineas.map((l) => ({ id_medicamento: l.id_medicamento, cantidad: Number(l.cantidad) })),
    });
    if (!r.ok) return setError(r.data.mensaje || "No se pudo registrar la receta");
    setOk(`Receta ${r.data.id_receta} registrada. Ya puede usarse en la venta.`);
    setCampos({ ...VACIO, fecha: hoyLocal() });
    setLineas([]);
    onListo(r.data);
  }

  return (
    <form className="subform" onSubmit={guardar}>
      <strong>Registrar receta</strong>
      <div className="inv-filtros dos">
        <input placeholder="Médico prescriptor" value={campos.medico} onChange={poner("medico")} aria-label="Médico prescriptor" maxLength={150} />
        <input type="date" value={campos.fecha} min={sumarDias(hoyLocal(), -30)} max={hoyLocal()} onChange={poner("fecha")} aria-label="Fecha de la receta" />
        <input placeholder="Nombre del paciente" value={campos.nombre} onChange={poner("nombre")} aria-label="Nombre del paciente" maxLength={150} />
        <input placeholder="Documento del paciente" value={campos.documento} onChange={poner("documento")} aria-label="Documento del paciente" maxLength={40} autoComplete="off" />
        <input placeholder="Teléfono (opcional)" value={campos.telefono} onChange={poner("telefono")} aria-label="Teléfono" maxLength={30} />
        <input type="email" placeholder="Correo (opcional)" value={campos.correo} onChange={poner("correo")} aria-label="Correo" maxLength={120} />
      </div>
      <input placeholder="Buscar medicamento que requiere receta" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} aria-label="Buscar medicamento" />
      <div className="indicadores">
        {opciones.slice(0, 8).map((m) => (
          <button type="button" key={m.id_medicamento} className="ghost" onClick={() => agregar(m)}>+ {m.nombre_comercial}</button>
        ))}
      </div>
      {lineas.map((l) => (
        <div key={l.id_medicamento} className="inv-filtros dos">
          <span>{l.nombre_comercial}<span className="muted"> · {l.principio_activo}</span></span>
          <span>
            <input type="number" min="1" step="1" value={l.cantidad} aria-label={`Cantidad de ${l.nombre_comercial}`}
              onChange={(e) => setLineas(lineas.map((x) => (x.id_medicamento === l.id_medicamento ? { ...x, cantidad: e.target.value } : x)))} />
            <button type="button" className="enlace" onClick={() => setLineas(lineas.filter((x) => x.id_medicamento !== l.id_medicamento))}>Quitar</button>
          </span>
        </div>
      ))}
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Registrar receta"}</button>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
    </form>
  );
}
