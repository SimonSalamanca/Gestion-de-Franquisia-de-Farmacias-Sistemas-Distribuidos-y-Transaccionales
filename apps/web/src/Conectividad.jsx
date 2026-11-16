import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { Icono } from "./iconos.jsx";
import { avisar } from "./avisos.jsx";

// Demostración de conectividad (solo administradores, solo con FARMAHUB_SIMULACION): escenarios guiados para mostrar cómo
// opera la tienda sin el nodo central y cómo se recupera la sincronización. API: apps/api/simulacion.mjs.
const ESTADO_TEXTO = { online: "En línea", degradado: "Conexión lenta", offline: "Sin conexión" };
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

function restante(hasta) {
  const ms = new Date(hasta).getTime() - Date.now();
  if (ms <= 0) return "terminando";
  const min = Math.floor(ms / 60000);
  const seg = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min} min ${seg} s` : `${seg} s`;
}

// Aviso para TODOS los usuarios de la tienda mientras hay una simulación: nadie debe confundirla con una falla real.
export function AvisoSimulacion({ simulacion, puedeGestionar, onAbrir }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-aviso-borde border-l-[3px] border-l-aviso bg-aviso-fondo px-4 py-3 text-[14px] text-aviso" role="status">
      <Icono nombre="alerta" tamano={18} />
      <p className="m-0 min-w-0 flex-1">
        <strong>Demostración en curso: «{simulacion.titulo}».</strong> La inició {simulacion.por} a las {hora(simulacion.desde)} y termina a las{" "}
        {hora(simulacion.hasta)}. La tienda se comporta como si fallara la conexión con el central; no es una falla real.
      </p>
      {puedeGestionar && (
        <button type="button" className="ghost !min-h-9" onClick={onAbrir}>
          Ir a Conectividad
        </button>
      )}
    </div>
  );
}

function Dato({ titulo, children, nota }) {
  return (
    <div className="min-w-0 rounded-xl border border-linea bg-suave px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-tenue">{titulo}</div>
      <div className="mt-1 text-[15px] font-semibold">{children}</div>
      {nota && <div className="mt-0.5 text-[12.5px] text-tenue">{nota}</div>}
    </div>
  );
}

function Lista({ titulo, items, tono }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-tenue">{titulo}</div>
      <ul className="m-0 grid list-none gap-1 p-0 text-[13.5px]">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tono}`} aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Conectividad({ session }) {
  const base = `/api/${session.nodo}/simulacion`;
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(null);
  const [, setReloj] = useState(0);

  const cargar = useCallback(async () => {
    const r = await api(base, { token: session.token }).catch(() => null);
    if (!r) return setError("No hay respuesta del servidor.");
    if (!r.ok) return setError(r.data.mensaje || "No se pudo consultar la conectividad");
    setError("");
    setDatos(r.data);
  }, [base, session.token]);

  // Estado en vivo: se actualiza cada 3 s (la cola y el estado cambian con el ciclo de sincronización de 10 s).
  useEffect(() => {
    cargar();
    const t = setInterval(() => {
      cargar();
      setReloj((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [cargar]);

  async function enviar(cuerpo, etiqueta) {
    setOcupado(etiqueta);
    const r = await api(base, { method: "POST", token: session.token, body: cuerpo }).catch(() => null);
    setOcupado(null);
    if (!r) return setError("No hay respuesta del servidor.");
    if (!r.ok) return setError(r.data.mensaje || "No se pudo completar la acción");
    setError("");
    setDatos(r.data);
    const activa = r.data.conectividad?.simulacion_activa;
    avisar(cuerpo.restablecer ? "Normalidad restablecida: la tienda vuelve a la conexión real." : `Escenario «${activa?.titulo ?? "de conectividad"}» iniciado.`);
  }

  const c = datos?.conectividad;
  const activa = c?.simulacion_activa;
  const cola = datos?.cola;

  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Conectividad</h2>
        <p className="muted">
          Pruebe cómo responde esta tienda cuando falla la conexión con el nodo central y cómo se pone al día después. Afecta a
          toda la tienda: sus usuarios verán un aviso de demostración. Cada inicio y cada restablecimiento queda en la auditoría.
        </p>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {c && (
        <section aria-label="Estado en vivo" className="mt-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Dato titulo="Conexión con el central" nota={c.breaker_abierto ? "Corte automático: reintenta en menos de 30 s" : `Último chequeo: ${ESTADO_TEXTO[c.ultimo_probe] || c.ultimo_probe || "—"}`}>
              <span className={`pill ${c.estado_real}`}>{ESTADO_TEXTO[c.estado_real] || c.estado_real}</span>
            </Dato>
            <Dato titulo="Simulación" nota={activa ? `Termina en ${restante(activa.hasta)}` : "La conexión es la real"}>
              {activa ? activa.titulo : "Ninguna"}
            </Dato>
            <Dato
              titulo="Cambios en cola"
              nota={cola?.pendientes ? `Esperan para subir al central desde las ${hora(cola.mas_antiguo)}` : "Todo lo de la tienda ya está en el central"}
            >
              {cola?.pendientes ?? "—"}
              {cola?.con_error ? <span className="ml-2 text-[13px] font-normal text-error">({cola.con_error} con error)</span> : null}
            </Dato>
            <Dato titulo="Última sincronización">{hora(c.ultima_sync)}</Dato>
          </div>

          {activa && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-linea bg-superficie px-4 py-3">
              <p className="m-0 min-w-0 flex-1 text-[14px]">
                <strong>«{activa.titulo}»</strong> está activa. Restablezca para volver a la conexión real: la cola se envía sola en
                el siguiente ciclo (unos 10 s).
              </p>
              <button type="button" className="primary" disabled={Boolean(ocupado)} onClick={() => enviar({ restablecer: true }, "restablecer")}>
                {ocupado === "restablecer" ? "Restableciendo…" : "Restablecer normalidad"}
              </button>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="titulo-escenarios" className="mt-7">
        <h3 id="titulo-escenarios" className="m-0 mb-1">Escenarios</h3>
        <p className="m-0 mb-4 text-[14px] text-tenue">
          {activa ? "Para iniciar otro escenario, restablezca primero la normalidad." : "Elija qué quiere demostrar. Cada escenario termina solo o al restablecer."}
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          {(datos?.escenarios || []).map((e) => {
            const enCurso = activa?.escenario === e.id;
            return (
              <div
                key={e.id}
                className={`flex flex-col gap-3 rounded-2xl border p-5 ${enCurso ? "border-primario bg-primario-suave/40" : "border-linea bg-superficie"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="m-0 text-[16px]">{e.titulo}</h4>
                  <span className="pill media whitespace-nowrap">{e.minutos ? `${e.minutos} min` : "≈ 30 s"}</span>
                </div>
                <p className="m-0 text-[14px]">{e.resumen}</p>
                <p className="m-0 text-[13.5px] text-tenue">
                  <strong className="font-semibold text-tinta">Demuestra:</strong> {e.demuestra}
                </p>
                <Lista titulo="Sigue funcionando" items={e.funciona} tono="bg-exito" />
                <Lista titulo="No disponible" items={e.no_funciona} tono="bg-error" />
                <div className="mt-auto pt-1">
                  {enCurso ? (
                    <span className="pill online">En curso</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost w-full"
                      disabled={Boolean(activa) || Boolean(ocupado)}
                      onClick={() => enviar({ escenario: e.id }, e.id)}
                    >
                      {ocupado === e.id ? "Iniciando…" : `Iniciar «${e.titulo}»`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="titulo-guia" className="mt-7 rounded-xl border border-linea bg-suave p-5">
        <h3 id="titulo-guia" className="m-0 mb-2">Cómo demostrarlo en 1 minuto</h3>
        <ol className="m-0 grid gap-1.5 pl-5 text-[14px]">
          <li>Inicie «Central caído». La conexión pasa a «Sin conexión».</li>
          <li>Registre una venta en «Ventas y recetas»: se factura igual, sin el central.</li>
          <li>Vuelva aquí: «Cambios en cola» subió, porque la venta espera para llegar al central.</li>
          <li>Pulse «Restablecer normalidad»: en unos segundos la cola baja a 0 y la red ve la venta.</li>
        </ol>
      </section>
    </article>
  );
}
