import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { SECTIONS, SUBSECTIONS, TABS, isActive } from "./nav";

/**
 * Estas pruebas existen por un fallo concreto.
 *
 * La barra lateral con todas las secciones es solo de escritorio; en móvil hay
 * cuatro pestañas. Se declaró qué pestaña se ilumina dentro de cada pantalla
 * hija, pero no se pintó ni un enlace hacia ellas: Inversiones, Análisis y
 * Suscripciones estuvieron sin ninguna forma de llegar desde un teléfono. La
 * app funcionaba, los tests pasaban y en escritorio no se notaba nada.
 *
 * Así que aquí no se comprueba la configuración de la navegación: se comprueba
 * que desde un móvil se puede LLEGAR a todas las pantallas.
 */

const APP = "src/app/(app)";

/** Todas las rutas de la app, leídas del sistema de ficheros. */
function rutasReales(): string[] {
  const rutas: string[] = [];
  const recorrer = (dir: string, prefijo: string) => {
    for (const entrada of readdirSync(dir)) {
      const completa = join(dir, entrada);
      if (!statSync(completa).isDirectory()) continue;
      // Los grupos entre paréntesis no aparecen en la URL, y los segmentos
      // dinámicos no son pantallas a las que se navegue desde un menú.
      if (entrada.startsWith("(")) {
        // Un grupo puede llevar la página de su padre: `movimientos/(lista)/
        // page.tsx` es /movimientos (va en un grupo para que su loading.tsx no
        // envuelva a las pantallas hijas).
        if (prefijo && readdirSync(completa).includes("page.tsx") && !rutas.includes(prefijo)) {
          rutas.push(prefijo);
        }
        recorrer(completa, prefijo);
        continue;
      }
      if (entrada.startsWith("[")) continue;
      const ruta = `${prefijo}/${entrada}`;
      if (readdirSync(completa).includes("page.tsx")) rutas.push(ruta);
      recorrer(completa, ruta);
    }
  };
  recorrer(APP, "");
  return rutas;
}

const TAB_HREFS = TABS.map((t) => t.href);

/**
 * Pantallas que a propósito no se enlazan desde ningún sitio.
 *
 * `/disenio` es el banco de pruebas del sistema de diseño: sirve para mirar los
 * tokens en las doce combinaciones de tema y acento, y no es parte del producto.
 */
const SIN_ENLACE_A_PROPOSITO = ["/disenio"];

/** Todo el código de la app, para buscar quién enlaza qué. */
function todoElCodigo(): string {
  const trozos: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const completa = join(dir, entrada);
      if (statSync(completa).isDirectory()) {
        recorrer(completa);
      } else if (entrada.endsWith(".tsx") || entrada.endsWith(".ts")) {
        trozos.push(readFileSync(completa, "utf8"));
      }
    }
  };
  // Se mira todo `src`, no solo los `page.tsx`: los enlaces viven muchas veces
  // en un componente que la pantalla pinta, como la tarjeta de «Tus datos».
  recorrer("src");
  return trozos.join("\n");
}

