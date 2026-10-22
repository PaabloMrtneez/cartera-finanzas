import { z } from "zod";

/**
 * H-11: los mensajes por defecto de Zod, en ESPAÑOL. Es configuración global
 * de la instancia de Zod: vale para todo esquema que se valide después de
 * cargar este módulo. Lo importan `schemas.ts` (y con él todas las acciones) y
 * las rutas que validan con Zod por su cuenta, como la del Atajo. Los campos
 * que importan llevan además su mensaje propio, más claro que el genérico.
 */
z.config(z.locales.es());
