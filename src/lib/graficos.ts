/**
 * La aritmética de los gráficos, sin React y sin navegador.
 *
 * Vive en `src/lib` y no junto a los componentes por dos razones. La primera,
 * que se prueba sola (`graficos.test.ts`). La segunda, la de siempre con la
 * frontera servidor/cliente: los envoltorios de dominio (la curva de
 * patrimonio, el ritmo del mes…) son componentes de SERVIDOR que preparan las
 * lecturas ya formateadas, y desde el servidor no se puede usar nada que
 * exporte un módulo `"use client"` —llega como un proxy—. Un módulo neutro lo
 * pueden importar los dos lados.
 *
 * DINERO Y PÍXELES. El dinero entra y sale en céntimos enteros y se formatea
 * con `src/lib/money.ts`. Los flotantes de aquí son geometría (píxeles) o
 * porcentajes de presentación, nunca importes.
 */

import {
  MINUS,
  formatCents,
  formatPercent,
  formatShare,
  formatSignedDelta,
  percentChange,
} from "@/lib/money";

export type Pt = { x: number; y: number };

/** Cómo se rotula un valor en el eje y en las anotaciones. */
export type FormatoEje = "euros" | "porcentaje";

/**
 * El tono de una lectura. No es «sube/baja»: que el gasto suba es malo y que el
 * patrimonio suba es bueno, y eso solo lo sabe quien prepara la lectura.
 */
export type Tono = "bien" | "mal" | "neutro";

/**
 * Lo que la cabecera de un gráfico enseña al leer un punto o una barra. Va ya
 * formateado: lo prepara el servidor y cruza la frontera como texto.
 */
export type LecturaPunto = {
  /** «agosto de 2026», «Día 12». */
  rotulo: string;
  /** La cifra grande: «36.139,57 €», «+4,2 %». */
  cifra: string;
  /** La línea de debajo: «+1163,17 € (+3,1 %) desde marzo». */
  detalle?: string;
  tono?: Tono;
};

/**
 * Los tamaños de la cifra de una cabecera de gráfico. Viven aquí, en un módulo
 * neutro, porque el REPOSO lo pinta el envoltorio de dominio (servidor) y la
 * LECTURA el primitivo (cliente), y las dos tienen que medir lo mismo para que
 * nada salte al tocar.
 *
 *  · heroe: el gráfico principal de una pantalla.
 *  · normal: un gráfico con titular propio.
 *  · compacto: una curva secundaria.
 *  · fila: la cifra a la derecha de un medallón, en los múltiplos pequeños.
 */
export type TamanoLectura = "heroe" | "normal" | "compacto" | "fila";

// `cifra-ajustable` (sin estilos propios) marca las grandes para `AjusteCifras`
// (components/app/ajuste-cifras.tsx): si una de siete u ocho cifras no cabe en
// su tarjeta, se encoge lo justo en vez de salirse (hallazgo M-1).
export const CIFRA_LECTURA: Record<TamanoLectura, string> = {
  heroe:
    "cifra cifra-ajustable whitespace-nowrap text-[40px] leading-[44px] font-medium lg:text-[48px] lg:leading-[52px]",
  normal:
    "cifra cifra-ajustable whitespace-nowrap text-[34px] leading-[40px] font-medium lg:text-[40px] lg:leading-[46px]",
  compacto: "cifra text-[22px] leading-7 font-medium lg:text-[26px] lg:leading-8",
  fila: "cifra text-[17px] leading-[22px] font-medium",
};

/** Traza recta: lo honesto cuando se lee la precisión de cada punto. */
export function rutaRecta(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("");
}

/** Cierra una traza contra el suelo para rellenar el área. */
export function cerrarArea(d: string, pts: Pt[], suelo: number): string {
  if (pts.length === 0) return "";
  const a = pts[0];
  const z = pts[pts.length - 1];
  return `${d}L${z.x.toFixed(2)},${suelo.toFixed(2)}L${a.x.toFixed(2)},${suelo.toFixed(2)}Z`;
}

/**
 * Los índices con dato, partidos en tramos por los huecos. Un `null` es «aquí
 * todavía no hay dato»: la línea se corta y no baja a cero, que parecería que
 * dejaste de gastar.
 */
