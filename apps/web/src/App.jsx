import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

// Paneles desplegables (<details>): se cierran al hacer clic fuera o con Escape, para que no queden tapando el contenido.
function useCerrarFuera() {
  const ref = useRef(null);
  useEffect(() => {
    const alPulsar = (event) => {
      if (ref.current?.open && !ref.current.contains(event.target)) ref.current.open = false;
    };
    const alTeclear = (event) => {
      if (event.key !== "Escape" || !ref.current?.open) return;
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", alPulsar);
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("pointerdown", alPulsar);
      document.removeEventListener("keydown", alTeclear);
    };
  }, []);
  return ref;
}
import { Icono, ICONO_MODULO, Marca } from "./iconos.jsx";
import Inventario from "./Inventario.jsx";
import Lotes from "./Lotes.jsx";
import Tiendas from "./Tiendas.jsx";
import Empleados from "./Empleados.jsx";
import Auditoria from "./Auditoria.jsx";
import Precios from "./Precios.jsx";
import Caja from "./Caja.jsx";
import Anulaciones from "./Anulaciones.jsx";
import InventarioAlertas from "./InventarioAlertas.jsx";
import RecetasEmitidas from "./RecetasEmitidas.jsx";
import Reportes from "./Reportes.jsx";
import ReportesRed from "./ReportesRed.jsx";
import VistaRed from "./VistaRed.jsx";
import Conectividad, { AvisoSimulacion } from "./Conectividad.jsx";
import Pendientes from "./Pendientes.jsx";
import { Avisos } from "./avisos.jsx";
import Abastecimiento from "./Abastecimiento.jsx";
import CierreCaja from "./CierreCaja.jsx";

// Cuentas de demostración de cada tienda (docs/operacion/nodos-locales.md) y la del administrador general (central).
const CUENTAS_TIENDA = {
  1: [
    { usuario: "cajero1", password: "Farma123", rol: "Cajero", nodo: "local" },
    { usuario: "admin.tienda", password: "Farma123", rol: "Admin de tienda", nodo: "local" },
  ],
  2: [
    { usuario: "cajero2", password: "Farma123", rol: "Cajero", nodo: "local" },
    { usuario: "admin.tienda2", password: "Farma123", rol: "Admin de tienda", nodo: "local" },
  ],
};
const CUENTA_GENERAL = { usuario: "admin.general", password: "Farma123", rol: "Admin general", nodo: "central" };
const cuentasDe = (idTienda) => [...(CUENTAS_TIENDA[idTienda] || CUENTAS_TIENDA[1]), CUENTA_GENERAL];
const CAJEROS_DEMO = new Set(Object.values(CUENTAS_TIENDA).map((cuentas) => cuentas[0].usuario));

// Identidad del nodo (id y nombre de su tienda). Se recuerda por dirección (cada tienda tiene la suya) para pintar su color
// desde el primer instante; main.jsx la aplica antes de dibujar. styles.css define el color de cada tienda.
const CLAVE_TIENDA = "farmahub:tienda";

const AMBITO = {
  INVENTARIO_CONSULTAR: "tienda",
  INVENTARIO_GESTIONAR: "tienda",
  VENTA_REGISTRAR: "tienda",
  FACTURA_ANULAR: "tienda",
  CAJA_CERRAR: "tienda",
  // HU-05: reporte de la propia tienda (POS); el comparativo de red es REPORTE_CONSOLIDADO_VER (consola).
  REPORTE_TIENDA_VER: "tienda",
  RED_VISIBILIDAD: "red",
  RED_CONTROL: "red",
  TIENDA_GESTIONAR: "red",
  REPORTE_CONSOLIDADO_VER: "red",
  // HU-07: en el POS (su tienda) y en la consola (toda la red).
  EMPLEADO_GESTIONAR: "ambos",
  AUDITORIA_CONSULTAR: "ambos",
  // HU-03: precio de red; lo cambian el admin de tienda (POS) y el admin general (consola).
  PRECIO_GESTIONAR: "ambos",
  // HU-13: proveedores en el POS (con sus solicitudes) y en la consola (registro de la red).
  PROVEEDOR_GESTIONAR: "ambos",
};

// Módulos con pantalla propia, por nodo; el resto muestra la tarjeta del módulo.
// Local: HU-01 y HU-02 (inventario del POS), HU-08 y HU-12 (caja y recetas), HU-10 (anulaciones), HU-05 (reportes). Central: HU-15 (tiendas de la red), HU-05 (comparativo), HU-16 (vista de red). Ambos: HU-07 y HU-03.
const PANTALLAS = {
  local: { INVENTARIO_CONSULTAR: InventarioAlertas, INVENTARIO_GESTIONAR: Lotes, EMPLEADO_GESTIONAR: Empleados, AUDITORIA_CONSULTAR: Auditoria, PRECIO_GESTIONAR: Precios, PROVEEDOR_GESTIONAR: Abastecimiento, CAJA_CERRAR: CierreCaja, VENTA_REGISTRAR: Caja, FACTURA_ANULAR: Anulaciones, REPORTE_TIENDA_VER: Reportes },
  central: { RED_CONTROL: RecetasEmitidas, TIENDA_GESTIONAR: Tiendas, EMPLEADO_GESTIONAR: Empleados, AUDITORIA_CONSULTAR: Auditoria, PRECIO_GESTIONAR: Precios, PROVEEDOR_GESTIONAR: Abastecimiento, REPORTE_CONSOLIDADO_VER: ReportesRed, RED_VISIBILIDAD: VistaRed },
};

