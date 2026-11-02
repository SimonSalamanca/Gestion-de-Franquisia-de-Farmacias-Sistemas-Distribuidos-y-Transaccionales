import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

// HU-15: alta, edición, desactivación y umbrales de las tiendas de la red (RF-10). Consola central.
// Las escrituras van con Idempotency-Key (se conserva hasta tener respuesta) y la edición con
// version_tienda: si otro administrador cambió la tienda, el central responde 409 y se recarga.

const PESTANAS = [
  ["lista", "Tiendas"],
  ["nueva", "Nueva tienda"],
];

const VACIA = { nombre: "", direccion: "", ciudad: "", telefono: "", fecha_apertura: "" };

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
  return r.status === 503 && ultima ? `${base}. Última sync: ${new Date(ultima).toLocaleString()}` : base;
}

export default function Tiendas({ session }) {
  const [pestana, setPestana] = useState("lista");
  const [version, setVersion] = useState(0);
  const cambio = () => setVersion((v) => v + 1);
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Tiendas de la red</h2>
        <p className="muted">Una tienda desactivada sale de la búsqueda cruzada y de los reportes activos; su historial se conserva.</p>
      </header>
      <div className="pestanas" role="tablist">
        {PESTANAS.map(([id, texto]) => (
          <button key={id} role="tab" aria-selected={pestana === id} className={pestana === id ? "active" : ""} onClick={() => setPestana(id)}>
            {texto}
          </button>
        ))}
      </div>
      {pestana === "lista" && <ListaTiendas token={session.token} version={version} onCambio={cambio} />}
      {pestana === "nueva" && (
        <FormTienda
          token={session.token}
          inicial={VACIA}
          titulo="Registrar tienda"
          onListo={() => {
            cambio();
            setPestana("lista");
          }}
        />
      )}
    </article>
  );
}