export function tramos(valores: (number | null)[]): number[][] {
  const salida: number[][] = [];
  let actual: number[] = [];
  valores.forEach((v, i) => {
    if (v === null) {
      if (actual.length) salida.push(actual);
      actual = [];
    } else {
      actual.push(i);
    }
  });
  if (actual.length) salida.push(actual);
  return salida;
}

export function ultimoConDato(valores: (number | null)[]): number | null {
  for (let i = valores.length - 1; i >= 0; i--) if (valores[i] !== null) return i;
  return null;
}

/**
 * Dónde están el máximo y el mínimo de una serie, ignorando los huecos. Ante un
 * empate gana el más RECIENTE: es el que se recuerda («el máximo es de ayer»).
 */
export function extremos(valores: (number | null)[]): { iMax: number; iMin: number } | null {
  let iMax = -1;
  let iMin = -1;
  valores.forEach((v, i) => {
    if (v === null) return;
    if (iMax === -1 || v >= (valores[iMax] as number)) iMax = i;
    if (iMin === -1 || v <= (valores[iMin] as number)) iMin = i;
  });
  return iMax === -1 ? null : { iMax, iMin };
}

/**
 * Media entera de unos céntimos: suma entera y una sola división redondeada al
 * céntimo, nunca una media de flotantes. `null` si no hay nada que promediar.
 */
export function mediaEntera(valores: number[]): number | null {
  if (valores.length === 0) return null;
  return Math.round(valores.reduce((s, v) => s + v, 0) / valores.length);
}

/**
 * Escala «bonita» para un eje: un paso de 1, 2 o 5 × 10^k que reparte el rango
 * en unas `marcas` divisiones. Con céntimos devuelve enteros; con porcentajes,
 * el paso mínimo es 1 (un punto porcentual).
 */
export function escalaBonita(min: number, max: number, marcas = 4, pasoMinimo = 1) {
  // H-20: con un Infinity el bucle de la potencia no acababa nunca, y un NaN
  // daba una escala NaN. Lo que no es finito cuenta como 0.
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = min;
  if (max < min) [min, max] = [max, min];
  if (!Number.isFinite(marcas) || marcas < 1) marcas = 4;
  if (!Number.isFinite(pasoMinimo) || pasoMinimo <= 0) pasoMinimo = 1;
  // `pasoMinimo`: con céntimos, 100 (un euro); si no, una serie casi plana daba
  // pasos de un céntimo y el eje rotulaba «0, 0, 0».
  const bruto = Math.max(Math.ceil((max - min) / Math.max(marcas, 1)), pasoMinimo);
  let potencia = 1;
  while (potencia * 10 <= bruto) potencia *= 10;
  const paso = [1, 2, 5, 10].map((f) => f * potencia).find((p) => p >= bruto) ?? potencia * 10;
  const desde = Math.floor(min / paso) * paso;
  let hasta = Math.ceil(max / paso) * paso;
  // Una serie plana (min = max) dejaría la escala sin altura.
  if (hasta === desde) hasta = desde + paso;
  const ticks: number[] = [];
  for (let v = desde; v <= hasta; v += paso) ticks.push(v);
  return { desde, hasta, paso, ticks };
}

/** Euros sin céntimos y sin símbolo, para rótulos de eje: «43.120». */
const enterosEje = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

/** El rótulo de un valor en el eje o en una anotación. */
export function rotuloEje(valor: number, formato: FormatoEje = "euros"): string {
  if (formato === "porcentaje") return formatPercent(valor, 0).replace("+", "");
  return enterosEje.format(Math.round(valor / 100));
}

/** De la posición x dentro de la caja al punto más cercano de una línea. */
export function indiceLinea(
  x: number,
  ancho: number,
  total: number,
  margenIzquierdo: number,
  margenDerecho: number,
): number {
  if (total <= 1 || !Number.isFinite(x) || !Number.isFinite(ancho)) return 0;
  const util = ancho - margenIzquierdo - margenDerecho;
  if (util <= 0) return 0;
  const i = Math.round(((x - margenIzquierdo) / util) * (total - 1));
  return Math.min(Math.max(i, 0), total - 1);
}

