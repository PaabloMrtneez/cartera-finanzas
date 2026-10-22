import { addDays, hoyMadrid } from "./dates";
import { parseAmountToCents } from "./money";

/**
 * Lectura de los CSV que exportan los bancos.
 *
 * No hay un formato: hay tantos como bancos. Cambian el separador, el orden y
 * el nombre de las columnas, el formato de la fecha y hasta la codificación.
 * Por eso aquí no se adivina y se reza: se detecta, se enseña lo detectado, y
 * la persona lo corrige antes de que se escriba nada.
 *
 * Se hace a mano en lugar de con una dependencia porque las reglas que
 * importan son cuatro y así se pueden probar todas. Y porque un importador es
 * exactamente el sitio donde un fallo silencioso mete cifras equivocadas en el
 * dinero de alguien.
 */

/** La marca de orden de bytes, que si no se quita queda pegada al primer título. */
function sinBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/**
 * Analizador con estados, según RFC 4180: campos entre comillas que pueden
 * contener el separador, saltos de línea y comillas escapadas duplicándolas.
 *
 * Partir por `split(",")` funcionaría hasta el primer concepto con una coma
 * dentro, que en un extracto bancario aparece en la primera página.
 */
export function parseCsv(texto: string, separador: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;
  const src = sinBom(texto);

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (entreComillas) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          entreComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }

    if (c === '"') {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      // \r\n cuenta como un solo final de línea.
      if (c === "\r" && src[i + 1] === "\n") i++;
      fila.push(campo);
      campo = "";
      filas.push(fila);
      fila = [];
    } else {
      campo += c;
    }
  }

  // Lo que quede sin cerrar es la última fila, si el fichero no acaba en salto.
  if (campo !== "" || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  // Fuera las líneas vacías que dejan los ficheros con salto final o con
  // separadores de bloque.
  return filas.filter((f) => f.some((v) => v.trim() !== ""));
}

/**
 * Qué separador usa este fichero.
 *
 * En lugar de contar caracteres, se prueba a analizarlo con cada candidato y
 * gana el que produce una tabla coherente: mismo número de columnas en todas
 * las filas. Contar comas confundiría un fichero de punto y coma en el que los
 * conceptos llevan comas, que es la mitad de los extractos.
 */
export function detectarSeparador(texto: string): string {
  const candidatos = [";", ",", "\t", "|"];
  let mejor = ";";
  let mejorPuntos = -1;

  for (const sep of candidatos) {
    const filas = parseCsv(texto, sep);
    if (filas.length === 0) continue;

    // El ancho de referencia es el MÁS FRECUENTE, no el de la primera fila: los
    // extractos empiezan con líneas de preámbulo («Cuenta;ES91…») que tienen
    // menos columnas que la tabla de verdad.
    const columnas = anchoDominante(filas);
    if (columnas < 2) continue;

    const coherentes = filas.filter((f) => f.length === columnas).length;
    // La coherencia manda; a igualdad, gana el que separa en más columnas.
    const puntos = (coherentes / filas.length) * 100 + Math.min(columnas, 20);

    if (puntos > mejorPuntos) {
      mejorPuntos = puntos;
      mejor = sep;
    }
  }

  return mejor;
}

/** El número de columnas que más se repite. */
function anchoDominante(filas: string[][]): number {
  const cuenta = new Map<number, number>();
  for (const f of filas) cuenta.set(f.length, (cuenta.get(f.length) ?? 0) + 1);
  let ancho = 0;
  let veces = -1;
  for (const [n, c] of cuenta) {
    // A igualdad de frecuencia gana el ancho mayor: es la tabla, no el pie.
    if (c > veces || (c === veces && n > ancho)) {
      veces = c;
      ancho = n;
    }
  }
  return ancho;
}

/**
 * Recorta el preámbulo y el pie que traen los extractos.
 *
 * Un CSV de banco no suele empezar por la cabecera: antes van el número de
 * cuenta, la fecha del extracto y una línea en blanco, y al final a veces un
 * total. Esas líneas tienen menos columnas que la tabla, y por ahí se las
 * reconoce.
 *
 * Lo usan LAS DOS partes —la pantalla para pintar y el servidor para importar—
 * porque si cada una recortara distinto, los índices de columna que elige la
 * persona no señalarían lo mismo en el servidor.
 *
 * `preambulo` cuenta FILAS CON CONTENIDO descartadas, no líneas del fichero:
 * las líneas en blanco ya desaparecen al analizar.
 */
