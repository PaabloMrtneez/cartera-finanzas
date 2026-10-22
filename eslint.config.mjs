import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Los worktrees de las tareas en segundo plano (`.claude/worktrees/*`) son
    // checkouts aislados con su propio `.next` generado; lintarlos no es cosa de
    // este proyecto y ensucia el resultado con errores de ficheros que no son
    // fuente.
    ".claude/**",
    // Skills de agentes instaladas con el CLI `skills` (herramienta de diseño):
    // ejemplos y código de terceros, no son fuente de este proyecto.
    ".agents/**",
    // La app de escritorio: sus dependencias y los instaladores que genera.
    "escritorio/node_modules/**",
    "escritorio/dist/**",
  ]),
]);

export default eslintConfig;