/** De la posición x a la columna en la que cae, para barras repartidas. */
export function indiceColumna(x: number, ancho: number, total: number): number {
  if (!(ancho > 0) || !(total > 0) || !Number.isFinite(x) || !Number.isFinite(ancho)) return 0;
  return Math.min(Math.max(Math.floor((x / ancho) * total), 0), total - 1);
}

/**
 * Lo que ocupa un rótulo del eje de barras (11 px, Inter) mientras no se ha
 * podido medir —en el render del servidor, o con el gráfico oculto—: 8 px
 * por carácter, que es estimar por arriba («May» en negrita mide 23 px;
 * «2026», 28). Sobrar solo cuesta un rótulo menos hasta medir.
 */
export const EJE_PX_POR_CARACTER = 8;

/** El aire mínimo entre dos rótulos vecinos del eje, en píxeles. */
export const EJE_SEPARACION = 6;

export function anchoEstimadoRotulo(texto: string): number {
  return [...texto].length * EJE_PX_POR_CARACTER;
}

/**
 * Qué rótulos del eje de unas barras se escriben, según el ancho REAL de la
 * caja y de cada rótulo (`anchos`, en píxeles). Cada rótulo va centrado en su
 * columna; con doce meses en una celda estrecha no caben todos y se
 * amontonaban («NovDicEneFeb…»).
 *
 * La regla: uno de cada `paso`, el menor con el que dos vecinos escritos
 * guardan al menos `EJE_SEPARACION` de aire, contando DESDE EL ÚLTIMO —el
 * presente siempre se rotula—. La barra `fija` (la marcada: el mes del
 * movimiento, el año en curso) se rotula aunque no le toque, y entonces se
 * callan los vecinos que la pisarían. Los que no se escriben siguen en la
 * lectura al tocar y en el anuncio, con el mes entero.
 */
export function rotulosEjeVisibles(
  anchos: number[],
  anchoCaja: number,
  fija: number | null = null,
): boolean[] {
  const total = anchos.length;
  if (total === 0) return [];
  if (anchoCaja <= 0) return anchos.map(() => true);
  const columna = anchoCaja / total;
  // ¿Caben dos rótulos centrados en las columnas i y j sin pisarse?
  const caben = (i: number, j: number) =>
    Math.abs(j - i) * columna - (anchos[i] + anchos[j]) / 2 >= EJE_SEPARACION;

  let visibles = anchos.map(() => true);
  for (let paso = 1; paso <= total; paso++) {
    visibles = anchos.map((_, i) => (total - 1 - i) % paso === 0);
    const escritos = visibles.flatMap((v, i) => (v ? [i] : []));
    if (escritos.every((i, k) => k === 0 || caben(escritos[k - 1], i))) break;
  }

  if (fija !== null && fija >= 0 && fija < total && !visibles[fija]) {
    visibles[fija] = true;
    for (let j = 0; j < total; j++) {
      if (j !== fija && visibles[j] && !caben(j, fija)) visibles[j] = false;
    }
  }
  return visibles;
}

/**
 * La variación entre dos importes para el detalle de una lectura:
 * «+1163,17 € (+3,1 %)». `subirEsBueno` decide el tono: el patrimonio que sube
 * es bueno; el gasto que sube, no.
 */
export function variacionImporte(
  desde: number,
  hasta: number,
  subirEsBueno = true,
): { texto: string; tono: Tono } {
  const delta = hasta - desde;
  const pct = percentChange(hasta, desde);
  const texto = pct === null ? formatSignedDelta(delta) : `${formatSignedDelta(delta)} (${formatPercent(pct)})`;
  const tono: Tono = delta === 0 ? "neutro" : delta > 0 === subirEsBueno ? "bien" : "mal";
  return { texto, tono };
}

/** «398,80 € sobre la media», con su tono según si subir es bueno o malo. */
export function contraMedia(
  valor: number,
  media: number,
  subirEsBueno = false,
): { texto: string; tono: Tono } {
  const d = valor - media;
  if (d === 0) return { texto: "Justo en la media", tono: "neutro" };
  return {
    texto: `${formatCents(Math.abs(d))} ${d > 0 ? "sobre" : "bajo"} la media`,
    tono: d > 0 === subirEsBueno ? "bien" : "mal",
  };
}