export function prepararTabla(texto: string, separador: string): {
  filas: string[][];
  preambulo: number;
} {
  const todas = parseCsv(texto, separador);
  if (todas.length === 0) return { filas: [], preambulo: 0 };

  const ancho = anchoDominante(todas);
  const primera = todas.findIndex((f) => f.length === ancho);
  if (primera <= 0) {
    return { filas: todas.filter((f) => f.length === ancho), preambulo: 0 };
  }

  return {
    filas: todas.slice(primera).filter((f) => f.length === ancho),
    preambulo: primera,
  };
}

export type FormatoFecha = "dmy" | "mdy" | "ymd";

/**
 * Qué orden llevan día, mes y año en esta columna.
 *
 * `01/02/2026` es el 1 de febrero o el 2 de enero según quién lo escriba, y no
 * hay manera de saberlo mirando ese valor solo. Pero mirando la columna
 * entera sí: en cuanto un valor tiene un 13 o más en la primera posición, el
 * orden es día-mes para todos.
 *
 * Si toda la columna es ambigua se elige día-mes, que es lo español, pero se
 * devuelve `ambiguo` para poder decirlo en pantalla en vez de callarlo.
 */
export function detectarFormatoFecha(valores: string[]): {
  formato: FormatoFecha;
  ambiguo: boolean;
} | null {
  const limpios = valores.map((v) => v.trim()).filter((v) => v !== "");
  if (limpios.length === 0) return null;

  if (limpios.every((v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v))) {
    return { formato: "ymd", ambiguo: false };
  }

  const partidos = limpios
    .map((v) => v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))
    .filter((m): m is RegExpMatchArray => m !== null);

  if (partidos.length === 0) return null;

  const primeroSuperaDoce = partidos.some((m) => Number(m[1]) > 12);
  const segundoSuperaDoce = partidos.some((m) => Number(m[2]) > 12);

  if (primeroSuperaDoce && segundoSuperaDoce) return null; // No cuadra de ninguna manera.
  if (primeroSuperaDoce) return { formato: "dmy", ambiguo: false };
  if (segundoSuperaDoce) return { formato: "mdy", ambiguo: false };

  return { formato: "dmy", ambiguo: true };
}

