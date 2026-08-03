import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  return {
    base: environment.VITE_BASE_PATH || "/",
    plugins: [react()],
    build: {
      sourcemap: true,
      target: "es2022",
    },
  };
});