/**
 * Las lecturas de una curva de NIVEL (patrimonio, saldo, compromiso): la cifra
 * de cada punto y su variación desde el primero del periodo.
 */
export function lecturasNivel(
  valores: number[],
  rotulos: string[],
  { desdeRotulo, subirEsBueno = true }: { desdeRotulo: string; subirEsBueno?: boolean },
): LecturaPunto[] {
  const inicio = valores[0] ?? 0;
  return valores.map((v, i) => {
    const variacion = variacionImporte(inicio, v, subirEsBueno);
    return {
      rotulo: rotulos[i],
      cifra: formatCents(v),
      detalle: i === 0 ? `Inicio del periodo` : `${variacion.texto} desde ${desdeRotulo}`,
      tono: i === 0 ? "neutro" : variacion.tono,
    };
  });
}

/**
 * Los arcos de un anillo (el donut, y mañana los anillos de presupuesto), en
 * PORCENTAJE de la vuelta: dónde empieza cada sector y cuánto mide su trazo
 * visible, descontado el hueco entre sectores.
 *
 * Los extremos van redondeados (`stroke-linecap: round`), y el remate sobresale
 * medio grosor por cada lado: por eso el hueco que se descuenta es el visible
 * MÁS el grosor entero (`remate`, también en porcentaje de la vuelta). Un
 * sector más pequeño que eso no desaparece: queda como un punto (largo casi
 * cero con sus dos remates), que es lo honesto para una parte diminuta.
 */
export function sectoresAnillo(
  valores: number[],
  { hueco = 1.4, remate = 0 }: { hueco?: number; remate?: number } = {},
): { desde: number; largo: number; fraccion: number }[] {
  const positivos = valores.map((v) => Math.max(v, 0));
  const total = positivos.reduce((s, v) => s + v, 0);
  if (total <= 0) return valores.map(() => ({ desde: 0, largo: 0, fraccion: 0 }));
  // Con un solo sector no hay huecos: es el anillo entero.
  const n = positivos.filter((v) => v > 0).length;
  const descuento = n > 1 ? hueco + remate : 0;
  let acumulado = 0;
  return positivos.map((v) => {
    const fraccion = v / total;
    const tramo = fraccion * 100;
    const desde = acumulado + (n > 1 ? descuento / 2 : 0);
    acumulado += tramo;
    return {
      desde,
      largo: v > 0 ? Math.max(tramo - descuento, 0.01) : 0,
      fraccion,
    };
  });
}

/**
 * Qué sector cae bajo un ángulo, medido en porcentaje de vuelta desde las doce
 * en el sentido del reloj.
 */
export function sectorEnAngulo(fracciones: number[], vuelta: number): number {
  let acumulado = 0;
  for (let i = 0; i < fracciones.length; i++) {
    acumulado += fracciones[i] * 100;
    if (vuelta < acumulado) return i;
  }
  return Math.max(fracciones.length - 1, 0);
}

/* ------------------------------------------------------------------------- *
 * La aritmética de los gráficos de la fase 2. Todo lo que es dinero entra y
 * sale en céntimos ENTEROS; los porcentajes son de presentación.
 * ------------------------------------------------------------------------- */

/**
 * El gasto de cada día a partir del ACUMULADO del mes (`month_pace`): la
 * diferencia con el día anterior. Un día sin dato todavía (`null`, el futuro)
 * sigue siendo `null`, no cero: «no ha pasado» no es «no gastaste». Puede salir
 * negativo, el día que una devolución supera a lo gastado.
 */
export function diferenciasDiarias(acumulado: (number | null)[]): (number | null)[] {
  let previo = 0;
  return acumulado.map((v) => {
    if (v === null) return null;
    const d = v - previo;
    previo = v;
    return d;
  });
}

/**
 * Una recta de enteros de `desde` a `hasta` en `pasos` saltos (pasos + 1
 * valores, los dos extremos incluidos y exactos). Es la proyección: del
 * presente a un punto previsto. Cada valor intermedio se redondea al céntimo.
 */
export function proyeccionLineal(desde: number, hasta: number, pasos: number): number[] {
  if (pasos <= 0) return [hasta];
  const salida: number[] = [];
  for (let k = 0; k <= pasos; k++) {
    salida.push(k === pasos ? hasta : desde + Math.round(((hasta - desde) * k) / pasos));
  }
  return salida;
}

