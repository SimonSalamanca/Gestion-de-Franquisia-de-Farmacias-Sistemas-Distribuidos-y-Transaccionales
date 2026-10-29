import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import Inventario from "./Inventario.jsx";
import Lotes from "./Lotes.jsx";

const CUENTAS = [
  { usuario: "cajero1", password: "Farma123", rol: "Cajero", nodo: "local" },
  { usuario: "admin.tienda", password: "Farma123", rol: "Admin de tienda", nodo: "local" },
  { usuario: "admin.general", password: "Farma123", rol: "Admin general", nodo: "central" },
];

const AMBITO = {
  INVENTARIO_CONSULTAR: "tienda",
  INVENTARIO_GESTIONAR: "tienda",
  VENTA_REGISTRAR: "tienda",
  FACTURA_ANULAR: "tienda",
  PRECIO_GESTIONAR: "tienda",
  EMPLEADO_GESTIONAR: "tienda",
  CAJA_CERRAR: "tienda",
  RED_VISIBILIDAD: "red",
  RED_CONTROL: "red",
  TIENDA_GESTIONAR: "red",
  REPORTE_CONSOLIDADO_VER: "red",
};

// HU-01 y HU-02: los módulos de inventario del POS tienen pantalla propia; el resto muestra la tarjeta del módulo.
const PANTALLAS = { INVENTARIO_CONSULTAR: Inventario, INVENTARIO_GESTIONAR: Lotes };

