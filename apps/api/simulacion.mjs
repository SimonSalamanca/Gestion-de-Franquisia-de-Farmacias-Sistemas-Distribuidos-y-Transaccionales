import { local } from "./db.mjs";
import { config } from "./config.mjs";
import { link, conectividad, inyectarProbe, probeCentral, simulacionVigente } from "./sync.mjs";
import { auditar } from "./inventario/lotes.mjs";
import { ErrorNegocio } from "./errores.mjs";

// Demostración de conectividad: escenarios para mostrar cómo la tienda opera sin el central (HU-06, RNF de disponibilidad),
// cómo se corta y se recupera la comunicación y cómo la cola (outbox) se vacía al volver. Solo administradores, solo con
// FARMAHUB_SIMULACION habilitado (no en el despliegue). Afecta a toda la tienda: todos sus usuarios ven el aviso.
export const ESCENARIOS = {
  caido: {
    titulo: "Central caído",
    resumen: "La tienda pierde el contacto con el nodo central y sigue operando sola.",
    demuestra: "Operación autónoma: las ventas y movimientos se guardan en la tienda y esperan en cola hasta que vuelva el central.",
    funciona: ["Ventas, facturas y recetas ya registradas", "Inventario de esta tienda y alertas", "Anulaciones y cierre de caja"],
    no_funciona: ["Existencias de otras tiendas", "Empleados y restablecer contraseñas", "Vista y reportes de red, consola de red"],
    resultado: "timeout",
    inicial: 5,
    minutos: 30,
  },
  lento: {
    titulo: "Conexión lenta",
    resumen: "El central responde, pero tarda más de 3 segundos.",
    demuestra: "Modo degradado: todo sigue funcionando y sincronizando, con aviso de lentitud; no se confunde con una caída.",
    funciona: ["Todos los módulos", "Sincronización con el central (más lenta)"],
    no_funciona: [],
    resultado: "lento",
    inicial: 1,
    minutos: 10,
  },
  intermitente: {
    titulo: "Fallos intermitentes",
    resumen: "Cinco intentos seguidos sin respuesta y luego la red vuelve sola.",
    demuestra: "Corte automático: tras 5 fallos la tienda deja de insistir 30 segundos y después vuelve a intentar y se recupera.",
    funciona: ["Lo mismo que con el central caído, durante unos 30 segundos"],
    no_funciona: ["Lo que depende del central, hasta que se recupere"],
    resultado: "timeout",
    inicial: 5,
    minutos: 0,
  },
};

// Administradores: el mismo criterio que el acceso a datos personales (docs/seguridad/datos-personales.md).
export const PERMISO_ADMIN = "AUDITORIA_CONSULTAR";

function habilitada() {
  if (!config.simulacion) throw new ErrorNegocio(404, "NO_DISPONIBLE", "La demostración de conectividad no está habilitada en este servidor");
}

export async function estadoSimulacion() {
  habilitada();
  const cola = await local.query(
    `select count(*) filter (where estado = 'PENDIENTE')::int as pendientes,
            count(*) filter (where estado = 'ERROR')::int as con_error,
            min(creado_en) filter (where estado <> 'ENVIADO') as mas_antiguo
     from outbox_sync`,
  );
  return {
    escenarios: Object.entries(ESCENARIOS).map(([id, e]) => ({
      id,
      titulo: e.titulo,
      resumen: e.resumen,
      demuestra: e.demuestra,
      funciona: e.funciona,
      no_funciona: e.no_funciona,
      minutos: e.minutos,
    })),
    conectividad: conectividad(),
    cola: cola.rows[0],
  };
}

export async function iniciarSimulacion(sesion, escenario) {
  habilitada();
  const e = ESCENARIOS[escenario];
  if (!e) throw new ErrorNegocio(400, "ESCENARIO", "Escenario no válido");
  const ahora = Date.now();
  // Los escenarios sostenidos reemplazan cada chequeo hasta `hasta`. "Fallos intermitentes" no se sostiene (resultado null:
  // los chequeos vuelven a ser reales y la red se recupera sola); solo deja el aviso visible durante su ciclo (~35 s).
  link.simulacion = {
    escenario,
    titulo: e.titulo,
    resultado: e.minutos ? e.resultado : null,
    desde: new Date(ahora).toISOString(),
    hasta: ahora + (e.minutos ? e.minutos * 60000 : 35000),
    por: sesion.nombre_completo,
  };
  // Efecto inmediato por el mismo camino que una falla real; el ciclo de sync (10 s) lo sostiene mientras dure.
  link.failures = 0;
  inyectarProbe(e.resultado, e.inicial);
  await registrar(sesion, `Inició "${e.titulo}"${e.minutos ? ` por ${e.minutos} min` : ""}`);
  return estadoSimulacion();
}

export async function restablecerSimulacion(sesion) {
  habilitada();
  const habia = simulacionVigente();
  link.simulacion = null;
  link.failures = 0;
  link.openedUntil = 0;
  // Vuelve a consultar el central de verdad: el estado queda como esté la red real.
  await probeCentral();
  await registrar(sesion, habia ? `Restableció la normalidad (terminó "${habia.titulo}")` : "Restableció la normalidad");
  return estadoSimulacion();
}

async function registrar(sesion, detalle) {
  await auditar(local, sesion.id_empleado, "SIMULACION_CONECTIVIDAD", "conectividad", null, detalle).catch((error) =>
    console.error("auditoría de la simulación", error.message),
  );
}