describe("la navegación de móvil", () => {
  it("tiene exactamente cuatro pestañas", () => {
    expect(TABS).toHaveLength(4);
  });

  /**
   * El corazón del asunto: cada pantalla que no es pestaña tiene que estar
   * enlazada desde la pantalla de alguna pestaña, o desde un componente que
   * esa pantalla pinte. Si no, en un móvil no existe.
   */
  it("permite llegar a todas las pantallas que no son pestaña", () => {
    const enlazadas = new Set<string>();
    for (const hijas of Object.values(SUBSECTIONS)) {
      for (const h of hijas) enlazadas.add(h.href);
    }
    const codigo = todoElCodigo();

    const inalcanzables = rutasReales().filter((ruta) => {
      if (TAB_HREFS.includes(ruta)) return false;
      if (SIN_ENLACE_A_PROPOSITO.includes(ruta)) return false;
      if (enlazadas.has(ruta)) return false;
      // Un enlace literal en cualquier parte de la app vale: lo que no vale es
      // que no exista ninguno, que es lo que pasaba.
      //
      // No se sigue la cadena: si A enlaza B pero a A no se llega, esto da B por
      // buena. Es el punto ciego conocido —Inversiones se salvaba así, colgando
      // de un Patrimonio inalcanzable— y lo cubren las dos pruebas de abajo,
      // que exigen que cada hija cuelgue de una PESTAÑA y que esa pestaña pinte
      // sus accesos.
      return !codigo.includes(`href="${ruta}"`) && !codigo.includes(`href={\`${ruta}`);
    });

    expect(inalcanzables).toEqual([]);
  });

  it("cada pestaña con hijas se ilumina estando dentro de ellas", () => {
    for (const [padre, hijas] of Object.entries(SUBSECTIONS)) {
      const pestana = TABS.find((t) => t.href === padre);
      expect(pestana, `${padre} debería ser una pestaña`).toBeDefined();
      for (const hija of hijas) {
        expect(isActive(pestana!, hija.href), `${padre} no se ilumina en ${hija.href}`).toBe(true);
      }
    }
  });

  it("ninguna pantalla cuelga de dos pestañas a la vez", () => {
    const vistas = new Map<string, string>();
    for (const [padre, hijas] of Object.entries(SUBSECTIONS)) {
      for (const h of hijas) {
        expect(vistas.has(h.href), `${h.href} cuelga de ${vistas.get(h.href)} y de ${padre}`).toBe(
          false,
        );
        vistas.set(h.href, padre);
      }
    }
  });

  it("toda pantalla que cuelga de una pestaña se pinta de verdad en ella", () => {
    // Que esté en SUBSECTIONS no basta: la pantalla madre tiene que pintar
    // <SubNav>, que es quien convierte esa lista en enlaces.
    for (const padre of Object.keys(SUBSECTIONS)) {
      const fuente = readFileSync(`${APP}${padre}/page.tsx`, "utf8");
      expect(fuente, `${padre} no pinta sus accesos`).toContain(`<SubNav parent="${padre}"`);
    }
  });
});

describe("la navegación de escritorio", () => {
  it("lleva las once secciones", () => {
    expect(SECTIONS).toHaveLength(11);
  });

  it("las pantallas que se unieron en Fijos ya no son secciones sueltas", () => {
    const hrefs = SECTIONS.map((s) => s.href);
    expect(hrefs).toContain("/fijos");
    expect(hrefs).not.toContain("/suscripciones");
    expect(hrefs).not.toContain("/ingresos");
    const deAjustes = SUBSECTIONS["/ajustes"].map((s) => s.href);
    expect(deAjustes).toContain("/fijos");
    expect(deAjustes).not.toContain("/suscripciones");
    expect(deAjustes).not.toContain("/ingresos");
  });

  it("y todas apuntan a una pantalla que existe", () => {
    const reales = rutasReales();
    for (const s of SECTIONS) {
      expect(reales, `${s.href} no existe`).toContain(s.href);
    }
  });
});

describe("las direcciones viejas", () => {
  /*
   * Suscripciones e Ingresos recurrentes se unieron en Fijos. Hay marcadores,
   * enlaces y una app instalada que siguen apuntando a las direcciones viejas:
   * tienen que llegar al grupo que les toca, y para siempre (308).
   */
  it("redirigen de forma permanente al grupo de Fijos que les toca", async () => {
    const reglas = (await nextConfig.redirects?.()) ?? [];
    const destino = (source: string) => reglas.find((r) => r.source === source);
    expect(destino("/suscripciones")).toMatchObject({
      destination: "/fijos?ver=gastos",
      permanent: true,
    });
    expect(destino("/ingresos")).toMatchObject({
      destination: "/fijos?ver=ingresos",
      permanent: true,
    });
  });

  it("y ya no son pantallas: la redirección no puede quedar tapada por una página", () => {
    const reales = rutasReales();
    expect(reales).not.toContain("/suscripciones");
    expect(reales).not.toContain("/ingresos");
    expect(reales).toContain("/fijos");
  });
});
