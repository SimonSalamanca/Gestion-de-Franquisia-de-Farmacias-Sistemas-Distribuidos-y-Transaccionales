// Íconos de línea propios (trazo 1.6, 24×24). Son decorativos: el texto o el aria-label del control da el significado.
const TRAZOS = {
  inicio: "M3 10.5 12 3l9 7.5M5.5 9v11h13V9M10 20v-6h4v6",
  inventario: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9",
  lotes: "M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5",
  caja: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  anular: "M4 9h11a5 5 0 0 1 0 10H8M4 9l4-4M4 9l4 4",
  cierre: "M3 7h18v12H3zM3 7l2-3h14l2 3M12 11v4M10 13h4",
  reportes: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  red: "M12 5a2 2 0 1 0 0-.01M5 19a2 2 0 1 0 0-.01M19 19a2 2 0 1 0 0-.01M11 7l-5 10M13 7l5 10M7 19h10",
  recetas: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  tiendas: "M4 10v10h16V10M3 10l2-6h14l2 6zM3 10c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3M10 20v-5h4v5",
  empleados: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c1.8.8 3 2.7 3 5",
  auditoria: "M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6zM9 12l2 2 4-4",
  precios: "M3 12V4h8l9.5 9.5-8 8zM7.5 8a.5.5 0 1 0 0-.01",
  modulo: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  menu: "M4 7h16M4 12h16M4 17h16",
  panelCerrar: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9.5 4v16M16 10l-2 2 2 2",
  panelAbrir: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9.5 4v16M14 10l2 2-2 2",
  salir: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  alerta: "M12 4 2.8 20h18.4zM12 10v4M12 17v.01",
  campana: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0",
  usuario: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-8 8-8s8 3.6 8 8",
  candado: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  ojo: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ojoCerrado: "M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3 3.6M6.6 7.6C4 9.3 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  chevron: "M9 6l6 6-6 6",
  flecha:"M5 12h14M13 6l6 6-6 6",
  reloj: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  ajustes: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  cerrar: "M6 6l12 12M18 6 6 18",
  cruz: "M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z",
};

export function Icono({ nombre, tamano = 20, className = "", trazo = 1.6 }) {
  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={trazo}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={TRAZOS[nombre] || TRAZOS.modulo} />
    </svg>
  );
}

// Ícono de cada módulo del catálogo (permiso → ícono).
export const ICONO_MODULO = {
  INVENTARIO_CONSULTAR: "inventario",
  INVENTARIO_GESTIONAR: "lotes",
  VENTA_REGISTRAR: "caja",
  FACTURA_ANULAR: "anular",
  CAJA_CERRAR: "cierre",
  REPORTE_TIENDA_VER: "reportes",
  REPORTE_CONSOLIDADO_VER: "reportes",
  RED_VISIBILIDAD: "red",
  RED_CONTROL: "recetas",
  TIENDA_GESTIONAR: "tiendas",
  EMPLEADO_GESTIONAR: "empleados",
  AUDITORIA_CONSULTAR: "auditoria",
  PRECIO_GESTIONAR: "precios",
};

// Marca de FarmaHub: cruz de farmacia dentro de un cuadro redondeado.
export function Marca({ tamano = 36, className = "" }) {
  return (
    <span
      className={`inline-grid place-items-center rounded-[10px] bg-primario text-white ${className}`}
      style={{ width: tamano, height: tamano }}
      aria-hidden="true"
    >
      <Icono nombre="cruz" tamano={Math.round(tamano * 0.56)} trazo={1.8} />
    </span>
  );
}