export default function App() {
  const [session, setSession] = useState(() => {
    const raw = sessionStorage.getItem("farmahub");
    return raw ? JSON.parse(raw) : null;
  });
  const [catalogo, setCatalogo] = useState({});
  const [estado, setEstado] = useState("online");
  const [forzado, setForzado] = useState(null);
  const [ultimaSync, setUltimaSync] = useState(null);

  useEffect(() => {
    api("/api/modulos").then((result) => {
      if (result.ok) setCatalogo(result.data);
    });
    const timer = setInterval(() => {
      api("/api/conectividad").then((result) => {
        if (!result.ok) return;
        setEstado(result.data.estado_real || result.data.estado);
        setForzado(result.data.forzado);
        setUltimaSync(result.data.ultima_sync);
      });
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  function enter(next) {
    sessionStorage.setItem("farmahub", JSON.stringify(next));
    setSession(next);
  }

  async function salir() {
    if (session) await api("/api/auth/logout", { method: "POST", token: session.token, body: { nodo: session.nodo } });
    sessionStorage.removeItem("farmahub");
    setSession(null);
  }

  if (!session) {
    return (
      <Login
        estado={estado}
        forzado={forzado}
        ultimaSync={ultimaSync}
        onEstado={setEstado}
        onForzado={setForzado}
        onEnter={enter}
      />
    );
  }

  return (
    <Shell
      session={session}
      catalogo={catalogo}
      estado={estado}
      forzado={forzado}
      ultimaSync={ultimaSync}
      onEstado={setEstado}
      onForzado={setForzado}
      onSalir={salir}
    />
  );
}

function Login({ estado, forzado, ultimaSync, onEstado, onForzado, onEnter }) {
  const [nodo, setNodo] = useState("local");
  const [usuario, setUsuario] = useState("cajero1");
  const [password, setPassword] = useState("Farma123");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  async function simular(body) {
    const result = await api("/api/conectividad/simular", { method: "POST", body });
    if (result.ok) {
      onEstado(result.data.estado_real || result.data.estado);
      onForzado(result.data.forzado);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/${nodo}/auth/login`, {
        method: "POST",
        body: { usuario, password },
        key,
      });
      if (!result.ok) {
        setKey(crypto.randomUUID());
        setError(result.data.mensaje || "No se pudo iniciar sesión");
        return;
      }
      onEnter({ ...result.data, nodo });
    } catch {
      setError("No hay respuesta del servidor. ¿Está corriendo el API?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="brand">
        <div>
          <h1>FarmaHub</h1>
          <p>Punto de venta de la farmacia. El rol decide qué módulos se ven. La caja no depende del nodo central.</p>
        </div>
        <p>Contraseña de prueba: Farma123</p>
      </section>
      <section className="panel">
        <form className="card" onSubmit={submit}>
          <h2>Iniciar sesión</h2>
          <p className="muted">Estado real: <span className={`pill ${estado}`}>{estado}</span>{forzado ? <> · Forzado: <span className={`pill ${forzado}`}>{forzado}</span></> : null}</p>
          {ultimaSync && <p className="muted">Última sync: {new Date(ultimaSync).toLocaleString()}</p>}
          <label>Acceso</label>
          <select value={nodo} onChange={(event) => setNodo(event.target.value)}>
            <option value="local">Punto de venta (nodo local)</option>
            <option value="central">Consola de red (nodo central)</option>
          </select>
          <label>Usuario</label>
          <input value={usuario} onChange={(event) => setUsuario(event.target.value)} autoComplete="username" />
          <label>Contraseña</label>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          <button className="primary full" disabled={busy}>{busy ? "Entrando..." : "Entrar"}</button>
          {error && <div className="error">{error}</div>}
          <div className="accounts">
            {CUENTAS.map((cuenta) => (
              <button
                type="button"
                className="ghost"
                key={cuenta.usuario}
                onClick={() => {
                  setUsuario(cuenta.usuario);
                  setPassword(cuenta.password);
                  setNodo(cuenta.nodo);
                  setKey(crypto.randomUUID());
                }}
              >
                {cuenta.rol} · {cuenta.usuario}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" className="ghost" onClick={() => simular({ probe: "ok" })}>Probe ok</button>
            <button type="button" className="ghost" onClick={() => simular({ probe: "lento" })}>Latencia alta</button>
            <button type="button" className="danger" onClick={() => simular({ probe: "timeout", veces: 5 })}>5 timeouts</button>
            <button type="button" className="ghost" onClick={() => simular({ estado: forzado ? "online" : "offline" })}>{forzado ? "Quitar forzado" : "Forzado"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Shell({ session, catalogo, estado, forzado, ultimaSync, onEstado, onForzado, onSalir }) {
  const visibles = useMemo(() => {
    return session.permisos
      .filter((codigo) => catalogo[codigo])
      .filter((codigo) => (session.nodo === "central" ? AMBITO[codigo] === "red" : AMBITO[codigo] === "tienda"))
      .map((codigo) => ({ codigo, ...catalogo[codigo] }));
  }, [session, catalogo]);
  const [activo, setActivo] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState("");
  const Pantalla = session.nodo === "local" ? PANTALLAS[detalle?.codigo] : null;

  async function abrir(codigo) {
    setActivo(codigo);
    setError("");
    const result = await api(`/api/${session.nodo}/modulos/${codigo}`, { token: session.token });
    if (!result.ok) {
      setDetalle(null);
      setError(result.data.mensaje || "Acceso rechazado");
      return;
    }
    setDetalle(result.data);
  }

  async function simular(body) {
    const result = await api("/api/conectividad/simular", { method: "POST", body });
    if (result.ok) {
      onEstado(result.data.estado_real || result.data.estado);
      onForzado(result.data.forzado);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="identity">
          <strong>FarmaHub</strong>
          <span>{session.nombre}</span>
          <span className="badge">{session.rol_etiqueta}</span>
          <span className="muted">{session.tienda}</span>
        </div>
        <div className="row">
          <span className={`pill ${estado}`}>{estado}</span>
          {forzado && <span className={`pill ${forzado}`}>forzado {forzado}</span>}
          <button className="ghost" onClick={() => simular({ probe: "ok" })}>Probe ok</button>
          <button className="ghost" onClick={() => simular({ probe: "lento" })}>Latencia</button>
          <button className="danger" onClick={() => simular({ probe: "timeout", veces: 5 })}>5 timeouts</button>
          <button className="ghost" onClick={() => simular({ estado: forzado ? "online" : "offline" })}>{forzado ? "Quitar forzado" : "Forzado"}</button>
          <button className="ghost" onClick={onSalir}>Salir</button>
        </div>
      </header>
      <div className="workspace">
        <nav>
          <p className="muted">Módulos de su rol</p>
          {visibles.map((modulo) => (
            <button key={modulo.codigo} className={activo === modulo.codigo ? "active" : ""} onClick={() => abrir(modulo.codigo)}>
              {modulo.titulo}
            </button>
          ))}
          {visibles.length === 0 && <p>Este acceso no tiene módulos en este nodo.</p>}
        </nav>
        <section className="content">
          {!activo && (
            <div className="empty">
              {visibles.map((modulo) => (
                <button key={modulo.codigo} className="tile" onClick={() => abrir(modulo.codigo)}>
                  <strong>{modulo.titulo}</strong>
                  <p className="muted">{modulo.texto}</p>
                </button>
              ))}
            </div>
          )}
          {error && <div className="error">{error}{ultimaSync ? ` Última sync: ${new Date(ultimaSync).toLocaleString()}` : ""}</div>}
          {detalle && Pantalla && <Pantalla key={detalle.codigo} session={session} ultimaSync={ultimaSync} />}
          {detalle && !Pantalla && (
            <article className="module">
              <h2>{detalle.titulo}</h2>
              <p>{detalle.texto}</p>
              <p className="muted">{detalle.tienda} · {detalle.rol}</p>
              <code>{detalle.codigo}</code>
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
