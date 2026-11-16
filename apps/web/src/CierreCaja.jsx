import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";
import { useEnvio } from "./abastecimientoUi.jsx";
import { Icono } from "./iconos.jsx";

// HU-11: cierre de caja (RF-07). Totaliza el periodo por método de pago y por empleado, lo compara con lo contado (efectivo,
// vouchers de tarjeta, comprobantes), exige justificación si algo no cuadra y deja el cierre inmutable. Con la caja cerrada no
// se vende hasta abrir un nuevo periodo. Todo es local: funciona sin conexión con el central.

const ETIQUETA_CONTEO = {
  EFECTIVO: "Efectivo contado",
  VOUCHERS: "Total de vouchers",
  COMPROBANTES: "Total de comprobantes",
};
const ESTADO_CIERRE = { CONCILIADO: ["disponible", "Conciliado"], CON_DIFERENCIA: ["bajo", "Con diferencia justificada"] };

// "12.345,6" o "12345.60" -> centavos; null si no es un monto válido con máximo dos decimales.
function aCentavos(texto) {
  const t = String(texto ?? "").trim().replace(",", ".");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return null;
  const [e, d = ""] = t.split(".");
  return Number(e) * 100 + Number(d.padEnd(2, "0"));
}
const centavos = (decimal) => Math.round(Number(decimal) * 100);

function mensajeError(r) {
  const { mensaje } = r.data || {};
  return mensaje || "No se pudo completar la operación";
}

export default function CierreCaja({ session }) {
  const [pestana, setPestana] = useState("cierre");
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Cierre de caja</h2>
        <p className="muted">
          El total vendido del periodo por método de pago y por empleado, comparado con lo contado. El cierre queda registrado y no se puede modificar.
        </p>
        <div className="pestanas" role="tablist">
          <button role="tab" aria-selected={pestana === "cierre"} className={pestana === "cierre" ? "active" : ""} onClick={() => setPestana("cierre")}>Cerrar caja</button>
          <button role="tab" aria-selected={pestana === "historial"} className={pestana === "historial" ? "active" : ""} onClick={() => setPestana("historial")}>Cierres anteriores</button>
        </div>
      </header>
      {pestana === "cierre" && <Cierre session={session} />}
      {pestana === "historial" && <Historial token={session.token} />}
    </article>
  );
}

// Pasos del cierre: cada uno pide una sola cosa (revisar, contar, confirmar) y al final se abre la nueva caja ahí mismo.
const PASOS = ["Revisar el periodo", "Contar", "Confirmar y cerrar", "Abrir nueva caja"];