// Menú por secciones, ordenado por la tarea de cada rol (antes salía en el orden de los códigos de permiso).
// CONECTIVIDAD es la demostración de conectividad: no es un permiso, la ven los administradores cuando está habilitada.
const CONECTIVIDAD = "CONECTIVIDAD";
const SECCIONES = [
  { titulo: "Red", codigos: ["RED_VISIBILIDAD", "REPORTE_CONSOLIDADO_VER", "TIENDA_GESTIONAR", "RED_CONTROL"] },
  { titulo: "Operación", codigos: ["VENTA_REGISTRAR", "CAJA_CERRAR", "FACTURA_ANULAR"] },
  { titulo: "Inventario y abastecimiento", codigos: ["INVENTARIO_CONSULTAR", "INVENTARIO_GESTIONAR", "PROVEEDOR_GESTIONAR"] },
  { titulo: "Análisis", codigos: ["REPORTE_TIENDA_VER"] },
  { titulo: "Administración", codigos: ["PRECIO_GESTIONAR", "EMPLEADO_GESTIONAR", "AUDITORIA_CONSULTAR"] },
  { titulo: "Herramientas", codigos: [CONECTIVIDAD] },
];
const MODULO_CONECTIVIDAD = {
  codigo: CONECTIVIDAD,
  titulo: "Conectividad",
  texto: "Demostración de cómo opera la tienda sin el nodo central y cómo se recupera la sincronización.",
};
// Administradores: mismo criterio que el API (simulacion.mjs, PERMISO_ADMIN).
const esAdministrador = (session) => session.permisos.includes("AUDITORIA_CONSULTAR");
// Pantalla con la que abre cada rol: el cajero vende; el administrador general mira la red; el de tienda, su inicio.
function moduloInicial(session, visibles) {
  const tiene = (codigo) => visibles.some((m) => m.codigo === codigo);
  if (session.nodo === "central" && tiene("RED_VISIBILIDAD")) return "RED_VISIBILIDAD";
  if (!esAdministrador(session) && tiene("VENTA_REGISTRAR")) return "VENTA_REGISTRAR";
  return null;
}
// Qué cambia en cada módulo del punto de venta sin conexión con el nodo central (según las rutas del API: lo que pasa por
// enCentral responde 503). Lo que no está aquí funciona igual, solo con la base de la tienda.
const SIN_CENTRAL = {
  EMPLEADO_GESTIONAR: { nivel: "no", texto: "Empleados: no disponible (las cuentas se gestionan en el central)." },
  PRECIO_GESTIONAR: { nivel: "parcial", texto: "Precios: se pueden consultar; cambiarlos necesita el central." },
  PROVEEDOR_GESTIONAR: { nivel: "parcial", texto: "Proveedores: las solicitudes funcionan; registrar o editar proveedores necesita el central." },
  INVENTARIO_CONSULTAR: { nivel: "parcial", texto: "Inventario: funciona; las existencias de otras tiendas no." },
  VENTA_REGISTRAR: { nivel: "parcial", texto: "Ventas y recetas: se vende; validar una receta nueva necesita el central." },
  INVENTARIO_GESTIONAR: { nivel: "parcial", texto: "Lotes y recepción: funciona; los traslados entre tiendas no." },
  AUDITORIA_CONSULTAR: { nivel: "parcial", texto: "Auditoría: la de la tienda funciona; la del central no." },
};

const lugarDe = (session) => (session.nodo === "central" ? "Red · todas las tiendas" : session.tienda);

const ESTADO_TEXTO = { online: "En línea", degradado: "Conexión lenta", offline: "Sin conexión" };
const NODO_TEXTO = { local: "Punto de venta", central: "Consola de red" };

const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
const iniciales = (nombre = "") =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "FH";

// Preferencias de la interfaz en este navegador. Si el almacenamiento no está disponible, se usa el valor por defecto.
function leerPreferencia(clave, porDefecto) {
  try {
    const valor = localStorage.getItem(clave);
    return valor === null ? porDefecto : JSON.parse(valor);
  } catch {
    return porDefecto;
  }
}
function guardarPreferencia(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    /* sin almacenamiento: la preferencia dura solo esta sesión */
  }
}