/** Un escalón de la cascada: de dónde sale y adónde llega la barra. */
export type PasoCascada = { desde: number; hasta: number; delta: number };

/**
 * La CASCADA: un punto de partida (el ingreso del mes) y unos pasos con signo
 * (lo que se va en cada categoría, en negativo; una categoría que las
 * devoluciones dejan en positivo, en positivo). Cada barra flota entre el
 * acumulado de antes y el de después. Todo entero: lo que queda es EXACTAMENTE
 * inicio + Σ pasos.
 */
export function cascada(
  inicio: number,
  deltas: number[],
): { pasos: PasoCascada[]; final: number; min: number; max: number } {
  const pasos: PasoCascada[] = [{ desde: 0, hasta: inicio, delta: inicio }];
  let acumulado = inicio;
  for (const d of deltas) {
    pasos.push({ desde: acumulado, hasta: acumulado + d, delta: d });
    acumulado += d;
  }
  const todos = [0, ...pasos.flatMap((p) => [p.desde, p.hasta])];
  return {
    pasos,
    final: acumulado,
    min: Math.min(...todos),
    max: Math.max(...todos),
  };
}

/**
 * La tasa de ahorro de un mes, en %: lo que sumaste entre lo que entró. Las
 * dos cifras son céntimos enteros; el cociente es solo para pintarlo. Sin
 * ingresos no hay tasa (`null`): dividir entre cero no es «0 %».
 */
export function tasaAhorro(ahorro: number, ingreso: number): number | null {
  if (ingreso <= 0) return null;
  return (ahorro / ingreso) * 100;
}

/**
 * La tasa de todo el periodo, PONDERADA: Σ ahorro / Σ ingreso de los meses con
 * ingreso, no la media de las tasas. Un mes de 100 € no pesa lo que uno de
 * 3.000 €.
 */
export function tasaAgregada(
  meses: { saved_cents: number; income_cents: number }[],
): number | null {
  const con = meses.filter((m) => m.income_cents > 0);
  const ingreso = con.reduce((s, m) => s + m.income_cents, 0);
  const ahorro = con.reduce((s, m) => s + m.saved_cents, 0);
  return tasaAhorro(ahorro, ingreso);
}

/**
 * Capas apiladas para un ÁREA (caja, invertido, sin desplegar), divergentes:
 * lo positivo se apila hacia arriba desde el cero y lo negativo hacia abajo.
 * Una tarjeta en descubierto deja la caja bajo cero y no se come lo invertido.
 * `capas[k][i]` es el valor de la capa k en el punto i; devuelve, por capa y
 * punto, su suelo y su techo.
 */
export function apilar(capas: number[][]): { base: number; techo: number }[][] {
  const n = Math.max(0, ...capas.map((c) => c.length));
  const salida = capas.map(() => [] as { base: number; techo: number }[]);
  for (let i = 0; i < n; i++) {
    let arriba = 0;
    let abajo = 0;
    capas.forEach((capa, k) => {
      const v = capa[i] ?? 0;
      if (v >= 0) {
        salida[k].push({ base: arriba, techo: arriba + v });
        arriba += v;
      } else {
        salida[k].push({ base: abajo, techo: abajo + v });
        abajo += v;
      }
    });
  }
  return salida;
}

/** Una celda del mapa de calor tal como llega de `spend_heatmap`. */
export type CeldaCalor = {
  dia_semana: number;
  hora: number | null;
  net_cents: number;
  cargos: number;
};

/** Lo que suma una casilla de la rejilla: gasto neto y número de cargos. */
export type Casilla = { net_cents: number; cargos: number };

/**
 * La rejilla del mapa de calor agrupada en FRANJAS de `horasPorFranja` horas:
 * siete días (lunes primero), cada uno con sus franjas y, al final, la casilla
 * «sin hora». Con 1 es la rejilla de 24 horas; con 3, las ocho franjas que
 * caben en un móvil. Las sumas son enteras: el total de la rejilla es siempre
 * el de las 175 celdas de entrada.
 */
