import { useEffect, useState } from "react";
import { api } from "./api.js";
import { RELECTURA_MS, mensajeError, useEnvio } from "./abastecimientoUi.jsx";

// HU-13: registro de proveedores (RF-09). Mismo componente en el POS y en la consola. Consultar funciona sin conexión
// en el POS (réplica local); registrar y editar van al central. Desactivar un proveedor no toca las solicitudes ya hechas.

const VACIO = { nombre_empresa: "", nit: "", telefono: "", correo: "", direccion: "" };
const CAMPOS = Object.keys(VACIO);

export default function Proveedores({ session }) {
  const base = `/api/${session.nodo}/proveedores`;
  const [texto, setTexto] = useState("");
  const [inactivos, setInactivos] = useState(false);
  const [lista, setLista] = useState(null);
  const [version, setVersion] = useState(0);
  const [editando, setEditando] = useState(null); // null = cerrado, 0 = nuevo, id = edición
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const { enviar, ocupado } = useEnvio(session.token);

  useEffect(() => {
    const timer = setTimeout(() => {
      api(`${base}?detalle=1&q=${encodeURIComponent(texto.trim())}&incluir_inactivos=${inactivos ? 1 : 0}`, { token: session.token }).then((r) => {
        if (r.ok) {
          setLista(r.data.proveedores);
          setError("");
        } else setError(mensajeError(r));
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [base, session.token, texto, inactivos, version]);

  // La consola lee el central (ya actualizado); el POS lee su réplica, que recibe el cambio en la próxima sincronización.
  const alCambiar = (mensaje) => {
    setAviso(mensaje);
    setEditando(null);
    setVersion((v) => v + 1);
    if (session.nodo === "local") setTimeout(() => setVersion((v) => v + 1), RELECTURA_MS);
  };

  async function alternarActivo(p) {
    setError("");
    const r = await enviar(`${base}/${p.id_proveedor}`, "PATCH", { activo: !p.activo });
    if (!r.ok) return setError(mensajeError(r, { requiereCentral: true }));
    alCambiar(`Proveedor ${p.activo ? "desactivado: ya no se pueden generar solicitudes con él" : "activado"}.`);
  }

  return (
    <div>
      <p className="muted">
        Registro de proveedores de medicamentos de toda la red. Sin un proveedor activo no se puede generar una solicitud de reabastecimiento.
      </p>
      <div className="inv-filtros dos">
        <input placeholder="Buscar por nombre o NIT" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar proveedor" />
        <label className="check">
          <input type="checkbox" checked={inactivos} onChange={(e) => setInactivos(e.target.checked)} /> Incluir inactivos
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={() => { setEditando(editando === 0 ? null : 0); setAviso(""); }}>
          {editando === 0 ? "Cerrar" : "Nuevo proveedor"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {aviso && <div className="ok">{aviso}{session.nodo === "local" ? " Esta tienda lo recibe en la próxima sincronización (unos segundos)." : ""}</div>}
      {editando === 0 && <FormProveedor titulo="Nuevo proveedor" ruta={base} metodo="POST" enviar={enviar} ocupado={ocupado} onListo={() => alCambiar("Proveedor registrado.")} />}
      {lista && lista.length === 0 && <div className="inv-vacio">No hay proveedores con ese criterio.</div>}
      <ul className="inv-lista">
        {(lista || []).map((p) => (
          <li key={p.id_proveedor} className="inv-item">
            <div className="inv-fila">
              <div>
                <strong>{p.nombre_empresa}</strong> <span className={`pill ${p.activo ? "disponible" : "agotado"}`}>{p.activo ? "Activo" : "Inactivo"}</span>
                <div className="muted">NIT {p.nit || "—"} · {p.telefono || "sin teléfono"} · {p.correo || "sin correo"}</div>
                {p.direccion && <div className="muted">{p.direccion}</div>}
                {p.solicitudes_abiertas > 0 && <div className="muted">{p.solicitudes_abiertas} solicitud(es) abierta(s)</div>}
              </div>
              <div className="inv-stock">
                <button className="ghost" onClick={() => { setEditando(editando === p.id_proveedor ? null : p.id_proveedor); setAviso(""); }}>
                  {editando === p.id_proveedor ? "Cerrar" : "Editar"}
                </button>
                <button className="ghost" disabled={ocupado} onClick={() => alternarActivo(p)}>{p.activo ? "Desactivar" : "Activar"}</button>
              </div>
            </div>
            {editando === p.id_proveedor && (
              <FormProveedor
                titulo="Editar proveedor"
                ruta={`${base}/${p.id_proveedor}`}
                metodo="PATCH"
                inicial={p}
                enviar={enviar}
                ocupado={ocupado}
                onListo={() => alCambiar("Cambios guardados.")}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FormProveedor({ titulo, ruta, metodo, inicial, enviar, ocupado, onListo }) {
  const [form, setForm] = useState(() => Object.fromEntries(CAMPOS.map((c) => [c, inicial?.[c] ?? ""])));
  const [error, setError] = useState("");
  const campo = (nombre) => (e) => setForm((f) => ({ ...f, [nombre]: e.target.value }));

  async function guardar(event) {
    event.preventDefault();
    setError("");
    if (form.nombre_empresa.trim().length < 3) return setError("El nombre de la empresa debe tener al menos 3 caracteres");
    if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{4,39}$/.test(form.nit.trim())) return setError("El NIT debe tener entre 5 y 40 caracteres (letras, números, punto o guion)");
    if (form.correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.correo.trim())) return setError("Correo no válido");
    const r = await enviar(ruta, metodo, form);
    if (!r.ok) return setError(mensajeError(r, { requiereCentral: true }));
    onListo(r.data);
  }

  return (
    <form className="subform" onSubmit={guardar}>
      <strong>{titulo}</strong>
      <div className="inv-filtros tres">
        <input placeholder="Nombre de la empresa" value={form.nombre_empresa} onChange={campo("nombre_empresa")} aria-label="Nombre de la empresa" maxLength={150} />
        <input placeholder="NIT" value={form.nit} onChange={campo("nit")} aria-label="NIT" maxLength={40} />
        <input placeholder="Teléfono (opcional)" value={form.telefono} onChange={campo("telefono")} aria-label="Teléfono" maxLength={30} />
        <input placeholder="Correo (opcional)" type="email" value={form.correo} onChange={campo("correo")} aria-label="Correo" maxLength={120} />
        <input placeholder="Dirección (opcional)" value={form.direccion} onChange={campo("direccion")} aria-label="Dirección" maxLength={200} />
      </div>
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : "Guardar proveedor"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
