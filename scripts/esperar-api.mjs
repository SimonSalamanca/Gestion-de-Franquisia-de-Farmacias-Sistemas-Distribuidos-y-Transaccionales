// `npm run dev`: la web espera a que el API responda antes de arrancar. Al iniciar, el API migra y sincroniza
// (varios segundos con Neon); si Vite arrancaba antes, su proxy registraba ECONNREFUSED en cada consulta de la página.
// Si el API no responde en el plazo, la web arranca igual (la página reintenta sola) y se avisa.
const puerto = Number(process.env.PORT) || 4000;
const url = `http://127.0.0.1:${puerto}/api/conectividad`;
const PLAZO_MS = 180_000;
const inicio = Date.now();

process.stdout.write(`esperando al API en el puerto ${puerto}…\n`);
while (Date.now() - inicio < PLAZO_MS) {
  try {
    const respuesta = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (respuesta.ok) {
      process.stdout.write(`API lista en ${((Date.now() - inicio) / 1000).toFixed(1)} s: arrancando la web.\n`);
      process.exit(0);
    }
  } catch {
    /* todavía no escucha */
  }
  await new Promise((resolver) => setTimeout(resolver, 500));
}
process.stdout.write(`el API no respondió en ${PLAZO_MS / 1000} s: la web arranca igual y reintentará sola.\n`);
process.exit(0);