export default function App() {
  const [session, setSession] = useState(() => {
    const raw = sessionStorage.getItem("farmahub");
    return raw ? JSON.parse(raw) : null;
  });
  const [catalogo, setCatalogo] = useState({});
  const [estado, setEstado] = useState("online");
  const [forzado, setForzado] = useState(null);
  const [ultimaSync, setUltimaSync] = useState(null);
  // El API informa si la simulación de conectividad está habilitada (en el despliegue no): sin ella no se muestran los botones.
  const [simulacion, setSimulacion] = useState(false);
  const [simulacionActiva, setSimulacionActiva] = useState(null);
  const [tienda, setTienda] = useState(() => leerPreferencia(CLAVE_TIENDA, null));
  useEffect(() => {
    if (!tienda?.id) return;
    document.documentElement.dataset.tienda = String(tienda.id);
    guardarPreferencia(CLAVE_TIENDA, tienda);
  }, [tienda?.id, tienda?.nombre]);

  useEffect(() => {
    // Con `npm run dev` la web suele estar lista antes que el API (migra y sincroniza al arrancar):
    // si el catálogo falla, se reintenta en cada ciclo hasta obtenerlo. Sin él no se listan módulos.
    let catalogoCargado = false;
    function cargarCatalogo() {
      if (catalogoCargado) return;
      api("/api/modulos")
        .then((result) => {
          if (!result.ok) return;
          catalogoCargado = true;
          setCatalogo(result.data);
        })
        .catch(() => {});
    }
    function consultarConectividad() {
      api("/api/conectividad")
        .then((result) => {
          if (!result.ok) return;
          setEstado(result.data.estado_real || result.data.estado);
          setForzado(result.data.forzado);
          setUltimaSync(result.data.ultima_sync);
          setSimulacion(Boolean(result.data.simulacion));
          setSimulacionActiva(result.data.simulacion_activa || null);
          if (result.data.tienda?.id) {
            setTienda((actual) =>
              actual?.id === result.data.tienda.id && actual?.nombre === result.data.tienda.nombre ? actual : result.data.tienda,
            );
          }
        })
        .catch(() => {});
    }
    cargarCatalogo();
    consultarConectividad();
    const timer = setInterval(() => {
      cargarCatalogo();
      consultarConectividad();
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
        simulacionActiva={simulacionActiva}
        tienda={tienda}
        ultimaSync={ultimaSync}
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
      simulacion={simulacion}
      simulacionActiva={simulacionActiva}
      ultimaSync={ultimaSync}
      onSalir={salir}
    />
  );
}

/* ====================================================================== Login */

// Ilustración de las esquinas: farmacias como nodos de la red, unidas por enlaces por donde viaja la información.
const ESQUINAS = {
  inferior: {
    tiendas: [
      { x: 30, y: 230, s: 1 },
      { x: 250, y: 252, s: 0.8 },
    ],
    nodos: [[110, 120], [190, 150], [330, 170], [405, 95]],
    enlaces: [[70, 212, 110, 120], [110, 120, 190, 150], [190, 150, 282, 238], [190, 150, 330, 170], [330, 170, 405, 95]],
  },
  superior: {
    tiendas: [
      { x: 300, y: 60, s: 0.9 },
      { x: 120, y: 20, s: 0.7 },
    ],
    nodos: [[255, 200], [150, 230], [55, 170], [390, 250]],
    enlaces: [[336, 132, 255, 200], [255, 200, 150, 230], [150, 230, 55, 170], [148, 76, 55, 170], [148, 76, 255, 200], [255, 200, 390, 250]],
  },
};

// Colores de la ilustración desde variables CSS (styles.css): cada tienda los tiñe con su color principal.
const tono = (variable, alfa) => `rgb(var(--${variable}) / ${alfa})`;
const trazo = (variable, alfa, relleno = "none") => ({ stroke: tono(variable, alfa), fill: relleno });

function Farmacia({ x, y, s }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} strokeWidth={1.4 / s}>
      <rect x="0" y="22" width="80" height="58" rx="3" style={trazo("ilus-linea", 0.55, tono("ilus-linea", 0.07))} />
      <path d="M-5 22 3 6h74l8 16z" style={trazo("ilus-linea", 0.55, tono("ilus-linea", 0.1))} />
      <path d="M-5 22q5.6 7 11.2 0t11.2 0 11.2 0 11.2 0 11.2 0 11.2 0 11.2 0 11.2 0" style={trazo("ilus-linea", 0.45)} />
      <rect x="10" y="44" width="22" height="36" rx="1.5" style={trazo("ilus-linea", 0.45)} />
      <rect x="42" y="42" width="28" height="18" rx="1.5" style={trazo("ilus-linea", 0.45, tono("ilus-linea", 0.06))} />
      <circle cx="40" cy="-6" r="10" style={trazo("ilus-linea", 0.6, tono("ilus-cruz", 0.55))} />
      <path d="M38.2-11.5h3.6v3.7h3.7v3.6h-3.7v3.7h-3.6v-3.7h-3.7v-3.6h3.7z" fill="rgb(255 255 255 / 0.85)" stroke="none" />
      <line x1="40" y1="4" x2="40" y2="6" style={trazo("ilus-linea", 0.55)} />
    </g>
  );
}

function RedDeFarmacias({ variante, className }) {
  const { tiendas, nodos, enlaces } = ESQUINAS[variante];
  return (
    <svg viewBox="0 0 460 340" className={className} aria-hidden="true" focusable="false">
      {enlaces.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="red-enlace" style={{ stroke: tono("ilus-nodo", 0.45) }} strokeWidth="1.3" strokeLinecap="round" />
      ))}
      {nodos.map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="11" className="red-nodo-halo" style={{ fill: tono("ilus-nodo", 0.15), animationDelay: `${i * 0.6}s` }} />
          <circle cx={cx} cy={cy} r="4.5" style={{ fill: tono("ilus-nodo", 0.7) }} />
        </g>
      ))}
      {tiendas.map((t, i) => (
        <Farmacia key={i} {...t} />
      ))}
    </svg>
  );
}

function CampoLogin({ id, etiqueta, icono, extra, children }) {
  return (
    <div className="mt-5 bajo:mt-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="m-0 text-[13.5px]">{etiqueta}</label>
        {extra}
      </div>
      <div className="relative mt-1.5">
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-tenue">
          <Icono nombre={icono} tamano={18} />
        </span>
        {children}
      </div>
    </div>
  );
}

