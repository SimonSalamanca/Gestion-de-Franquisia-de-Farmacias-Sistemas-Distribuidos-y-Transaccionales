import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Por defecto, el nodo de la tienda 1. Para otro nodo local: FARMAHUB_API=http://localhost:4001 npm run dev
      "/api": process.env.FARMAHUB_API || "http://localhost:4000",
    },
  },
});
