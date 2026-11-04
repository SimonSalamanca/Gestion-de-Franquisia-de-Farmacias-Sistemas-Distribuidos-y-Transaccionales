import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";

// HU-03: precio de red de cada medicamento con su historial de vigencia (RF-02).
// Mismo componente en el POS y en la consola. Consultar funciona sin conexión en el POS (réplica local);
// registrar y corregir van al central. Un precio que ya rigió no se cambia: se registra uno nuevo.

// Algo más que un ciclo de sincronización (10 s), para releer la réplica del POS ya actualizada.
const RELECTURA_MS = 12000;
const ESTADO = { VIGENTE: ["disponible", "vigente"], PROGRAMADO: ["bajo", "programado"], ANTERIOR: ["agotado", "anterior"] };

function useEnvio(token) {
  const [ocupado, setOcupado] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const enviar = useCallback(
    async (ruta, method, body) => {
      setOcupado(true);
      try {
        const r = await api(ruta, { method, body, token, key });
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
  const { mensaje, ultima_sync: ultima } = r.data || {};
  const base = mensaje || "No se pudo completar la operación";
  if (r.status === 503) return `${base}. Cambiar precios requiere conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}.`;
  return base;
}

// <input type="datetime-local"> trabaja en hora local; el servidor recibe el instante en UTC.
const aInstante = (valor) => (valor ? new Date(valor).toISOString() : null);
const aLocal = (fecha) => {
  const d = new Date(fecha);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export default function Precios({ session }) {
  const base = `/api/${session.nodo}/precios`;
  const puedeCambiar = session.permisos.includes("PRECIO_GESTIONAR");
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState(null);
  const [elegido, setElegido] = useState(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      api(`${base}?q=${encodeURIComponent(texto.trim())}`, { token: session.token }).then((r) => {
        if (r.ok) {
          setLista(r.data.medicamentos);
          setError("");
        } else setError(mensajeError(r));
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [base, session.token, texto, version]);

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Precios</h2>
        <p className="muted">
          Precio de venta único para toda la red, con su historial. Cada factura guarda el precio vigente en el instante de la venta:
          un cambio posterior no la afecta.
        </p>
      </header>
      <div className="inv-filtros dos">
        <input placeholder="Buscar medicamento por nombre, principio activo o código" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar medicamento" />
      </div>
      {error && <div className="error">{error}</div>}
      {lista && lista.length === 0 && <div className="inv-vacio">No hay medicamentos con ese texto.</div>}
      <ul className="inv-lista">
        {(lista || []).map((med) => (
          <li key={med.id_medicamento} className="inv-item">
            <div className="inv-fila">
              <div>
                <button className="enlace" onClick={() => setElegido(elegido === med.id_medicamento ? null : med.id_medicamento)}>
                  {med.nombre_comercial}
                </button>
                <div className="muted">{med.principio_activo} · {med.codigo_interno}</div>
              </div>
              <div className="inv-stock">
                <strong>{pesos(med.precio_vigente)}</strong>
                {med.proximo && (
                  <span className="pill bajo">pasa a {pesos(med.proximo.precio)} el {fechaHora(med.proximo.desde)}</span>
                )}
                <button className="ghost" onClick={() => setElegido(elegido === med.id_medicamento ? null : med.id_medicamento)}>
                  {elegido === med.id_medicamento ? "Ocultar historial" : "Historial"}
                </button>
              </div>
            </div>
            {elegido === med.id_medicamento && (
              <Historial base={base} token={session.token} idMedicamento={med.id_medicamento} puedeCambiar={puedeCambiar} onCambio={() => {
                  // Ya mismo (la consola lee el central) y otra vez tras la sincronización (el POS lee su réplica).
                  setVersion((v) => v + 1);
                  setTimeout(() => setVersion((v) => v + 1), RELECTURA_MS);
                }} />
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

function Historial({ base, token, idMedicamento, puedeCambiar, onCambio }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [corrigiendo, setCorrigiendo] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api(`${base}/${idMedicamento}`, { token }).then((r) => {
      if (r.ok) {
        setDatos(r.data);
        setError("");
      } else setError(mensajeError(r));
    });
  }, [base, token, idMedicamento, version]);

  // El POS lee su réplica, que recibe el cambio en la próxima sincronización (~10 s). Mientras tanto se muestra
  // el historial que devolvió el central y luego se vuelve a leer la réplica.
  const listo = (respuesta) => {
    setCorrigiendo(null);
    if (respuesta?.historial) setDatos({ ...respuesta, delCentral: true });
    onCambio();
    setTimeout(() => setVersion((v) => v + 1), RELECTURA_MS);
  };

  return (
    <div className="historial">
      {error && <div className="error">{error}</div>}
      {datos && (
        <>
          <strong>Historial de precios</strong>
          {datos.delCentral && base.startsWith("/api/local") && (
            <p className="muted">Guardado en el nodo central. Esta tienda lo recibe en la próxima sincronización (unos segundos).</p>
          )}
          {datos.historial.length === 0 ? (
            <p className="muted">Sin precios registrados: no se puede vender hasta tener uno.</p>
          ) : (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr>
                    <th className="num">Precio</th>
                    <th>Rige desde</th>
                    <th>Hasta</th>
                    <th>Estado</th>
                    <th>Registró</th>
                    {puedeCambiar && <th />}
                  </tr>
                </thead>
                <tbody>
                  {datos.historial.map((p) => (
                    <tr key={p.id_precio}>
                      <td className="num"><strong>{pesos(p.precio)}</strong></td>
                      <td>{fechaHora(p.fecha_inicio_vigencia)}</td>
                      <td>{p.fecha_fin_vigencia ? fechaHora(p.fecha_fin_vigencia) : <span className="muted">—</span>}</td>
                      <td><span className={`pill ${ESTADO[p.estado][0]}`}>{ESTADO[p.estado][1]}</span></td>
                      <td className="muted">{p.registrado_por || "Sistema"}</td>
                      {puedeCambiar && (
                        <td>
                          {p.estado === "PROGRAMADO" && (
                            <button className="enlace" onClick={() => setCorrigiendo(corrigiendo === p.id_precio ? null : p.id_precio)}>Corregir</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {corrigiendo && (
            <FormPrecio
              titulo="Corregir precio programado"
              ruta={`${base}/registro/${corrigiendo}`}
              metodo="PATCH"
              token={token}
              inicial={datos.historial.find((p) => p.id_precio === corrigiendo)}
              onListo={listo}
            />
          )}
          {puedeCambiar && !corrigiendo && (
            <FormPrecio titulo="Nuevo precio" ruta={`${base}/${idMedicamento}`} metodo="POST" token={token} onListo={listo} />
          )}
        </>
      )}
    </div>
  );
}

function FormPrecio({ titulo, ruta, metodo, token, inicial, onListo }) {
  const { enviar, ocupado } = useEnvio(token);
  const [precio, setPrecio] = useState(inicial ? String(Number(inicial.precio)) : "");
  const [cuando, setCuando] = useState(inicial ? "programar" : "ahora");
  const [desde, setDesde] = useState(inicial ? aLocal(inicial.fecha_inicio_vigencia) : "");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function guardar(event) {
    event.preventDefault();
    setError("");
    setOk("");
    const valor = precio.trim().replace(",", ".");
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(valor) || Number(valor) <= 0) return setError("Precio mayor que cero, con máximo dos decimales");
    if (cuando === "programar") {
      if (!desde) return setError("Elija desde cuándo rige");
      if (new Date(desde).getTime() < Date.now() - 60000) return setError("La fecha de inicio no puede estar en el pasado");
    }
    const r = await enviar(ruta, metodo, { precio: valor, desde: cuando === "programar" ? aInstante(desde) : null });
    if (!r.ok) return setError(mensajeError(r));
    setOk(cuando === "ahora" ? "Precio vigente desde ahora. Las tiendas lo reciben en su próxima sincronización." : "Precio programado.");
    setPrecio("");
    onListo(r.data);
  }

  return (
    <form className="subform" onSubmit={guardar}>
      <strong>{titulo}</strong>
      <div className="inv-filtros tres">
        <input type="number" min="0.01" step="0.01" placeholder="Precio en pesos" value={precio} onChange={(e) => setPrecio(e.target.value)} aria-label="Precio" />
        <select value={cuando} onChange={(e) => setCuando(e.target.value)} aria-label="Desde cuándo rige">
          <option value="ahora">Rige desde ahora</option>
          <option value="programar">Programar fecha y hora</option>
        </select>
        {cuando === "programar" && (
          <input type="datetime-local" value={desde} min={aLocal(Date.now())} onChange={(e) => setDesde(e.target.value)} aria-label="Rige desde" />
        )}
      </div>
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Guardar precio"}</button>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
    </form>
  );
}