function ListaTiendas({ token, version, onCambio }) {
  const [tiendas, setTiendas] = useState(null);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState(null); // { id, modo: "editar" | "umbrales" | "desactivar" }

  useEffect(() => {
    api("/api/central/tiendas", { token }).then((r) => {
      if (r.ok) {
        setTiendas(r.data.tiendas);
        setError("");
      } else setError(mensajeError(r));
    });
  }, [token, version]);

  const alternar = (id, modo) => setAbierto(abierto?.id === id && abierto.modo === modo ? null : { id, modo });
  const listo = () => {
    setAbierto(null);
    onCambio();
  };

  return (
    <>
      {error && <div className="error">{error}</div>}
      {tiendas && tiendas.length === 0 && <div className="inv-vacio">No hay tiendas registradas.</div>}
      <ul className="inv-lista">
        {(tiendas || []).map((tienda) => (
          <li key={tienda.id_tienda} className="inv-item">
            <div className="inv-fila">
              <div>
                <strong>{tienda.nombre}</strong>
                <div className="muted">
                  {tienda.direccion} · {tienda.ciudad}
                  {tienda.telefono ? ` · ${tienda.telefono}` : ""}
                </div>
              </div>
              <div className="inv-stock">
                <span className={`pill ${tienda.activa ? "disponible" : "agotado"}`}>{tienda.activa ? "activa" : "inactiva"}</span>
                <button className="ghost" onClick={() => alternar(tienda.id_tienda, "editar")}>Editar</button>
                <button className="ghost" onClick={() => alternar(tienda.id_tienda, "umbrales")}>Umbrales</button>
                {tienda.activa && (
                  <button className="danger" onClick={() => alternar(tienda.id_tienda, "desactivar")}>Desactivar</button>
                )}
              </div>
            </div>
            {abierto?.id === tienda.id_tienda && abierto.modo === "editar" && (
              <FormTienda token={token} inicial={tienda} titulo="Editar tienda" editar onListo={listo} onConflicto={onCambio} />
            )}
            {abierto?.id === tienda.id_tienda && abierto.modo === "desactivar" && (
              <Desactivar token={token} tienda={tienda} onListo={listo} onCancelar={() => setAbierto(null)} />
            )}
            {abierto?.id === tienda.id_tienda && abierto.modo === "umbrales" && <Umbrales token={token} tienda={tienda} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function FormTienda({ token, inicial, titulo, editar = false, onListo, onConflicto }) {
  const { enviar, ocupado } = useEnvio(token);
  const [datos, setDatos] = useState(() => ({
    nombre: inicial.nombre || "",
    direccion: inicial.direccion || "",
    ciudad: inicial.ciudad || "",
    telefono: inicial.telefono || "",
    fecha_apertura: inicial.fecha_apertura ? String(inicial.fecha_apertura).slice(0, 10) : "",
    activa: inicial.activa !== false,
  }));
  const [error, setError] = useState("");
  const campo = (nombre) => (e) => setDatos({ ...datos, [nombre]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  async function guardar(event) {
    event.preventDefault();
    setError("");
    if (!datos.nombre.trim() || !datos.direccion.trim() || !datos.ciudad.trim()) {
      return setError("Nombre, dirección y ciudad son obligatorios");
    }
    const body = {
      nombre: datos.nombre.trim(),
      direccion: datos.direccion.trim(),
      ciudad: datos.ciudad.trim(),
      telefono: datos.telefono.trim() || null,
      fecha_apertura: datos.fecha_apertura || null,
    };
    const r = editar
      ? await enviar(`/api/central/tiendas/${inicial.id_tienda}`, "PATCH", { ...body, activa: datos.activa, version_tienda: inicial.version_tienda })
      : await enviar("/api/central/tiendas", "POST", body);
    if (!r.ok) {
      setError(mensajeError(r));
      if (r.status === 409 && onConflicto) onConflicto();
      return;
    }
    onListo();
  }

  return (
    <form className={editar ? "subform" : "formulario"} onSubmit={guardar}>
      {!editar && <h3>{titulo}</h3>}
      <div className="inv-filtros dos">
        <input placeholder="Nombre" maxLength={120} value={datos.nombre} onChange={campo("nombre")} aria-label="Nombre" />
        <input placeholder="Ciudad" maxLength={80} value={datos.ciudad} onChange={campo("ciudad")} aria-label="Ciudad" />
        <input placeholder="Dirección" maxLength={200} value={datos.direccion} onChange={campo("direccion")} aria-label="Dirección" />
        <input placeholder="Teléfono (opcional)" maxLength={30} value={datos.telefono} onChange={campo("telefono")} aria-label="Teléfono" />
        <label className="muted">
          Fecha de apertura (opcional)
          <input type="date" value={datos.fecha_apertura} onChange={campo("fecha_apertura")} />
        </label>
        {editar && (
          <label className="row">
            <input type="checkbox" checked={datos.activa} onChange={campo("activa")} /> Activa
          </label>
        )}
      </div>
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : editar ? "Guardar cambios" : "Registrar tienda"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function Desactivar({ token, tienda, onListo, onCancelar }) {
  const { enviar, ocupado } = useEnvio(token);
  const [error, setError] = useState("");

  async function confirmar() {
    setError("");
    const r = await enviar(`/api/central/tiendas/${tienda.id_tienda}/desactivar`, "POST", { version_tienda: tienda.version_tienda });
    if (!r.ok) return setError(mensajeError(r));
    onListo();
  }

  return (
    <div className="subform">
      <p>
        ¿Desactivar <strong>{tienda.nombre}</strong>? Dejará de aparecer en la disponibilidad cruzada y en los reportes consolidados
        activos. Su punto de venta no se bloquea.
      </p>
      <div className="row">
        <button className="danger" disabled={ocupado} onClick={confirmar}>{ocupado ? "Desactivando…" : "Confirmar desactivación"}</button>
        <button className="ghost" onClick={onCancelar}>Cancelar</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function Umbrales({ token, tienda }) {
  const { enviar, ocupado } = useEnvio(token);
  const [umbrales, setUmbrales] = useState(null);
  const [medicamentos, setMedicamentos] = useState([]);
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState({ id_medicamento: "", stock_minimo: "", dias_alerta_caducidad: "" });
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api(`/api/central/tiendas/${tienda.id_tienda}/umbrales`, { token }).then((r) => {
      if (r.ok) setUmbrales(r.data.umbrales);
      else setError(mensajeError(r));
    });
  }, [token, tienda.id_tienda, version]);

  useEffect(() => {
    api("/api/central/medicamentos", { token }).then((r) => r.ok && setMedicamentos(r.data.medicamentos));
  }, [token]);

  function editar(umbral) {
    setOk("");
    setForm({
      id_medicamento: String(umbral.id_medicamento),
      stock_minimo: String(umbral.stock_minimo),
      dias_alerta_caducidad: String(umbral.dias_alerta_caducidad),
    });
  }

  async function guardar(event) {
    event.preventDefault();
    setError("");
    setOk("");
    const stock = Number(form.stock_minimo);
    const dias = Number(form.dias_alerta_caducidad);
    if (!form.id_medicamento) return setError("Elija un medicamento");
    if (!Number.isInteger(stock) || stock < 0 || !Number.isInteger(dias) || dias < 0 || form.stock_minimo === "" || form.dias_alerta_caducidad === "") {
      return setError("Stock mínimo y días de aviso deben ser enteros mayores o iguales a cero");
    }
    const r = await enviar(`/api/central/tiendas/${tienda.id_tienda}/umbrales`, "PUT", {
      id_medicamento: Number(form.id_medicamento),
      stock_minimo: stock,
      dias_alerta_caducidad: dias,
    });
    if (!r.ok) return setError(mensajeError(r));
    setOk("Umbral guardado. La tienda lo recibe en su próxima sincronización.");
    setForm({ id_medicamento: "", stock_minimo: "", dias_alerta_caducidad: "" });
    setVersion((v) => v + 1);
  }

  return (
    <div className="historial">
      <strong>Umbrales de {tienda.nombre}</strong>
      <p className="muted">Solo afectan a esta tienda.</p>
      {umbrales && umbrales.length === 0 && <p className="muted">Sin umbrales configurados.</p>}
      {umbrales && umbrales.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr>
                <th>Medicamento</th>
                <th className="num">Stock mínimo</th>
                <th className="num">Aviso de caducidad (días)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {umbrales.map((umbral) => (
                <tr key={umbral.id_medicamento}>
                  <td>{umbral.nombre_comercial}</td>
                  <td className="num">{umbral.stock_minimo}</td>
                  <td className="num">{umbral.dias_alerta_caducidad}</td>
                  <td><button className="enlace" onClick={() => editar(umbral)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="subform" onSubmit={guardar}>
        <div className="inv-filtros tres">
          <select value={form.id_medicamento} onChange={(e) => setForm({ ...form, id_medicamento: e.target.value })} aria-label="Medicamento">
            <option value="">Medicamento…</option>
            {medicamentos.map((med) => (
              <option key={med.id_medicamento} value={med.id_medicamento}>{med.nombre_comercial} ({med.codigo_interno})</option>
            ))}
          </select>
          <input type="number" min="0" placeholder="Stock mínimo" value={form.stock_minimo} onChange={(e) => setForm({ ...form, stock_minimo: e.target.value })} aria-label="Stock mínimo" />
          <input type="number" min="0" placeholder="Días de aviso" value={form.dias_alerta_caducidad} onChange={(e) => setForm({ ...form, dias_alerta_caducidad: e.target.value })} aria-label="Días de aviso de caducidad" />
        </div>
        <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Guardar umbral"}</button>
        {error && <div className="error">{error}</div>}
        {ok && <div className="ok">{ok}</div>}
      </form>
    </div>
  );
}
