import { useEffect, useState } from "react";
import { Icono } from "./iconos.jsx";

// Avisos breves de confirmación ("Solicitud 6 marcada como enviada") para acciones que solo refrescan una lista y no
// muestran un mensaje propio. Cualquier pantalla llama avisar(texto); el panel (App.jsx) monta <Avisos /> una vez.
// role="status": los lectores de pantalla lo anuncian sin interrumpir. Desaparece solo a los 4 s o con Cerrar.
const EVENTO = "farmahub:aviso";
const DURACION_MS = 4000;

export function avisar(texto) {
  window.dispatchEvent(new CustomEvent(EVENTO, { detail: { texto, id: Date.now() + Math.random() } }));
}

export function Avisos() {
  const [lista, setLista] = useState([]);
  useEffect(() => {
    const alAvisar = (event) => {
      const aviso = event.detail;
      setLista((l) => [...l.slice(-2), aviso]);
      setTimeout(() => setLista((l) => l.filter((x) => x.id !== aviso.id)), DURACION_MS);
    };
    window.addEventListener(EVENTO, alAvisar);
    return () => window.removeEventListener(EVENTO, alAvisar);
  }, []);

  return (
    <div className="no-print pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
      {lista.map((aviso) => (
        <div
          key={aviso.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-exito-borde border-l-[3px] border-l-exito bg-superficie px-4 py-3 text-[14px] text-tinta shadow-flotante"
        >
          <span className="mt-0.5 text-exito"><Icono nombre="check" tamano={17} trazo={2} /></span>
          <span className="min-w-0 flex-1">{aviso.texto}</span>
          <button
            type="button"
            className="text-tenue hover:text-tinta"
            onClick={() => setLista((l) => l.filter((x) => x.id !== aviso.id))}
            aria-label="Cerrar aviso"
          >
            <Icono nombre="cerrar" tamano={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
