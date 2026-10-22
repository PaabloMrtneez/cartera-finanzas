"use client";

import { DEFAULT_THEME, THEME_COLOR, THEME_KEY } from "@/lib/theme";

/**
 * Se ejecuta antes del primer pintado para que no haya destello de tema claro
 * al cargar en modo oscuro. Tiene que ser un script en línea y síncrono: por eso
 * no es un componente de cliente con useEffect, que correría demasiado tarde.
 */
/*
 * Además del atributo, pone las etiquetas `theme-color` (que van antes en el
 * <head>) del color del tema que se va a ver: ver `pintarColorDeSistema`.
 */
const script = `(function(){try{
var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||${JSON.stringify(DEFAULT_THEME)};
var d=document.documentElement;
var r=t==="auto"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):t;
d.setAttribute("data-theme",r);
var c=${JSON.stringify(THEME_COLOR)}[r];
var m=document.querySelectorAll('meta[name="theme-color"]');
for(var i=0;i<m.length;i++){m[i].setAttribute("content",c);}
}catch(e){
var d2=document.documentElement;
d2.setAttribute("data-theme",${JSON.stringify(DEFAULT_THEME === "auto" ? "light" : DEFAULT_THEME)});
}})();`;

export function ThemeScript({ nonce }: { nonce?: string }) {
  /*
    El `type` cambia según dónde se renderice, y no es un capricho.

    React avisa por consola cuando un componente produce una etiqueta `<script>`,
    porque un script insertado por el DOM NO se ejecuta: si React rehiciera este
    nodo en el cliente, el script no correría y el aviso estaría señalando un
    problema de verdad.

    Aquí no lo hay —esto solo tiene que correr mientras el navegador analiza el
    HTML, y para eso ya está—, así que en el cliente se marca `text/plain`: deja
    de ser un script para el navegador, React deja de avisar, y en el servidor
    sale como JavaScript de verdad. `suppressHydrationWarning` es lo que hace
    que esa diferencia de `type` no cuente como error de hidratación.

    Y POR ESO ESTO ES UN COMPONENTE DE CLIENTE. En uno de servidor `window` es
    siempre `undefined`, así que el `type` sería siempre `text/javascript` y el
    aviso seguiría saliendo: el cliente reconstruye la etiqueta desde el payload
    y ve un script de verdad. Es la receta de la guía de Next «Preventing flash
    before hydration», y allí también va sobre un componente de cliente.

    El `nonce` lo pone el proxy en cada petición y lo lee la raíz de las páginas.
    Sin él, la CSP estricta (`script-src 'nonce-…' 'strict-dynamic'`, sin
    `'unsafe-inline'`) bloquearía este script en línea y volvería el destello de
    tema. En rutas que no pasan por el proxy —la página sin conexión— llega
    `undefined`, y ahí tampoco hay CSP de script que lo bloquee.
  */
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