function Pasos({ actual }) {
  return (
    <ol className="m-0 mb-5 mt-1 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4" aria-label="Pasos del cierre">
      {PASOS.map((titulo, i) => {
        const estado = i < actual ? "hecho" : i === actual ? "actual" : "pendiente";
        return (
          <li
            key={titulo}
            aria-current={estado === "actual" ? "step" : undefined}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[13.5px] ${
              estado === "actual" ? "border-primario bg-primario-suave font-semibold text-primario-texto" : estado === "hecho" ? "border-linea bg-suave text-tinta" : "border-linea text-tenue"
            }`}
          >
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
                estado === "pendiente" ? "border border-linea-fuerte" : "bg-primario text-white"
              }`}
              aria-hidden="true"
            >
              {estado === "hecho" ? <Icono nombre="check" tamano={14} trazo={2.2} /> : i + 1}
            </span>
            <span>
              {titulo}
              {estado === "hecho" && <span className="sr-only"> (hecho)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Cifra({ titulo, valor, nota }) {
  return (
    <div className="kpi">
      <span className="muted">{titulo}</span>
      <strong>{valor}</strong>
      {nota && <span className="muted">{nota}</span>}
    </div>
  );
}

function Cierre({ session }) {
  const token = session.token;
  const { enviar, ocupado } = useEnvio(token);
  const [datos, setDatos] = useState(null);
  const [paso, setPaso] = useState(0);
  const [contado, setContado] = useState({});
  const [justificacion, setJustificacion] = useState("");
  const [turno, setTurno] = useState("");
  const [error, setError] = useState("");
  const [cerrado, setCerrado] = useState(null);

  const cargar = useCallback(async () => {
    const r = await api("/api/local/caja/resumen", { token });
    if (r.ok) {
      setDatos(r.data);
      setError("");
    } else setError(mensajeError(r));
  }, [token]);
  useEffect(() => {
    cargar();
  }, [cargar]);

  const resumen = datos?.resumen;
  // Diferencia por método frente a lo contado: se compara cada método por separado (un sobrante no tapa un faltante).
  const diferenciaDe = (m) => {
    const c = aCentavos(contado[m.id_metodo_pago]);
    if (c == null) return null;
    return c - centavos(m.calculado);
  };
  const filas = resumen?.por_metodo ?? [];
  const conMovimiento = (m) => centavos(m.vendido) !== 0 || centavos(m.devuelto) !== 0;
  const hayDiferencia = filas.some((m) => {
    const d = diferenciaDe(m);
    return d != null && d !== 0;
  });
  const totalContado = filas.reduce((t, m) => t + (aCentavos(contado[m.id_metodo_pago]) ?? 0), 0);
  const etiquetaMetodo = (id) => filas.find((m) => m.id_metodo_pago === id)?.etiqueta ?? id;

  function irAConfirmar(event) {
    event.preventDefault();
    setError("");
    const faltan = filas.filter((m) => conMovimiento(m) && aCentavos(contado[m.id_metodo_pago]) == null);
    if (faltan.length > 0) return setError(`Registre lo contado de: ${faltan.map((m) => m.etiqueta).join(", ")}`);
    if (filas.some((m) => contado[m.id_metodo_pago] != null && contado[m.id_metodo_pago] !== "" && aCentavos(contado[m.id_metodo_pago]) == null)) {
      return setError("Cada monto contado debe ser un número con máximo dos decimales");
    }
    setPaso(2);
  }

  async function cerrar(event) {
    event.preventDefault();
    setError("");
    if (hayDiferencia && justificacion.trim().length < 10) return setError("Hay diferencias: escriba la justificación (mínimo 10 caracteres)");
    const r = await enviar("/api/local/caja/cierre", "POST", {
      contado: filas
        .filter((m) => aCentavos(contado[m.id_metodo_pago]) != null)
        .map((m) => ({ id_metodo_pago: m.id_metodo_pago, monto: String(contado[m.id_metodo_pago]).trim().replace(",", ".") })),
      turno: turno.trim() || undefined,
      justificacion: justificacion.trim() || undefined,
      firma: resumen.firma,
    });
    if (!r.ok) {
      // Hubo ventas mientras se contaba: se recalcula y se vuelve a contar con las cifras nuevas.
      if (r.data?.codigo === "RESUMEN_DESACTUALIZADO") {
        await cargar();
        setPaso(1);
      }
      return setError(mensajeError(r));
    }
    setCerrado(r.data);
    setContado({});
    setJustificacion("");
    setTurno("");
    setPaso(0);
    cargar();
  }

  async function abrir(event) {
    event.preventDefault();
    setError("");
    const r = await enviar("/api/local/caja/apertura", "POST", { turno: turno.trim() || undefined });
    if (!r.ok) return setError(mensajeError(r));
    setCerrado(null);
    setTurno("");
    setPaso(0);
    cargar();
  }

  if (!datos) return error ? <div className="error">{error}</div> : <p className="muted">Calculando el periodo…</p>;

  // Caja cerrada: último paso, abrir el nuevo periodo (con el resultado del cierre si se acaba de cerrar).
  if (!datos.abierta) {
    return (
      <div>
        <Pasos actual={3} />
        {cerrado && <ResultadoCierre cierre={cerrado} />}
        <form className="subform formulario" onSubmit={abrir}>
          <p>
            <strong>La caja está cerrada.</strong> No se pueden registrar ventas hasta abrir un nuevo periodo.
            {!cerrado && datos.ultimo_cierre
              ? ` Último cierre: n.º ${datos.ultimo_cierre.id_cierre}, ${fechaHora(datos.ultimo_cierre.fecha_hora_cierre)}, por ${datos.ultimo_cierre.cerro}.`
              : ""}
          </p>
          <label htmlFor="apertura-turno">Turno (opcional)</label>
          <input id="apertura-turno" placeholder="p. ej. Mañana" value={turno} onChange={(e) => setTurno(e.target.value)} maxLength={20} />
          <div className="row mt-3">
            <button className="primary" disabled={ocupado}>{ocupado ? "Abriendo…" : "Abrir nuevo periodo"}</button>
          </div>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  if (!resumen) return error ? <div className="error">{error}</div> : null;
  const periodo = `Periodo ${resumen.periodo}${resumen.abierta_en ? `, abierto el ${fechaHora(resumen.abierta_en)}` : " (desde la primera venta)"}`;

  return (
    <div>
      <Pasos actual={paso} />

      {paso === 0 && (
        <section aria-label="Revisar el periodo">
          <p className="muted m-0">{periodo}.</p>
          <div className="rep-kpis">
            <Cifra titulo="Total del sistema" valor={pesos(resumen.total_sistema)} nota="Vendido menos devuelto" />
            <Cifra titulo="Facturas" valor={resumen.facturas} />
            <Cifra titulo="Devoluciones" valor={resumen.notas} />
          </div>
          <h3>Por método de pago</h3>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead>
                <tr><th>Método</th><th className="num">Vendido</th><th className="num">Devuelto</th><th className="num">Debe haber</th></tr>
              </thead>
              <tbody>
                {filas.map((m) => (
                  <tr key={m.id_metodo_pago}>
                    <td>{m.etiqueta}</td>
                    <td className="num">{pesos(m.vendido)}</td>
                    <td className="num">{pesos(m.devuelto)}</td>
                    <td className="num"><strong>{pesos(m.calculado)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-6">Por empleado</h3>
          {resumen.por_empleado.length === 0 && <p className="muted">Todavía no hay ventas en este periodo.</p>}
          {resumen.por_empleado.length > 0 && (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr><th>Empleado</th><th className="num">Vendido</th><th className="num">Devuelto</th><th className="num">Neto</th><th>Por método</th></tr>
                </thead>
                <tbody>
                  {resumen.por_empleado.map((e) => (
                    <tr key={e.id_empleado}>
                      <td>{e.nombre}</td>
                      <td className="num">{pesos(e.vendido)}</td>
                      <td className="num">{pesos(e.devuelto)}</td>
                      <td className="num"><strong>{pesos(e.neto)}</strong></td>
                      <td className="muted">
                        {e.metodos.map((x) => `${etiquetaMetodo(x.id_metodo_pago)}: ${pesos(centavos(x.vendido) / 100 - centavos(x.devuelto) / 100)}`).join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row mt-5">
            <button type="button" className="primary" onClick={() => setPaso(1)}>Empezar a contar</button>
            <button type="button" className="ghost" onClick={cargar}>Recalcular</button>
          </div>
        </section>
      )}

      {paso === 1 && (
        <form className="formulario" onSubmit={irAConfirmar} aria-label="Contar">
          <p className="muted m-0">
            Cuente el dinero y los comprobantes de cada método y escriba el total. Al lado verá si cuadra con lo que debe haber.
          </p>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead>
                <tr><th>Método</th><th className="num">Debe haber</th><th>Contado</th><th>Resultado</th></tr>
              </thead>
              <tbody>
                {filas.map((m, i) => {
                  const dif = diferenciaDe(m);
                  return (
                    <tr key={m.id_metodo_pago}>
                      <td>{m.etiqueta}{!conMovimiento(m) && <div className="muted text-[12.5px]">Sin movimientos (opcional)</div>}</td>
                      <td className="num"><strong>{pesos(m.calculado)}</strong></td>
                      <td>
                        <input
                          autoFocus={i === 0}
                          inputMode="decimal"
                          placeholder={ETIQUETA_CONTEO[m.tipo_conteo]}
                          value={contado[m.id_metodo_pago] ?? ""}
                          onChange={(e) => setContado((c) => ({ ...c, [m.id_metodo_pago]: e.target.value }))}
                          aria-label={`${ETIQUETA_CONTEO[m.tipo_conteo]} (${m.etiqueta})`}
                        />
                      </td>
                      <td>
                        {dif == null ? <span className="muted">—</span> : dif === 0 ? <span className="pill disponible">Cuadra</span> : <span className="pill agotado">{dif > 0 ? "Sobran" : "Faltan"} {pesos(Math.abs(dif) / 100)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row mt-5">
            <button type="button" className="ghost" onClick={() => setPaso(0)}>← Volver</button>
            <button className="primary">Revisar el cierre</button>
          </div>
        </form>
      )}

      {paso === 2 && (
        <form className="formulario" onSubmit={cerrar} aria-label="Confirmar y cerrar">
          <div className="rep-kpis">
            <Cifra titulo="Debe haber" valor={pesos(resumen.total_sistema)} />
            <Cifra titulo="Contado" valor={pesos(totalContado / 100)} />
            <Cifra
              titulo="Resultado"
              valor={hayDiferencia ? "Con diferencias" : "Cuadra"}
              nota={hayDiferencia ? "Se compara cada método por separado" : "Todos los métodos cuadran"}
            />
          </div>
          {hayDiferencia && (
            <>
              <ul className="m-0 mb-2 grid list-none gap-1 p-0">
                {filas
                  .filter((m) => (diferenciaDe(m) ?? 0) !== 0)
                  .map((m) => {
                    const d = diferenciaDe(m);
                    return (
                      <li key={m.id_metodo_pago}>
                        <span className="pill agotado">{m.etiqueta}: {d > 0 ? "sobran" : "faltan"} {pesos(Math.abs(d) / 100)}</span>
                      </li>
                    );
                  })}
              </ul>
              <label htmlFor="cierre-justificacion">Justificación de la diferencia (obligatoria, mínimo 10 caracteres)</label>
              <textarea id="cierre-justificacion" rows={3} maxLength={300} value={justificacion} onChange={(e) => setJustificacion(e.target.value)} autoFocus />
            </>
          )}
          <label htmlFor="cierre-turno">Turno (opcional)</label>
          <input id="cierre-turno" value={turno} maxLength={20} onChange={(e) => setTurno(e.target.value)} />
          <p className="mb-0 mt-4 text-[14px]">
            Al cerrar, el cierre queda registrado y <strong>no se puede modificar</strong>, y no se podrá vender hasta abrir un nuevo periodo
            (el paso siguiente).
          </p>
          <div className="row mt-4">
            <button type="button" className="ghost" onClick={() => setPaso(1)}>← Volver a contar</button>
            <button className="primary" disabled={ocupado}>{ocupado ? "Cerrando…" : "Cerrar caja"}</button>
          </div>
        </form>
      )}

      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

function ResultadoCierre({ cierre }) {
  const [clase, etiqueta] = ESTADO_CIERRE[cierre.estado];
  return (
    <div className="ok">
      Cierre n.º {cierre.id_cierre} registrado: <span className={`pill ${clase}`}>{etiqueta}</span> · total del sistema {pesos(cierre.total_sistema)} · efectivo contado {pesos(cierre.total_efectivo_contado)} · vouchers {pesos(cierre.total_vouchers)}
      {centavos(cierre.diferencia) !== 0 ? ` · diferencia ${pesos(cierre.diferencia)}` : ""}. La caja quedó cerrada.
    </div>
  );
}

function Historial({ token }) {
  const [cierres, setCierres] = useState(null);
  const [abierto, setAbierto] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/local/caja/cierres", { token }).then((r) => (r.ok ? setCierres(r.data.cierres) : setError(mensajeError(r))));
  }, [token]);

  async function ver(id) {
    if (abierto === id) return setAbierto(null);
    setAbierto(id);
    setDetalle(null);
    const r = await api(`/api/local/caja/cierres/${id}`, { token });
    if (r.ok) setDetalle(r.data);
    else setError(mensajeError(r));
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {cierres && cierres.length === 0 && <div className="inv-vacio">Todavía no hay cierres de caja. El primero aparecerá aquí cuando cierre la caja en la pestaña «Cerrar caja».</div>}
      <ul className="inv-lista">
        {(cierres || []).map((k) => {
          const [clase, etiqueta] = ESTADO_CIERRE[k.estado];
          return (
            <li key={k.id_cierre} className="inv-item">
              <div className="inv-fila">
                <div>
                  <strong>Cierre {k.id_cierre}</strong> <span className={`pill ${clase}`}>{etiqueta}</span> · {fechaHora(k.fecha_hora_cierre)} · {k.cerro}
                  {k.turno ? ` · turno ${k.turno}` : ""}
                  <div className="muted">
                    Sistema {pesos(k.total_sistema)} · efectivo contado {pesos(k.total_efectivo_contado)} · vouchers {pesos(k.total_vouchers)}
                    {centavos(k.diferencia) !== 0 ? ` · diferencia ${pesos(k.diferencia)}` : ""}
                  </div>
                </div>
                <button className="ghost" onClick={() => ver(k.id_cierre)}>{abierto === k.id_cierre ? "Ocultar" : "Ver detalle"}</button>
              </div>
              {abierto === k.id_cierre && detalle && <DetalleCierre d={detalle} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DetalleCierre({ d }) {
  return (
    <div className="historial">
      {d.justificacion && <p><strong>Justificación:</strong> {d.justificacion}</p>}
      <div className="tabla-scroll">
        <table className="tabla">
          <thead>
            <tr><th>Método</th><th className="num">Vendido</th><th className="num">Devuelto</th><th className="num">Calculado</th><th className="num">Contado</th><th className="num">Diferencia</th></tr>
          </thead>
          <tbody>
            {d.por_metodo.map((m) => (
              <tr key={m.id_metodo_pago}>
                <td>{m.etiqueta}</td>
                <td className="num">{pesos(m.vendido)}</td>
                <td className="num">{pesos(m.devuelto)}</td>
                <td className="num">{pesos(m.calculado)}</td>
                <td className="num">{pesos(m.reportado)}</td>
                <td className="num">{centavos(m.diferencia) === 0 ? "—" : pesos(m.diferencia)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.por_empleado.length > 0 && (
        <ul className="lineas">
          {d.por_empleado.map((e) => (
            <li key={e.id_empleado}>
              {e.nombre}: {e.metodos.map((x) => `${d.por_metodo.find((m) => m.id_metodo_pago === x.id_metodo_pago)?.etiqueta ?? x.id_metodo_pago} ${pesos(x.vendido)}${centavos(x.devuelto) ? ` (devuelto ${pesos(x.devuelto)})` : ""}`).join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
