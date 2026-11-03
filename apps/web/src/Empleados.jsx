import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

// HU-07: cuentas de empleados. Mismo componente en el POS (admin de tienda: su tienda) y en la consola
// (admin general: toda la red). Las reglas de jerarquía las aplica el servidor; aquí solo se ofrecen las
// opciones que devuelve (roles asignables y tiendas). Todo pasa por el central: sin conexión, 503.

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
  if (r.status === 503) return `${base}. La gestión de cuentas requiere conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}.`;
  return base;
}

const VACIO = { usuario: "", nombre_completo: "", correo: "", id_rol: "", id_tienda: "" };

export default function Empleados({ session }) {
  const base = `/api/${session.nodo}/empleados`;
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [tienda, setTienda] = useState("");
  const [abierto, setAbierto] = useState(null); // { id, modo: "editar" | "estado" } | "nueva"
  const [codigo, setCodigo] = useState(null); // { usuario, codigo, expira_en }
  const recargar = () => setVersion((v) => v + 1);

  useEffect(() => {
    const params = new URLSearchParams();
    if (tienda) params.set("tienda", tienda);
    api(`${base}?${params}`, { token: session.token }).then((r) => {
      if (r.ok) {
        setDatos(r.data);
        setError("");
      } else setError(mensajeError(r));
    });
  }, [base, session.token, tienda, version]);

  const general = datos?.actor.rol === "administrador_general";
  const alternar = (id, modo) => setAbierto(abierto?.id === id && abierto.modo === modo ? null : { id, modo });

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Empleados</h2>
        <p className="muted">
          {general ? "Cuentas de toda la red." : "Cuentas de su tienda."} Las contraseñas las elige cada empleado con un código de un solo uso: el administrador nunca las ve.
        </p>
      </header>
      {codigo && <CodigoEntregado codigo={codigo} onCerrar={() => setCodigo(null)} />}
      {error && <div className="error">{error}</div>}
      {datos && (
        <>
          <div className="row" style={{ margin: "12px 0" }}>
            {general && (
              <select value={tienda} onChange={(e) => setTienda(e.target.value)} aria-label="Tienda">
                <option value="">Todas las tiendas</option>
                {datos.tiendas.map((t) => (
                  <option key={t.id_tienda} value={t.id_tienda}>{t.nombre}</option>
                ))}
              </select>
            )}
            <button className="primary" onClick={() => setAbierto(abierto === "nueva" ? null : "nueva")}>Nueva cuenta</button>
          </div>
          {abierto === "nueva" && (
            <FormCuenta
              base={base}
              token={session.token}
              datos={datos}
              inicial={VACIO}
              onListo={(r) => {
                setAbierto(null);
                if (r.data.codigo) setCodigo({ usuario: r.data.empleado.usuario, codigo: r.data.codigo, expira_en: r.data.codigo_expira_en, alta: true });
                recargar();
              }}
            />
          )}
          {datos.empleados.length === 0 && <div className="inv-vacio">No hay cuentas.</div>}
          <ul className="inv-lista">
            {datos.empleados.map((e) => (
              <li key={e.id_empleado} className="inv-item">
                <div className="inv-fila">
                  <div>
                    <strong>{e.nombre_completo}</strong> <span className="muted">{e.usuario}</span>
                    <div className="muted">
                      {e.rol_etiqueta}
                      {general ? ` · ${e.tienda}` : ""}
                      {e.correo ? ` · ${e.correo}` : ""}
                    </div>
                  </div>
                  <div className="inv-stock">
                    <span className={`pill ${e.activo ? "disponible" : "agotado"}`}>{e.activo ? "activa" : "desactivada"}</span>
                    {/* La jerarquía la aplica el servidor; aquí solo se evita ofrecer lo que rechazaría. */}
                    {!general && e.rol === "administrador_general" ? (
                      <span className="muted">La gestiona la administración de la red</span>
                    ) : (
                      <>
                        <button className="ghost" onClick={() => alternar(e.id_empleado, "editar")}>Editar</button>
                        {e.activo && <GenerarCodigo base={base} token={session.token} empleado={e} onCodigo={setCodigo} onError={setError} />}
                        {e.id_empleado !== datos.actor.id_empleado && (
                          <button className={e.activo ? "danger" : "ghost"} onClick={() => alternar(e.id_empleado, "estado")}>
                            {e.activo ? "Desactivar" : "Reactivar"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {abierto?.id === e.id_empleado && abierto.modo === "editar" && (
                  <FormCuenta
                    base={base}
                    token={session.token}
                    datos={datos}
                    inicial={e}
                    editar
                    onListo={() => {
                      setAbierto(null);
                      recargar();
                    }}
                    onConflicto={recargar}
                  />
                )}
                {abierto?.id === e.id_empleado && abierto.modo === "estado" && (
                  <CambiarEstado
                    base={base}
                    token={session.token}
                    empleado={e}
                    onListo={() => {
                      setAbierto(null);
                      recargar();
                    }}
                    onCancelar={() => setAbierto(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

function CodigoEntregado({ codigo, onCerrar }) {
  return (
    <div className="ok">
      <p>
        {codigo.alta ? "Cuenta creada. " : ""}Código para <strong>{codigo.usuario}</strong>:{" "}
        <strong style={{ fontSize: 20, letterSpacing: 2 }}>{codigo.codigo}</strong>
      </p>
      <p className="muted">
        Entrégueselo en persona. Vence el {new Date(codigo.expira_en).toLocaleString()} y sirve una sola vez: el empleado lo usa en
        "Restablecer contraseña" de la pantalla de inicio para elegir su contraseña. No se volverá a mostrar.
      </p>
      <button className="ghost" onClick={onCerrar}>Entendido</button>
    </div>
  );
}

function FormCuenta({ base, token, datos, inicial, editar = false, onListo, onConflicto }) {
  const { enviar, ocupado } = useEnvio(token);
  const general = datos.actor.rol === "administrador_general";
  const propia = editar && inicial.id_empleado === datos.actor.id_empleado;
  const [form, setForm] = useState(() => ({
    usuario: inicial.usuario || "",
    nombre_completo: inicial.nombre_completo || "",
    correo: inicial.correo || "",
    id_rol: inicial.id_rol ? String(inicial.id_rol) : String(datos.roles[0]?.id_rol || ""),
    id_tienda: inicial.id_tienda ? String(inicial.id_tienda) : String(datos.tiendas[0]?.id_tienda || ""),
  }));
  const [error, setError] = useState("");
  const campo = (nombre) => (e) => setForm({ ...form, [nombre]: e.target.value });
  // El rol actual puede no estar entre los asignables (p. ej. un admin general visto por otro): se muestra igual.
  const roles = datos.roles.some((r) => String(r.id_rol) === form.id_rol)
    ? datos.roles
    : [...datos.roles, { id_rol: inicial.id_rol, etiqueta: inicial.rol_etiqueta }];

  async function guardar(event) {
    event.preventDefault();
    setError("");
    if (!editar && !/^[a-z0-9][a-z0-9._-]{2,59}$/.test(form.usuario.trim().toLowerCase())) {
      return setError("Usuario: de 3 a 60 caracteres en minúsculas, números, punto, guion o guion bajo");
    }
    if (form.nombre_completo.trim().length < 3) return setError("El nombre es obligatorio");
    const body = {
      nombre_completo: form.nombre_completo.trim(),
      correo: form.correo.trim() || null,
      id_rol: Number(form.id_rol),
      ...(general ? { id_tienda: Number(form.id_tienda) } : {}),
    };
    const r = editar
      ? await enviar(`${base}/${inicial.id_empleado}`, "PATCH", { ...body, version_cuenta: inicial.version_cuenta })
      : await enviar(base, "POST", { ...body, usuario: form.usuario.trim().toLowerCase() });
    if (!r.ok) {
      setError(mensajeError(r));
      if (r.status === 409 && onConflicto) onConflicto();
      return;
    }
    onListo(r);
  }

  return (
    <form className={editar ? "subform" : "formulario"} onSubmit={guardar}>
      {!editar && <h3>Nueva cuenta</h3>}
      <div className="inv-filtros dos">
        <input placeholder="Usuario (p. ej. maria.lopez)" maxLength={60} value={form.usuario} onChange={campo("usuario")} disabled={editar} aria-label="Usuario" />
        <input placeholder="Nombre completo" maxLength={150} value={form.nombre_completo} onChange={campo("nombre_completo")} aria-label="Nombre completo" />
        <input placeholder="Correo (opcional)" maxLength={120} value={form.correo} onChange={campo("correo")} aria-label="Correo" />
        <select value={form.id_rol} onChange={campo("id_rol")} disabled={propia} aria-label="Rol">
          {roles.map((r) => (
            <option key={r.id_rol} value={r.id_rol}>{r.etiqueta}</option>
          ))}
        </select>
        {general && (
          <select value={form.id_tienda} onChange={campo("id_tienda")} disabled={propia} aria-label="Tienda">
            {datos.tiendas.map((t) => (
              <option key={t.id_tienda} value={t.id_tienda}>{t.nombre}</option>
            ))}
          </select>
        )}
      </div>
      {editar && <p className="muted">El usuario no se puede cambiar.{propia ? " Su propio rol y tienda solo los cambia otro administrador." : ""}</p>}
      {!editar && <p className="muted">Al crearla se genera un código de activación (24 h) para que el empleado elija su contraseña.</p>}
      <button className="primary" disabled={ocupado}>{ocupado ? "Guardando…" : editar ? "Guardar cambios" : "Crear cuenta"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function GenerarCodigo({ base, token, empleado, onCodigo, onError }) {
  const { enviar, ocupado } = useEnvio(token);
  async function generar() {
    onError("");
    const r = await enviar(`${base}/${empleado.id_empleado}/codigo`, "POST");
    if (!r.ok) return onError(mensajeError(r));
    if (r.data.codigo) onCodigo({ usuario: empleado.usuario, codigo: r.data.codigo, expira_en: r.data.codigo_expira_en });
  }
  return (
    <button className="ghost" disabled={ocupado} onClick={generar} title="Genera un código de un solo uso (30 min) para restablecer la contraseña">
      {ocupado ? "Generando…" : "Código de contraseña"}
    </button>
  );
}

function CambiarEstado({ base, token, empleado, onListo, onCancelar }) {
  const { enviar, ocupado } = useEnvio(token);
  const [error, setError] = useState("");
  const accion = empleado.activo ? "desactivar" : "reactivar";

  async function confirmar() {
    setError("");
    const r = await enviar(`${base}/${empleado.id_empleado}/${accion}`, "POST", { version_cuenta: empleado.version_cuenta });
    if (!r.ok) return setError(mensajeError(r));
    onListo();
  }

  return (
    <div className="subform">
      <p>
        {empleado.activo
          ? <>¿Desactivar la cuenta de <strong>{empleado.nombre_completo}</strong>? Se cierran sus sesiones y no podrá entrar. Su historial se conserva.</>
          : <>¿Reactivar la cuenta de <strong>{empleado.nombre_completo}</strong>?</>}
      </p>
      <div className="row">
        <button className={empleado.activo ? "danger" : "primary"} disabled={ocupado} onClick={confirmar}>
          {ocupado ? "Guardando…" : empleado.activo ? "Confirmar desactivación" : "Confirmar reactivación"}
        </button>
        <button className="ghost" onClick={onCancelar}>Cancelar</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
