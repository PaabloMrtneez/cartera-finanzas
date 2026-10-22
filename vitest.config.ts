import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // `npm run test:coverage`: la lógica (src/lib) y las acciones y rutas del
    // servidor. Los componentes se prueban de punta a punta (e2e/).
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/app/**/*.ts"],
      exclude: ["**/*.test.ts", "src/lib/supabase/database.types.ts"],
      reporter: ["text-summary", "html"],
    },
  },
});