function PortadaLogin({ estado, ultimaSync, tienda, simulacionActiva, children, herramientas }) {
  // Mientras se ve el login (o el restablecimiento), <html> lleva la clase login-activo: en el celular la página se
  // desplaza sin barra visible. Al entrar al panel la clase se quita y el panel no cambia.
  useEffect(() => {
    document.documentElement.classList.add("login-activo");
    return () => document.documentElement.classList.remove("login-activo");
  }, []);
  return (
    // Escritorio (md+): ocupa exactamente la pantalla, sin desplazamiento. Celular: la página fluye y se desplaza con normalidad.
    <div className="login-fondo relative flex min-h-dvh flex-col overflow-clip text-white md:h-dvh md:overflow-hidden">
      <RedDeFarmacias variante="inferior" className="pointer-events-none absolute -bottom-6 -left-10 w-[300px] opacity-50 sm:w-[400px] sm:opacity-100 lg:w-[480px]" />
      <RedDeFarmacias variante="superior" className="pointer-events-none absolute -right-8 top-10 hidden w-[340px] md:block lg:w-[460px]" />

      <header className="relative z-10 flex shrink-0 items-center justify-between gap-4 px-5 py-3 sm:px-8 sm:py-4">
        <div className="flex items-center gap-2.5">
          <Marca tamano={32} />
          <span className="text-[17px] font-semibold tracking-tight">FarmaHub</span>
          <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-white/70">{tienda?.nombre || "Red de farmacias"}</span>
        </div>
        <span className="hidden items-center gap-2 text-[13px] text-white/75 sm:flex">
          <span className={`h-1.5 w-1.5 rounded-full ${estado === "online" ? "bg-[var(--punto-en-linea)]" : estado === "degradado" ? "bg-[#e5c07b]" : "bg-[#e79a8f]"}`} aria-hidden="true" />
          Nodo central: {ESTADO_TEXTO[estado] || estado}
        </span>
      </header>

      {/* En escritorio, si la ventana fuera extremadamente baja, el formulario se desplaza aquí dentro (sin barra) y la página no. */}
      <main className="sin-barra relative z-10 flex flex-1 items-start justify-center px-4 pb-10 pt-[4vh] md:min-h-0 md:items-center md:overflow-y-auto md:py-4">
        <div className="w-full max-w-[500px]">
          <div className="overflow-hidden rounded-2xl bg-superficie text-tinta shadow-flotante">
            <div className="px-6 py-7 sm:px-10 sm:py-9 bajo:py-6">{children}</div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-linea bg-suave px-6 py-3.5 text-[13px] text-tenue sm:px-10">
              <span className={`pill ${estado}`}>{ESTADO_TEXTO[estado] || estado}{simulacionActiva ? " (simulado)" : ""}</span>
              <span className="inline-flex items-center gap-1.5">
                <Icono nombre="reloj" tamano={15} />
                Última sincronización: {hora(ultimaSync)}
              </span>
              {simulacionActiva && (
                <p className="m-0 w-full text-[12.5px] text-aviso">
                  Demostración en curso: «{simulacionActiva.titulo}», iniciada por {simulacionActiva.por}. No es una falla real.
                </p>
              )}
            </div>
          </div>
          {herramientas}
        </div>
      </main>

      <footer className="relative z-10 shrink-0 px-5 pb-5 md:pb-4 bajo:pb-3 text-center text-[12px] text-white/50 sm:px-8 sm:text-right">
        FarmaHub · Gestión de la franquicia de farmacias<span className="hidden sm:inline"> · Sistemas distribuidos y transaccionales</span>
      </footer>
    </div>
  );
}