/** A `2026-08-18`, que es como se guardan. `null` si no se puede leer. */
export function parseFecha(valor: string, formato: FormatoFecha): string | null {
  const texto = valor.trim();

  const m = texto.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (!m) return null;

  let dia: number;
  let mes: number;
  let anio: number;

  if (formato === "ymd") {
    anio = Number(m[1]);
    mes = Number(m[2]);
    dia = Number(m[3]);
  } else if (formato === "mdy") {
    mes = Number(m[1]);
    dia = Number(m[2]);
    anio = Number(m[3]);
  } else {
    dia = Number(m[1]);
    mes = Number(m[2]);
    anio = Number(m[3]);
  }

  // Un año de dos cifras: 70 y arriba es del siglo pasado, el resto de este.
  if (anio < 100) anio += anio >= 70 ? 1900 : 2000;

  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  // Que la fecha exista de verdad: el 31 de febrero no.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return null;

  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/**
 * Propuesta de emparejamiento de columnas, para no obligar a nadie a
 * configurarlo desde cero. Es una propuesta: la pantalla la deja corregir.
 */
export type Emparejado = { fecha: number; concepto: number; importe: number };

export function proponerColumnas(cabecera: string[], filas: string[][]): Emparejado {
  const titulos = cabecera.map((c) => c.trim().toLowerCase());

  const porTitulo = (agujas: string[], evitar: string[] = []) =>
    titulos.findIndex((t) => agujas.some((a) => t.includes(a)) && !evitar.some((e) => t.includes(e)));

  // El saldo se evita explícitamente: es una columna de importes perfectamente
  // válida que no es ningún movimiento, y elegirla importaría el saldo de la
  // cuenta como si fuera un gasto.
  let importe = porTitulo(["importe", "cantidad", "amount"], ["saldo", "balance"]);
  let fecha = porTitulo(["fecha", "date"], ["valor"]);
  if (fecha === -1) fecha = porTitulo(["fecha", "date"]);
  let concepto = porTitulo(["concepto", "descripción", "descripcion", "detalle", "movimiento"]);

  // Sin cabeceras reconocibles, se mira el contenido.
  const muestra = filas.slice(0, 20);
  const columnas = cabecera.length;

  const cuantosCumplen = (col: number, prueba: (v: string) => boolean) =>
    muestra.filter((f) => f[col] !== undefined && prueba(f[col])).length;

  if (fecha === -1) {
    for (let c = 0; c < columnas; c++) {
      if (cuantosCumplen(c, (v) => detectarFormatoFecha([v]) !== null) > muestra.length / 2) {
        fecha = c;
        break;
      }
    }
  }

  if (importe === -1) {
    // De las columnas numéricas se prefiere la que tiene valores negativos: el
    // saldo casi nunca los tiene y los gastos sí.
    let mejor = -1;
    let mejorNegativos = -1;
    for (let c = 0; c < columnas; c++) {
      if (c === fecha) continue;
      const numericos = cuantosCumplen(c, (v) => parseAmountToCents(v) !== null && v.trim() !== "");
      if (numericos <= muestra.length / 2) continue;
      const negativos = cuantosCumplen(c, (v) => (parseAmountToCents(v) ?? 0) < 0);
      if (negativos > mejorNegativos) {
        mejorNegativos = negativos;
        mejor = c;
      }
    }
    importe = mejor;
  }

  if (concepto === -1) {
    // El texto más largo que no sea la fecha ni el importe.
    let mejor = -1;
    let mejorLargo = -1;
    for (let c = 0; c < columnas; c++) {
      if (c === fecha || c === importe) continue;
      const largo =
        muestra.reduce((suma, f) => suma + (f[c]?.trim().length ?? 0), 0) / (muestra.length || 1);
      if (largo > mejorLargo) {
        mejorLargo = largo;
        mejor = c;
      }
    }
    concepto = mejor;
  }

  return { fecha, concepto, importe };
}

/** Los mismos límites que impone `tx_date_sane` en la base. */
const LIMITE_ANTIGUO = "2000-01-01";

function limiteFuturo(): string {
  return addDays(hoyMadrid(), 400);
}

export type FilaLeida = {
  linea: number;
  occurred_on: string;
  description: string;
  amount_cents: number;
};

export type Lectura = {
  filas: FilaLeida[];
  /** Líneas que no se pudieron leer, con el motivo, para poder enseñarlas. */
  descartadas: { linea: number; motivo: string; texto: string }[];
  ambiguedadDeFecha: boolean;
};

/**
 * Convierte las filas de texto en movimientos, o explica por qué no.
 *
 * Nada de esto asume que el fichero está bien: un extracto trae líneas de
 * cabecera, de totales y de saldo inicial que no son movimientos. Se descartan
 * y se cuentan, para que quien importa vea que se han descartado en lugar de
 * preguntarse por qué faltan tres apuntes.
 */
export function leerFilas(
  filas: string[][],
  columnas: Emparejado,
  opciones: { conCabecera: boolean; todoGasto: boolean },
): Lectura {
  const cuerpo = opciones.conCabecera ? filas.slice(1) : filas;
  const desplazamiento = opciones.conCabecera ? 2 : 1;

  const deteccion = detectarFormatoFecha(cuerpo.map((f) => f[columnas.fecha] ?? ""));
  const formato = deteccion?.formato ?? "dmy";

  const leidas: FilaLeida[] = [];
  const descartadas: Lectura["descartadas"] = [];

  cuerpo.forEach((fila, i) => {
    const linea = i + desplazamiento;
    const texto = fila.join(" · ").slice(0, 120);

    const fechaCruda = fila[columnas.fecha] ?? "";
    const importeCrudo = fila[columnas.importe] ?? "";

    const occurred_on = parseFecha(fechaCruda, formato);
    if (!occurred_on) {
      descartadas.push({ linea, motivo: "La fecha no se entiende", texto });
      return;
    }

    // La base rechaza fechas fuera de este rango, y con razón: una fecha
    // absurda descuadra los meses para siempre. Se filtran aquí para poder
    // decir qué línea era, en lugar de que la restricción tumbe el fichero
    // entero por un apunte de 1998.
    if (occurred_on < LIMITE_ANTIGUO || occurred_on > limiteFuturo()) {
      descartadas.push({ linea, motivo: `Fecha fuera de rango (${occurred_on})`, texto });
      return;
    }

    const cents = parseAmountToCents(importeCrudo);
    if (cents === null) {
      descartadas.push({ linea, motivo: "El importe no se entiende", texto });
      return;
    }
    if (cents === 0) {
      descartadas.push({ linea, motivo: "Importe de cero", texto });
      return;
    }

    // El signo decide si es gasto o ingreso, y se conserva tal cual: quien
    // recibe estas filas es quien sabe que el importe se guarda en positivo.
    const amount_cents = opciones.todoGasto ? -Math.abs(cents) : cents;

    leidas.push({
      linea,
      occurred_on,
      description: (fila[columnas.concepto] ?? "").trim().slice(0, 200),
      amount_cents,
    });
  });

  return { filas: leidas, descartadas, ambiguedadDeFecha: deteccion?.ambiguo ?? false };
}