export function agruparFranjas(celdas: CeldaCalor[], horasPorFranja: number): Casilla[][] {
  const franjas = Math.ceil(24 / horasPorFranja);
  const rejilla: Casilla[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: franjas + 1 }, () => ({ net_cents: 0, cargos: 0 })),
  );
  for (const c of celdas) {
    if (c.dia_semana < 1 || c.dia_semana > 7) continue;
    const col = c.hora === null ? franjas : Math.floor(c.hora / horasPorFranja);
    const casilla = rejilla[c.dia_semana - 1][col];
    if (!casilla) continue;
    casilla.net_cents += c.net_cents;
    casilla.cargos += c.cargos;
  }
  return rejilla;
}

/**
 * La intensidad de cada nivel del calor (el calendario y el mapa de horas): el
 * cian del acento, de nada a pleno. Vive aquí para que los dos —y su escala de
 * «menos → más»— pinten exactamente lo mismo.
 */
export const OPACIDAD_CALOR = [0, 0.22, 0.42, 0.68, 1];

/**
 * El nivel de color de una casilla, de 0 (nada) a `niveles`. Lo que no es
 * gasto (cero o negativo, una devolución) es 0. El resto, por tramos iguales
 * del máximo y hacia ARRIBA: cualquier gasto se ve, por pequeño que sea.
 */
export function nivelCalor(valor: number, maximo: number, niveles = 4): number {
  if (valor <= 0 || maximo <= 0) return 0;
  return Math.min(niveles, Math.max(1, Math.ceil((valor / maximo) * niveles)));
}

/** Una fila de `commitment_by_subscription`. */
export type FilaCompromiso = {
  period_month: string;
  subscription_id: string;
  description: string;
  monthly_cents: number;
  cuenta: boolean;
  alta: boolean;
};

export type CambioCompromiso = {
  entran: { nombre: string; cents: number }[];
  salen: { nombre: string; cents: number }[];
};

/**
 * Qué explica cada escalón del compromiso: las suscripciones que EMPIEZAN a
 * contar ese mes y las que DEJAN de contar respecto al anterior. Es la
 * diferencia de conjuntos entre un mes y el previo; el primer mes no tiene
 * previo, y ahí solo se cuentan las altas de ese mismo mes.
 */
export function cambiosCompromiso(filas: FilaCompromiso[]): Map<string, CambioCompromiso> {
  const meses = [...new Set(filas.map((f) => f.period_month))].sort();
  const cuentaEn = new Map<string, Map<string, FilaCompromiso>>();
  for (const m of meses) cuentaEn.set(m, new Map());
  for (const f of filas) if (f.cuenta) cuentaEn.get(f.period_month)?.set(f.subscription_id, f);

  const porImporte = (a: { cents: number }, b: { cents: number }) => b.cents - a.cents;
  const salida = new Map<string, CambioCompromiso>();
  meses.forEach((m, i) => {
    const ahora = cuentaEn.get(m) ?? new Map<string, FilaCompromiso>();
    const antes = i > 0 ? (cuentaEn.get(meses[i - 1]) ?? null) : null;
    const entran = [...ahora.values()]
      .filter((f) => (antes ? !antes.has(f.subscription_id) : f.alta))
      .map((f) => ({ nombre: f.description, cents: f.monthly_cents }));
    const salen = antes
      ? [...antes.values()]
          .filter((f) => !ahora.has(f.subscription_id))
          .map((f) => ({ nombre: f.description, cents: f.monthly_cents }))
      : [];
    salida.set(m, {
      entran: entran.sort(porImporte),
      salen: salen.sort(porImporte),
    });
  });
  return salida;
}

/**
 * «Netflix y Spotify», «Netflix, Spotify y 2 más»: una lista de nombres que
 * cabe en una línea de lectura.
 */
export function listaNombres(nombres: string[], maximo = 2): string {
  if (nombres.length === 0) return "";
  if (nombres.length === 1) return nombres[0];
  if (nombres.length <= maximo) {
    return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
  }
  return `${nombres.slice(0, maximo).join(", ")} y ${nombres.length - maximo} más`;
}

/** Una tasa en %, con el menos tipográfico si es negativa: «23,4 %», «−8,0 %». */
export function textoTasa(v: number | null, digitos = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v < 0 ? MINUS : ""}${formatShare(Math.abs(v), digitos)}`;
}
