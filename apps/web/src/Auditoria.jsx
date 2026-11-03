import { useEffect, useState } from "react";
import { api } from "./api.js";

// HU-07: consulta del registro de auditoría (no editable) con filtros por usuario, fecha y tipo de acción.
// POS: la auditoría de la tienda (funciona sin conexión) o las acciones del central sobre sus cuentas.
// Consola: toda la red (central + lo que suben las tiendas), con filtro por origen.

const hoy = () => new Date().toISOString().slice(0, 10);
// Días locales del navegador convertidos a instantes UTC para el servidor.
const inicioDia = (dia) => (dia ? new Date(`${dia}T00:00:00`).toISOString() : "");
const finDia = (dia) => (dia ? new Date(`${dia}T23:59:59.999`).toISOString() : "");

export default function Auditoria({ session }) {
  const central = session.nodo === "central";
  const [filtros, setFiltros] = useState({ usuario: "", accion: "", desde: "", hasta: hoy(), origen: "", tienda: "" });
  const [aplicados, setAplicados] = useState(filtros);
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState(null);
  const [tiendas, setTiendas] = useState([]);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    if (!central) return;
    api("/api/central/tiendas", { token: session.token }).then((r) => r.ok && setTiendas(r.data.tiendas));
  }, [central, session.token]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (aplicados.usuario.trim()) params.set("usuario", aplicados.usuario.trim());
    if (aplicados.accion) params.set("accion", aplicados.accion);
    if (aplicados.desde) params.set("desde", inicioDia(aplicados.desde));
    if (aplicados.hasta) params.set("hasta", finDia(aplicados.hasta));
    if (!central && aplicados.origen) params.set("origen", aplicados.origen);
    if (central && aplicados.tienda) params.set("tienda", aplicados.tienda);
    params.set("pagina", pagina);
    setCargando(true);
    api(`/api/${session.nodo}/auditoria?${params}`, { token: session.token })
      .then((r) => {
        if (r.ok) {
          setDatos(r.data);
          setError("");
        } else {
          setError(r.data.mensaje || "No se pudo consultar la auditoría");
          setDatos(null);
        }
      })
      .finally(() => setCargando(false));
  }, [aplicados, pagina, central, session.nodo, session.token]);

  const campo = (nombre) => (e) => setFiltros({ ...filtros, [nombre]: e.target.value });
  function buscar(event) {
    event.preventDefault();
    setPagina(1);
    setAplicados(filtros);
  }

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Auditoría</h2>
        <p className="muted">
          Registro de solo lectura: nadie puede editarlo ni borrarlo, y se conserva al menos dos años.
          {central ? " Incluye lo registrado en el central y lo que suben las tiendas en cada sincronización." : ""}
        </p>
      </header>
      <form className="inv-filtros" onSubmit={buscar}>
        <input placeholder="Usuario o nombre" value={filtros.usuario} onChange={campo("usuario")} aria-label="Usuario" />
        <select value={filtros.accion} onChange={campo("accion")} aria-label="Tipo de acción">
          <option value="">Todas las acciones</option>
          {(datos?.acciones || []).map((accion) => (
            <option key={accion} value={accion}>{accion}</option>
          ))}
        </select>
        <input type="date" value={filtros.desde} onChange={campo("desde")} aria-label="Desde" />
        <input type="date" value={filtros.hasta} onChange={campo("hasta")} aria-label="Hasta" />
        {central ? (
          <select value={filtros.tienda} onChange={campo("tienda")} aria-label="Origen">
            <option value="">Toda la red</option>
            <option value="central">Solo el nodo central</option>
            {tiendas.map((t) => (
              <option key={t.id_tienda} value={t.id_tienda}>{t.nombre}</option>
            ))}
          </select>
        ) : (
          <select value={filtros.origen} onChange={campo("origen")} aria-label="Origen">
            <option value="">Esta tienda</option>
            <option value="cuentas">Cuentas de esta tienda (central)</option>
          </select>
        )}
        <button className="primary" disabled={cargando}>{cargando ? "Buscando…" : "Filtrar"}</button>
      </form>
      {error && <div className="error">{error}</div>}
      {datos && (
        <>
          <p className="inv-resumen muted">{datos.total} registro(s) · página {datos.pagina} de {datos.paginas}</p>
          {datos.registros.length === 0 && <div className="inv-vacio">No hay registros con esos filtros.</div>}
          {datos.registros.length > 0 && (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Fecha y hora</th>
                    <th>Usuario</th>
                    <th>Acción</th>
                    {central && <th>Origen</th>}
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.registros.map((r) => (
                    <tr key={`${r.origen || "l"}-${r.id_tienda || ""}-${r.id_registro}`}>
                      <td>{new Date(r.fecha_hora).toLocaleString()}</td>
                      <td>{r.usuario ? <>{r.usuario}<div className="muted">{r.nombre_completo}</div></> : <span className="muted">—</span>}</td>
                      <td><code>{r.accion}</code></td>
                      {central && <td>{r.origen === "central" ? "Central" : r.tienda || `Tienda ${r.id_tienda}`}</td>}
                      <td className="muted">{[r.entidad_afectada, r.id_entidad_afectada].filter(Boolean).join(" #")}{r.detalle ? ` · ${r.detalle}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {datos.paginas > 1 && (
            <div className="row inv-paginas">
              <button className="ghost" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
              <button className="ghost" disabled={pagina >= datos.paginas} onClick={() => setPagina((p) => p + 1)}>Siguiente</button>
            </div>
          )}
        </>
      )}
    </article>
  );
}
