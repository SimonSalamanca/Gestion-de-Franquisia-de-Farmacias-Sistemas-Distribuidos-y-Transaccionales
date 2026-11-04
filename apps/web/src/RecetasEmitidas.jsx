import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora } from "./inventarioUi.jsx";

// HU-12: consola del nodo central. Simula al médico/EPS: emite recetas con su código y deja ver en qué estado está
// cada una (emitida, reservada por una tienda, reclamada). Una receta reclamada ya no sirve en ninguna sucursal.

const ESTADO = { EMITIDA: ["disponible", "emitida"], RESERVADA: ["bajo", "reservada"], RECLAMADA: ["agotado", "reclamada"], ANULADA: ["agotado", "anulada"] };
const hoyLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const VACIO = { codigo: "", medico: "", fecha: "", nombre: "", documento: "" };

function mensajeError(r) {
  const { mensaje } = r.data || {};
  if (r.status === 503) return "Sin conexión con el nodo central: la emisión requiere el central.";
  return mensaje || "No se pudo completar la operación";
}

export default function RecetasEmitidas({ session }) {
  const [lista, setLista] = useState(null);
  const [texto, setTexto] = useState("");
  const [estado, setEstado] = useState("");
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = new URLSearchParams();
      if (texto.trim()) query.set("q", texto.trim());
      if (estado) query.set("estado", estado);
      api(`/api/central/recetas-emitidas?${query}`, { token: session.token }).then((r) => {
        if (r.ok) {
          setLista(r.data.recetas);
          setError("");
        } else setError(mensajeError(r));
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [session.token, texto, estado, version]);

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Recetas emitidas (simulación de la EPS)</h2>
        <p className="muted">
          Emita una receta con su código y úsela en el POS. El central comprueba que sea auténtica, vigente y no reclamada, la reserva
          para una sola tienda y la da de baja al dispensarse, para que nadie la use en otra sucursal.
        </p>
      </header>

      <Emitir token={session.token} onListo={() => setVersion((v) => v + 1)} />

      <h3>Recetas del sistema</h3>
      <div className="inv-filtros dos">
        <input placeholder="Buscar por código, paciente o médico" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar recetas" />
        <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.keys(ESTADO).map((e) => <option key={e} value={e}>{ESTADO[e][1]}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {lista && lista.length === 0 && <div className="inv-vacio">No hay recetas con ese criterio.</div>}
      <ul className="inv-lista">
        {(lista || []).map((r) => (
          <li key={r.id_receta_emitida} className="inv-item">
            <div className="inv-fila">
              <div>
                <strong>{r.codigo}</strong> · {r.medico_prescriptor}
                <div className="muted">
                  Paciente {r.paciente_nombre} ({r.paciente_documento}) · emitida {fechaCorta(r.fecha_emision)}{!r.vigente && r.estado === "EMITIDA" ? " · vencida" : ""}
                </div>
                <div className="muted">{r.medicamentos.map((m) => `${m.nombre_comercial} x${m.cantidad_autorizada}`).join(" · ")}</div>
              </div>
              <div className="inv-stock">
                <span className={`pill ${ESTADO[r.estado][0]}`}>{ESTADO[r.estado][1]}</span>
                {r.estado === "RESERVADA" && <span className="muted">{r.tienda_reserva} hasta {fechaHora(r.reservada_hasta)}</span>}
                {r.estado === "RECLAMADA" && <span className="muted">{r.tienda_reclamo} · {fechaHora(r.reclamada_en)}</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Emitir({ token, onListo }) {
  const [campos, setCampos] = useState({ ...VACIO, fecha: hoyLocal() });
  const [catalogo, setCatalogo] = useState([]);
  const [lineas, setLineas] = useState([]);
  const [ocupado, setOcupado] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const poner = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.value }));

  useEffect(() => {
    api("/api/central/recetas-emitidas/medicamentos", { token }).then((r) => r.ok && setCatalogo(r.data.medicamentos));
  }, [token]);

  const agregar = useCallback((id) => {
    const med = catalogo.find((m) => m.id_medicamento === Number(id));
    if (med && !lineas.some((l) => l.id_medicamento === med.id_medicamento)) setLineas([...lineas, { ...med, cantidad: "1" }]);
  }, [catalogo, lineas]);

  async function emitir(event) {
    event.preventDefault();
    setError("");
    setOk("");
    if (!campos.medico.trim() || !campos.nombre.trim() || !campos.documento.trim()) return setError("Médico, nombre y documento del paciente son obligatorios");
    if (lineas.length === 0) return setError("Agregue al menos un medicamento");
    if (lineas.some((l) => !/^\d+$/.test(l.cantidad) || Number(l.cantidad) < 1)) return setError("Cada cantidad debe ser un entero mayor que cero");
    setOcupado(true);
    const r = await api("/api/central/recetas-emitidas", {
      method: "POST",
      token,
      key,
      body: {
        codigo: campos.codigo.trim() || undefined,
        medico_prescriptor: campos.medico.trim(),
        fecha_emision: campos.fecha,
        paciente_nombre: campos.nombre.trim(),
        paciente_documento: campos.documento.trim(),
        medicamentos: lineas.map((l) => ({ id_medicamento: l.id_medicamento, cantidad: Number(l.cantidad) })),
      },
    });
    setOcupado(false);
    if (r.status !== 0) setKey(crypto.randomUUID());
    if (!r.ok) return setError(mensajeError(r));
    setOk(`Receta emitida con el código ${r.data.codigo}. Escríbalo o escanéelo en el POS.`);
    setCampos({ ...VACIO, fecha: hoyLocal() });
    setLineas([]);
    onListo();
  }

  return (
    <form className="subform" onSubmit={emitir}>
      <strong>Emitir receta (simulada)</strong>
      <div className="inv-filtros dos">
        <input placeholder="Código (vacío = lo genera el sistema)" value={campos.codigo} onChange={poner("codigo")} aria-label="Código de la receta" maxLength={40} />
        <input type="date" value={campos.fecha} max={hoyLocal()} onChange={poner("fecha")} aria-label="Fecha de emisión" />
        <input placeholder="Médico prescriptor" value={campos.medico} onChange={poner("medico")} aria-label="Médico prescriptor" maxLength={150} />
        <input placeholder="Nombre del paciente" value={campos.nombre} onChange={poner("nombre")} aria-label="Nombre del paciente" maxLength={150} />
        <input placeholder="Documento del paciente" value={campos.documento} onChange={poner("documento")} aria-label="Documento del paciente" maxLength={40} autoComplete="off" />
        <select value="" onChange={(e) => agregar(e.target.value)} aria-label="Agregar medicamento">
          <option value="">+ Agregar medicamento controlado</option>
          {catalogo.map((m) => <option key={m.id_medicamento} value={m.id_medicamento}>{m.nombre_comercial}</option>)}
        </select>
      </div>
      {lineas.map((l) => (
        <div key={l.id_medicamento} className="inv-filtros dos">
          <span>{l.nombre_comercial}</span>
          <span>
            <input type="number" min="1" step="1" value={l.cantidad} aria-label={`Cantidad de ${l.nombre_comercial}`}
              onChange={(e) => setLineas(lineas.map((x) => (x.id_medicamento === l.id_medicamento ? { ...x, cantidad: e.target.value } : x)))} />
            <button type="button" className="enlace" onClick={() => setLineas(lineas.filter((x) => x.id_medicamento !== l.id_medicamento))}>Quitar</button>
          </span>
        </div>
      ))}
      <button className="primary" disabled={ocupado}>{ocupado ? "Emitiendo…" : "Emitir receta"}</button>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
    </form>
  );
}