function Login({ estado, simulacionActiva, tienda, ultimaSync, onEnter }) {
  const cuentas = cuentasDe(tienda?.id);
  const [nodo, setNodo] = useState("local");
  const [usuario, setUsuario] = useState(cuentas[0].usuario);
  // Al conocer la tienda del nodo, el usuario sugerido pasa a su cajero (solo si sigue el sugerido de otra tienda).
  useEffect(() => {
    setUsuario((actual) => (CAJEROS_DEMO.has(actual) ? cuentasDe(tienda?.id)[0].usuario : actual));
  }, [tienda?.id]);
  const [password, setPassword] = useState("Farma123");
  const [verPassword, setVerPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [restablecer, setRestablecer] = useState(false);
  const [aviso, setAviso] = useState("");
  const panelDemo = useCerrarFuera();

  if (restablecer) {
    return (
      <PortadaLogin estado={estado} ultimaSync={ultimaSync} tienda={tienda}>
        <Restablecer
          nodo={nodo}
          usuarioInicial={usuario}
          onVolver={(listo, usuarioNuevo) => {
            setRestablecer(false);
            if (listo) {
              setUsuario(usuarioNuevo);
              setPassword("");
              setError("");
              setAviso(listo);
            }
          }}
        />
      </PortadaLogin>
    );
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

  const herramientas = (
    <details ref={panelDemo} className="group relative mt-3 rounded-xl border border-white/12 bg-white/[0.04] text-[13px] text-white/80">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 hover:bg-white/[0.04]">
        <span className="inline-flex items-center gap-2">
          <Icono nombre="ajustes" tamano={16} />
          Cuentas de demostración
        </span>
        <Icono nombre="chevron" tamano={16} className="transition-transform group-open:rotate-90" />
      </summary>
      {/* Escritorio: se abre hacia arriba, sobre el fondo, sin crear desplazamiento. Celular: se abre debajo y la página se desplaza. */}
      <div className="z-20 grid gap-4 rounded-b-xl border-t border-white/12 p-4 md:absolute md:inset-x-0 md:bottom-full md:mb-2 md:rounded-xl md:border md:bg-marca-2 md:shadow-flotante">
        <div>
          <p className="m-0 mb-2 text-white/60">Contraseña de prueba: Farma123</p>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {cuentas.map((cuenta) => (
              <button
                type="button"
                key={cuenta.usuario}
                className="min-h-11 rounded-lg border border-white/12 bg-white/[0.06] px-3 py-2 text-left text-white hover:bg-white/[0.12]"
                onClick={() => {
                  setUsuario(cuenta.usuario);
                  setPassword(cuenta.password);
                  setNodo(cuenta.nodo);
                  setKey(crypto.randomUUID());
                  if (panelDemo.current) panelDemo.current.open = false;
                }}
              >
                <span className="block font-medium">{cuenta.rol}</span>
                <span className="block text-[12px] text-white/60">{cuenta.usuario}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </details>
  );

  return (
    <PortadaLogin estado={estado} ultimaSync={ultimaSync} tienda={tienda} simulacionActiva={simulacionActiva} herramientas={herramientas}>
      <form onSubmit={submit} noValidate={false}>
        <h1 className="m-0 text-[26px] font-semibold tracking-tight">Iniciar sesión</h1>
        <p className="m-0 mt-1 text-tenue">Gestión de la red de farmacias</p>

        <fieldset className="m-0 mt-6 border-0 p-0 bajo:mt-4">
          <legend className="mb-1.5 p-0 text-[13.5px] font-[550]">Acceso</legend>
          <div className="segmentado grid grid-cols-2 gap-1 rounded-xl border border-linea bg-hundido p-1">
            {["local", "central"].map((valor) => (
              <label key={valor} className="m-0 cursor-pointer font-normal">
                <input type="radio" name="nodo" value={valor} checked={nodo === valor} onChange={() => setNodo(valor)} className="peer sr-only" />
                <span className="flex min-h-10 items-center justify-center rounded-lg px-3 text-center text-[14px] font-medium text-primario-texto transition-colors peer-not-checked:hover:bg-superficie peer-not-checked:hover:text-tinta peer-checked:cursor-default peer-checked:bg-primario peer-checked:text-white peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primario">
                  {NODO_TEXTO[valor]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <CampoLogin id="login-usuario" etiqueta="Usuario" icono="usuario">
          <input
            id="login-usuario"
            className="!min-h-12 !pl-11"
            value={usuario}
            onChange={(event) => setUsuario(event.target.value)}
            autoComplete="username"
            required
          />
        </CampoLogin>

        <CampoLogin id="login-password" etiqueta="Contraseña" icono="candado">
          <input
            id="login-password"
            className="!min-h-12 !pl-11 !pr-12"
            type={verPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          <button
            type="button"
            className="absolute inset-y-0 right-1 my-1 grid w-10 place-items-center rounded-lg text-tenue hover:bg-suave hover:text-tinta"
            onClick={() => setVerPassword((v) => !v)}
            aria-label={verPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            aria-pressed={verPassword}
          >
            <Icono nombre={verPassword ? "ojoCerrado" : "ojo"} tamano={18} />
          </button>
        </CampoLogin>

        <button className="primary mt-7 bajo:mt-5 !min-h-12 w-full text-[15px]" disabled={busy}>
          {busy ? "Entrando…" : <>Entrar <Icono nombre="flecha" tamano={18} /></>}
        </button>
        {error && <div className="error" role="alert">{error}</div>}
        {aviso && <div className="ok" role="status">{aviso}</div>}

        <div className="mt-5 bajo:mt-4 text-center">
          <button type="button" className="enlace text-[14px]" onClick={() => setRestablecer(true)}>
            ¿Tiene un código? Restablecer contraseña
          </button>
        </div>
      </form>
    </PortadaLogin>
  );
}

/* ====================================================================== Panel */

const CLAVE_MENU = "farmahub:menu-contraido";

function Shell({ session, catalogo, estado, forzado, simulacion, simulacionActiva, ultimaSync, onSalir }) {
  const puedeSimular = simulacion && esAdministrador(session);
  const visibles = useMemo(() => {
    const modulos = session.permisos
      .filter((codigo) => catalogo[codigo])
      .filter((codigo) => AMBITO[codigo] === "ambos" || AMBITO[codigo] === (session.nodo === "central" ? "red" : "tienda"))
      .map((codigo) => ({ codigo, ...catalogo[codigo] }));
    return puedeSimular && modulos.length ? [...modulos, MODULO_CONECTIVIDAD] : modulos;
  }, [session, catalogo, puedeSimular]);
  // Secciones del menú con sus módulos visibles, en el orden de SECCIONES; lo que no esté listado va al final.
  const secciones = useMemo(() => {
    const listados = new Set(SECCIONES.flatMap((x) => x.codigos));
    const grupos = SECCIONES.map((x) => ({ titulo: x.titulo, modulos: x.codigos.map((c) => visibles.find((m) => m.codigo === c)).filter(Boolean) }));
    grupos.push({ titulo: "Otros", modulos: visibles.filter((m) => !listados.has(m.codigo)) });
    return grupos.filter((x) => x.modulos.length);
  }, [visibles]);
  const [activo, setActivo] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState("");
  // Menú lateral: contraído o desplegado se recuerda en este navegador; en pantallas medianas arranca contraído.
  const [contraido, setContraido] = useState(() => leerPreferencia(CLAVE_MENU, typeof window !== "undefined" && window.innerWidth < 1100));
  const [menuMovil, setMenuMovil] = useState(false);
  // HU-04: indicador de alertas. En el POS (nodo local) se consulta cada 30 s; no depende del central.
  const [alertas, setAlertas] = useState(null);
  const [pedido, setPedido] = useState(null);
  const verAlertas = session.nodo === "local" && session.permisos.includes("INVENTARIO_CONSULTAR");
  useEffect(() => {
    if (!verAlertas) return undefined;
    let vivo = true;
    const consultar = () => api("/api/local/alertas/resumen", { token: session.token }).then((r) => vivo && r.ok && setAlertas(r.data));
    consultar();
    const timer = setInterval(consultar, 30000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [verAlertas, session.token]);

  useEffect(() => {
    if (!menuMovil) return undefined;
    const alTeclear = (event) => event.key === "Escape" && setMenuMovil(false);
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [menuMovil]);

  const Pantalla = detalle?.codigo === CONECTIVIDAD ? Conectividad : PANTALLAS[session.nodo]?.[detalle?.codigo];
  const moduloActivo = visibles.find((m) => m.codigo === activo);

  function alternarMenu() {
    setContraido((valor) => {
      guardarPreferencia(CLAVE_MENU, !valor);
      return !valor;
    });
  }

  function inicio() {
    setActivo(null);
    setDetalle(null);
    setError("");
    setMenuMovil(false);
  }

  async function abrir(codigo) {
    setActivo(codigo);
    setError("");
    setMenuMovil(false);
    if (codigo === CONECTIVIDAD) return setDetalle(MODULO_CONECTIVIDAD);
    const result = await api(`/api/${session.nodo}/modulos/${codigo}`, { token: session.token });
    if (!result.ok) {
      setDetalle(null);
      setError(result.data.mensaje || "Acceso rechazado");
      return;
    }
    setDetalle(result.data);
  }

  // Al entrar, cada rol abre su pantalla principal (una sola vez; después manda lo que elija).
  const abrioInicial = useRef(false);
  useEffect(() => {
    if (abrioInicial.current || visibles.length === 0) return;
    abrioInicial.current = true;
    const inicial = moduloInicial(session, visibles);
    if (inicial) abrir(inicial);
  }, [visibles]);

  const urgentes = alertas?.urgentes_sin_ver || 0;
  const textoAlertas = alertas
    ? urgentes > 0
      ? `${urgentes} urgente${urgentes === 1 ? "" : "s"}`
      : `${alertas.total} alerta${alertas.total === 1 ? "" : "s"}`
    : "";
  // Abrir otro módulo con datos (p. ej. el historial manda una factura a Anulaciones).
  const irA = (codigo, datos = {}) => {
    setPedido({ ...datos, n: Date.now() });
    abrir(codigo);
  };
  // Desde el menú se abre el módulo limpio, sin el pedido de una navegación anterior.
  const abrirDesdeMenu = (codigo) => {
    setPedido(null);
    abrir(codigo);
  };
  const abrirAlertas = () => {
    setPedido({ pestana: "alertas", n: Date.now() });
    abrir("INVENTARIO_CONSULTAR");
  };

  // En móvil el menú es un cajón y siempre se muestra desplegado.
  const etiquetas = !contraido || menuMovil;

  return (
    <div className="app-shell flex h-dvh overflow-hidden bg-fondo">
      <Avisos />
      <a href="#contenido" className="sr-only z-50 rounded-lg bg-superficie px-4 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Saltar al contenido
      </a>

      {menuMovil && <div className="fixed inset-0 z-30 bg-marca/45 md:hidden" onClick={() => setMenuMovil(false)} aria-hidden="true" />}

      <aside
        id="menu-lateral"
        aria-label="Menú principal"
        className={`app-lateral fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-linea bg-superficie transition-[transform,width] duration-200 md:static md:z-auto md:translate-x-0 ${
          menuMovil ? "translate-x-0 shadow-flotante" : "-translate-x-full"
        } ${contraido ? "md:w-[76px]" : "md:w-64"}`}
      >
        <div className={`flex h-[68px] shrink-0 items-center gap-2.5 border-b border-linea ${etiquetas ? "pl-4 pr-3" : "justify-center px-2"}`}>
          {etiquetas ? (
            <Marca tamano={34} />
          ) : (
            // Contraído: el logo es el botón para expandir; al pasar el mouse o enfocarlo muestra el ícono del panel.
            <button
              type="button"
              onClick={alternarMenu}
              aria-expanded={false}
              aria-controls="menu-lateral"
              aria-label="Expandir menú"
              title="Expandir menú"
              className="group relative grid h-10 w-10 place-items-center rounded-[10px]"
            >
              <Marca tamano={34} className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
              <span className="absolute inset-0 grid place-items-center rounded-[10px] border border-linea bg-suave text-tinta opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">
                <Icono nombre="panelAbrir" tamano={19} />
              </span>
            </button>
          )}
          {etiquetas && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[15px] font-semibold">FarmaHub</div>
              <div className="truncate text-[11.5px] uppercase tracking-wider text-tenue">{NODO_TEXTO[session.nodo]}</div>
            </div>
          )}
          {etiquetas && (
            <button
              type="button"
              onClick={alternarMenu}
              aria-expanded={true}
              aria-controls="menu-lateral"
              aria-label="Contraer menú"
              title="Contraer menú"
              className="hidden h-9 w-9 shrink-0 place-items-center rounded-lg text-tenue hover:bg-suave hover:text-tinta md:grid"
            >
              <Icono nombre="panelCerrar" tamano={19} />
            </button>
          )}
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg text-tenue hover:bg-suave hover:text-tinta md:hidden"
            onClick={() => setMenuMovil(false)}
            aria-label="Cerrar menú"
          >
            <Icono nombre="cerrar" tamano={18} />
          </button>
        </div>

        <nav className="sin-barra flex-1 overflow-y-auto px-3 py-5" aria-label="Módulos">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            <ElementoMenu icono="inicio" texto="Inicio" activo={!activo} etiquetas={etiquetas} onClick={inicio} />
          </ul>
          {secciones.map((seccion) => (
            <div key={seccion.titulo} role="group" aria-label={seccion.titulo} className="mt-5">
              {etiquetas ? (
                <p className="m-0 mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-tenue">{seccion.titulo}</p>
              ) : (
                <hr className="mx-3 mb-3 border-0 border-t border-linea" aria-hidden="true" />
              )}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {seccion.modulos.map((modulo) => (
                  <ElementoMenu
                    key={modulo.codigo}
                    icono={modulo.codigo === CONECTIVIDAD ? "red" : ICONO_MODULO[modulo.codigo]}
                    texto={modulo.titulo}
                    activo={activo === modulo.codigo}
                    etiquetas={etiquetas}
                    limitado={estado === "offline" ? (session.nodo === "central" ? "No disponible sin conexión" : SIN_CENTRAL[modulo.codigo]?.texto) : null}
                    onClick={() => abrirDesdeMenu(modulo.codigo)}
                  />
                ))}
              </ul>
            </div>
          ))}
          {Object.keys(catalogo).length === 0 && etiquetas && <p className="mt-4 px-3 text-[13px] text-tenue">Cargando módulos…</p>}
          {Object.keys(catalogo).length > 0 && visibles.length === 0 && etiquetas && (
            <p className="mt-4 px-3 text-[13px] text-tenue">Este acceso no tiene módulos en este nodo.</p>
          )}
        </nav>

        <div className="shrink-0 border-t border-linea p-3">
          <div className={`flex items-center gap-2.5 rounded-xl bg-suave p-2 ${etiquetas ? "" : "flex-col"}`}>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primario-suave text-[13px] font-semibold text-primario-texto" aria-hidden="true">
              {iniciales(session.nombre)}
            </span>
            {etiquetas && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13.5px] font-semibold">{session.nombre}</div>
                <div className="truncate text-[12px] text-tenue">{session.rol_etiqueta}</div>
              </div>
            )}
            <button
              type="button"
              onClick={onSalir}
              title="Salir"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-tenue hover:bg-error-fondo hover:text-error"
            >
              <Icono nombre="salir" tamano={18} />
              <span className="sr-only">Salir</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="app-main flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="app-barra sticky top-0 z-20 flex min-h-[68px] shrink-0 items-center gap-3 border-b border-linea bg-fondo/90 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button
            type="button"
            className="grid h-10 w-10 place-items-center rounded-lg border border-linea-fuerte bg-superficie md:hidden"
            onClick={() => setMenuMovil(true)}
            aria-label="Abrir menú"
            aria-expanded={menuMovil}
            aria-controls="menu-lateral"
          >
            <Icono nombre="menu" tamano={20} />
          </button>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[15px] font-semibold">{lugarDe(session)}</div>
            <div className="truncate text-[12.5px] text-tenue">{moduloActivo ? moduloActivo.titulo : "Inicio"}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {alertas && alertas.total > 0 && (
              <button
                type="button"
                onClick={abrirAlertas}
                aria-label={`Ver alertas de stock y caducidad: ${textoAlertas}`}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium ${
                  urgentes > 0 ? "border-error-borde bg-error-fondo text-error" : "border-linea-fuerte bg-superficie text-tinta"
                }`}
              >
                <Icono nombre="campana" tamano={16} />
                <span className="hidden sm:inline">{textoAlertas}</span>
                <span className="sm:hidden">{urgentes || alertas.total}</span>
              </button>
            )}
            <span className={`pill ${estado} hidden sm:inline-flex`}>{ESTADO_TEXTO[estado] || estado}</span>
            {forzado && <span className={`pill ${forzado} hidden lg:inline-flex`}>Forzado: {ESTADO_TEXTO[forzado] || forzado}</span>}
          </div>
        </header>

        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-[1360px] flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
          <section aria-label="Sesión" className="app-perfil mb-6 flex flex-col gap-5 rounded-2xl border border-linea bg-superficie p-5 shadow-tarjeta lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primario text-[16px] font-semibold text-white" aria-hidden="true">
                {iniciales(session.nombre)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[17px] font-semibold">{session.nombre}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-tenue">
                  <span className="badge">{session.rol_etiqueta}</span>
                  <span className="truncate">{lugarDe(session)}</span>
                </div>
              </div>
            </div>
            <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:flex lg:gap-10">
              <Dato titulo="Estado">
                <span className={`pill ${estado}`}>{ESTADO_TEXTO[estado] || estado}{simulacionActiva ? " (simulado)" : ""}</span>
              </Dato>
              <Dato titulo="Última sincronización">
                <span className="inline-flex items-center gap-1.5 font-semibold">
                  <Icono nombre="reloj" tamano={15} className="text-tenue" />
                  {hora(ultimaSync)}
                </span>
              </Dato>
              {verAlertas ? (
                <Dato titulo="Alertas">
                  {alertas && alertas.total > 0 ? (
                    <button type="button" onClick={abrirAlertas} className={`pill ${urgentes > 0 ? "offline" : "media"} border-0`}>
                      {textoAlertas}
                    </button>
                  ) : (
                    <span className="font-semibold">Sin alertas</span>
                  )}
                </Dato>
              ) : (
                <Dato titulo="Módulos">
                  <span className="font-semibold">{visibles.length}</span>
                </Dato>
              )}
            </dl>
          </section>

          {estado === "offline" && <AvisoSinConexion session={session} visibles={visibles} />}

          {simulacionActiva && (
            <AvisoSimulacion
              simulacion={simulacionActiva}
              puedeGestionar={puedeSimular && activo !== CONECTIVIDAD}
              onAbrir={() => abrir(CONECTIVIDAD)}
            />
          )}

          {error && (
            <div className="error mb-4" role="alert">
              {error}
              {ultimaSync ? ` Última sincronización: ${new Date(ultimaSync).toLocaleString()}` : ""}
            </div>
          )}

          {!activo && session.nodo === "local" && esAdministrador(session) && (
            <Pendientes session={session} alertas={alertas} irA={irA} />
          )}

          {!activo && (
            <section aria-labelledby="titulo-inicio">
              <h2 id="titulo-inicio" className="m-0 mb-1">Sus módulos</h2>
              <p className="m-0 mb-5 text-tenue">Elija un módulo para empezar. Solo se muestran los que permite su rol en este nodo.</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                {visibles.map((modulo) => (
                  <button
                    key={modulo.codigo}
                    type="button"
                    onClick={() => abrirDesdeMenu(modulo.codigo)}
                    className="group flex flex-col items-start gap-3 rounded-2xl border border-linea bg-superficie p-5 text-left shadow-tarjeta transition-colors hover:border-linea-fuerte"
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-primario-suave text-primario-texto">
                      <Icono nombre={ICONO_MODULO[modulo.codigo]} tamano={20} />
                    </span>
                    <span className="text-[15px] font-semibold">{modulo.titulo}</span>
                    <span className="text-[13.5px] text-tenue">{modulo.texto}</span>
                    <span className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-primario-texto">
                      Abrir <Icono nombre="flecha" tamano={15} className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {detalle && Pantalla && <Pantalla key={detalle.codigo} session={session} ultimaSync={ultimaSync} pedido={pedido} estado={estado} irA={irA} />}
          {detalle && !Pantalla && (
            <article className="module">
              <h2>{detalle.titulo}</h2>
              <p>{detalle.texto}</p>
              <p className="muted">{detalle.tienda} · {detalle.rol}</p>
              <code>{detalle.codigo}</code>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}

// limitado: texto de lo que no funciona sin conexión; se marca con un punto ámbar (con su texto para lectores de pantalla).
function ElementoMenu({ icono, texto, activo, etiquetas, onClick, limitado }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={activo ? "page" : undefined}
        title={limitado || (etiquetas ? undefined : texto)}
        className={`relative flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition-colors ${
          etiquetas ? "" : "justify-center"
        } ${activo ? "bg-primario-suave font-semibold text-primario-texto" : "text-tinta hover:bg-suave"}`}
      >
        {activo && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primario" aria-hidden="true" />}
        <Icono nombre={icono} tamano={19} className={activo ? "" : "text-tenue"} />
        {etiquetas ? <span className="truncate">{texto}</span> : <span className="sr-only">{texto}</span>}
        {limitado && (
          <>
            <span className={`h-2 w-2 shrink-0 rounded-full bg-grafico-aviso ${etiquetas ? "ml-auto" : "absolute right-2 top-2"}`} aria-hidden="true" />
            <span className="sr-only">. {limitado}</span>
          </>
        )}
      </button>
    </li>
  );
}

// Sin conexión con el central: qué sigue funcionando y qué no, para los módulos de este usuario.
function AvisoSinConexion({ session, visibles }) {
  const consola = session.nodo === "central";
  const limitados = consola ? [] : visibles.map((m) => SIN_CENTRAL[m.codigo]).filter(Boolean);
  return (
    <div className="mb-4 rounded-xl border border-error-borde border-l-[3px] border-l-error bg-error-fondo px-4 py-3 text-[14px] text-tinta" role="status">
      <p className="m-0 font-semibold text-error">Sin conexión con el nodo central.</p>
      {consola ? (
        <p className="m-0 mt-1">La consola de red trabaja con los datos del central: hasta que vuelva la conexión no se pueden consultar ni modificar.</p>
      ) : (
        <>
          <p className="m-0 mt-1">
            La tienda sigue operando con su propia base: lo que registre se guarda y se envía solo al volver la conexión.
            {limitados.length > 0 ? " Mientras tanto:" : ""}
          </p>
          {limitados.length > 0 && (
            <ul className="m-0 mt-1.5 grid gap-0.5 pl-5">
              {limitados.map((l) => (
                <li key={l.texto}>{l.texto}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Dato({ titulo, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-tenue">{titulo}</dt>
      <dd className="m-0 mt-1 text-[14px]">{children}</dd>
    </div>
  );
}

/* ====================================================================== Restablecer */

// HU-07: canje del código de un solo uso. Va al central (por el nodo elegido): sin conexión responde 503.
// La clave de idempotencia se conserva hasta tener respuesta, para que un reintento no gaste un intento más.
function Restablecer({ nodo, usuarioInicial, onVolver }) {
  const [usuario, setUsuario] = useState(usuarioInicial || "");
  const [codigo, setCodigo] = useState("");
  const [password, setPassword] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  async function enviar(event) {
    event.preventDefault();
    setError("");
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return setError("La contraseña debe tener al menos 8 caracteres y combinar letras y números");
    }
    if (password !== confirmar) return setError("Las contraseñas no coinciden");
    setBusy(true);
    try {
      const result = await api(`/api/${nodo}/auth/restablecer`, {
        method: "POST",
        body: { usuario: usuario.trim().toLowerCase(), codigo, password },
        key,
      });
      setKey(crypto.randomUUID());
      if (!result.ok) {
        setError(
          result.status === 503
            ? "Sin conexión con el nodo central. El restablecimiento necesita conexión; intente más tarde."
            : result.data.mensaje || "No se pudo restablecer la contraseña",
        );
        return;
      }
      onVolver("Contraseña actualizada. Ya puede entrar con ella (en su tienda, tras la próxima sincronización: unos segundos).", usuario.trim().toLowerCase());
    } catch {
      setError("No hay respuesta del servidor. Puede reintentar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={enviar}>
      <h1 className="m-0 text-[24px] font-semibold tracking-tight">Restablecer contraseña</h1>
      <p className="m-0 mt-1 text-tenue">
        Necesita el código de un solo uso que le entrega su administrador. Sirve una vez y vence; tras 5 intentos fallidos pida otro.
      </p>
      <label htmlFor="rest-usuario">Usuario</label>
      <input id="rest-usuario" value={usuario} onChange={(event) => setUsuario(event.target.value)} autoComplete="username" />
      <label htmlFor="rest-codigo">Código</label>
      <input id="rest-codigo" value={codigo} onChange={(event) => setCodigo(event.target.value)} placeholder="XXXX-XXXX" autoComplete="one-time-code" />
      <label htmlFor="rest-password">Contraseña nueva</label>
      <input id="rest-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
      <label htmlFor="rest-confirmar">Repetir contraseña</label>
      <input id="rest-confirmar" type="password" value={confirmar} onChange={(event) => setConfirmar(event.target.value)} autoComplete="new-password" />
      <button className="primary full !min-h-12" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="mt-5 text-center">
        <button type="button" className="enlace" onClick={() => onVolver(null)}>Volver a iniciar sesión</button>
      </div>
    </form>
  );
}
