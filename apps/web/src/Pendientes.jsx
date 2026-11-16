import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Icono } from "./iconos.jsx";
import { pesos } from "./inventarioUi.jsx";

// Inicio del administrador de tienda: lo que pide atención hoy, con la acción directa a cada proceso. Solo lee datos de la
// tienda (funciona sin conexión con el central) y cada tarjeta aparece según los permisos del rol.
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function Tarjeta({ icono, titulo, tono, cifra, detalle, accion, onAccion }) {
  const colores = {
    atencion: "border-l-aviso",
    urgente: "border-l-error",
    bien: "border-l-exito",
  };
  return (
    <div className={`flex flex-col gap-2 rounded-2xl border border-linea border-l-[3px] bg-superficie p-5 shadow-tarjeta ${colores[tono]}`}>
      <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-tenue">
        <Icono nombre={icono} tamano={17} />
        {titulo}
      </div>
      <div className="text-[20px] font-semibold leading-tight">{cifra}</div>
      {detalle && <div className="text-[13.5px] text-tenue">{detalle}</div>}
      {accion && (
        <div className="mt-auto pt-2">
          <button type="button" className={tono === "bien" ? "ghost" : "primary"} onClick={onAccion}>
            {accion}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Pendientes({ session, alertas, irA }) {
  const token = session.token;
  const puede = (permiso) => session.permisos.includes(permiso);
  const [caja, setCaja] = useState(null);
  const [resumenCaja, setResumenCaja] = useState(null);
  const [solicitudes, setSolicitudes] = useState(null);
  const [traslados, setTraslados] = useState(null);

  useEffect(() => {
    let vivo = true;
    const cargar = () => {
      if (puede("VENTA_REGISTRAR") || puede("CAJA_CERRAR")) api("/api/local/caja/estado", { token }).then((r) => vivo && r.ok && setCaja(r.data));
      if (puede("CAJA_CERRAR")) api("/api/local/caja/resumen", { token }).then((r) => vivo && r.ok && setResumenCaja(r.data.resumen ?? null));
      if (puede("PROVEEDOR_GESTIONAR")) api("/api/local/solicitudes", { token }).then((r) => vivo && r.ok && setSolicitudes(r.data.resumen ?? {}));
      if (puede("INVENTARIO_GESTIONAR")) api("/api/local/traslados", { token }).then((r) => vivo && r.ok && setTraslados(r.data.traslados ?? r.data ?? []));
    };
    cargar();
    const timer = setInterval(cargar, 30000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const tarjetas = [];

  if (caja) {
    tarjetas.push(
      caja.abierta ? (
        <Tarjeta
          key="caja"
          icono="cierre"
          titulo="Caja"
          tono="bien"
          cifra={resumenCaja ? pesos(resumenCaja.total_sistema) : "Abierta"}
          detalle={`Abierta${caja.abierta_en ? ` desde las ${hora(caja.abierta_en)}` : ""}${resumenCaja ? ` · ${plural(resumenCaja.facturas, "factura", "facturas")}` : ""}`}
          accion={puede("CAJA_CERRAR") ? "Cerrar caja" : null}
          onAccion={() => irA("CAJA_CERRAR")}
        />
      ) : (
        <Tarjeta
          key="caja"
          icono="cierre"
          titulo="Caja"
          tono="urgente"
          cifra="Cerrada"
          detalle="No se pueden registrar ventas hasta abrir un nuevo periodo."
          accion={puede("CAJA_CERRAR") ? "Abrir caja" : null}
          onAccion={() => irA("CAJA_CERRAR")}
        />
      ),
    );
  }

  if (alertas && puede("INVENTARIO_CONSULTAR")) {
    const urgentes = alertas.urgentes_sin_ver || 0;
    tarjetas.push(
      <Tarjeta
        key="alertas"
        icono="alerta"
        titulo="Alertas de stock y caducidad"
        tono={urgentes > 0 ? "urgente" : alertas.total > 0 ? "atencion" : "bien"}
        cifra={alertas.total > 0 ? plural(alertas.total, "alerta", "alertas") : "Sin alertas"}
        detalle={urgentes > 0 ? `${plural(urgentes, "urgente sin ver", "urgentes sin ver")}` : alertas.total > 0 ? "Ninguna urgente sin ver" : "El stock y las fechas están en orden"}
        accion={alertas.total > 0 ? "Revisar alertas" : null}
        onAccion={() => irA("INVENTARIO_CONSULTAR", { pestana: "alertas" })}
      />,
    );
  }

  if (solicitudes) {
    const porEnviar = solicitudes.PENDIENTE || 0;
    const porRecibir = (solicitudes.ENVIADA || 0) + (solicitudes.RECIBIDA_PARCIAL || 0);
    tarjetas.push(
      <Tarjeta
        key="solicitudes"
        icono="proveedores"
        titulo="Reabastecimiento"
        tono={porEnviar + porRecibir > 0 ? "atencion" : "bien"}
        cifra={porEnviar + porRecibir > 0 ? plural(porEnviar + porRecibir, "solicitud abierta", "solicitudes abiertas") : "Al día"}
        detalle={porEnviar + porRecibir > 0 ? `${porEnviar} por enviar al proveedor · ${porRecibir} por recibir` : "No hay pedidos a proveedores pendientes"}
        accion={porEnviar + porRecibir > 0 ? "Ver solicitudes" : null}
        onAccion={() => irA("PROVEEDOR_GESTIONAR")}
      />,
    );
  }

  if (Array.isArray(traslados)) {
    const enCurso = traslados.filter((t) => ["SOLICITADO", "EN_TRANSITO"].includes(t.estado_red));
    tarjetas.push(
      <Tarjeta
        key="traslados"
        icono="lotes"
        titulo="Traslados entre tiendas"
        tono={enCurso.length > 0 ? "atencion" : "bien"}
        cifra={enCurso.length > 0 ? plural(enCurso.length, "en curso", "en curso") : "Ninguno en curso"}
        detalle={enCurso.length > 0 ? "Se completan solos cuando la otra tienda confirma" : "No hay mercancía en camino"}
        accion={enCurso.length > 0 ? "Ver traslados" : null}
        onAccion={() => irA("INVENTARIO_GESTIONAR", { pestana: "traslados" })}
      />,
    );
  }

  if (tarjetas.length === 0) return null;
  return (
    <section aria-labelledby="titulo-pendientes" className="mb-8">
      <h2 id="titulo-pendientes" className="m-0 mb-1">Pendientes de hoy</h2>
      <p className="m-0 mb-4 text-tenue">Lo que pide atención en su tienda, con el acceso directo a cada proceso.</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">{tarjetas}</div>
    </section>
  );
}
