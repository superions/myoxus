/**
 * INV-ES-DIAC-1: High-frequency Spanish words missing their diacritics.
 *                Bare "sesion", "administracion", "version", "electronico",
 *                "sincronizacion", "dias" etc. are all treated as translation
 *                bugs. This is the post-P123-C-01 baseline: zero occurrences
 *                in es.json. If CI ever reports >0 for any of these, a
 *                translation has regressed and must be corrected.
 *
 * INV-ES-DIAC-2: Template placeholders must stay ASCII. Fixing "version" →
 *                "versión" elsewhere in a string must never touch `{{version}}`.
 */
import { describe, expect, test } from "vitest";

import es from "./resources/es.json";

const values = Object.values(es as Record<string, string>);
const entries = Object.entries(es as Record<string, string>);

// JS `\b` treats accented chars as word-boundaries, so /\bseleccion\b/ would
// match "seleccion" inside "seleccionó". Wrap each bare-word pattern with
// explicit Latin-letter boundaries instead.
const LATIN = "A-Za-zÀ-ÿ";
const bare = (stem: string): RegExp =>
  new RegExp(`(?<![${LATIN}])${stem}(?![${LATIN}])`);

const countMatches = (pattern: RegExp): string[] =>
  values.filter((v) => pattern.test(v));

const guards: Array<[string, RegExp]> = [
  // -ción family
  ["aplicacion (→ aplicación)", bare("[Aa]plicacion")],
  ["configuracion (→ configuración)", bare("[Cc]onfiguracion")],
  ["eliminacion (→ eliminación)", bare("[Ee]liminacion")],
  ["creacion (→ creación)", bare("[Cc]reacion")],
  ["notificacion (→ notificación)", bare("[Nn]otificacion")],
  ["informacion (→ información)", bare("[Ii]nformacion")],
  ["actualizacion (→ actualización)", bare("[Aa]ctualizacion")],
  ["autenticacion (→ autenticación)", bare("[Aa]utenticacion")],
  ["autorizacion (→ autorización)", bare("[Aa]utorizacion")],
  ["validacion (→ validación)", bare("[Vv]alidacion")],
  ["verificacion (→ verificación)", bare("[Vv]erificacion")],
  ["modificacion (→ modificación)", bare("[Mm]odificacion")],
  ["invitacion (→ invitación)", bare("[Ii]nvitacion")],
  ["generacion (→ generación)", bare("[Gg]eneracion")],
  ["integracion (→ integración)", bare("[Ii]ntegracion")],
  ["sincronizacion (→ sincronización)", bare("[Ss]incronizacion")],
  ["operacion (→ operación)", bare("[Oo]peracion")],
  ["seleccion (→ selección)", bare("[Ss]eleccion")],
  ["opcion (→ opción)", bare("[Oo]pcion")],
  ["edicion (→ edición)", bare("[Ee]dicion")],
  ["coleccion (→ colección)", bare("[Cc]oleccion")],
  ["accion (→ acción)", bare("[Aa]ccion")],
  ["administracion (→ administración)", bare("[Aa]dministracion")],
  ["direccion (→ dirección)", bare("[Dd]ireccion")],
  ["activacion (→ activación)", bare("[Aa]ctivacion")],
  ["exportacion (→ exportación)", bare("[Ee]xportacion")],
  ["importacion (→ importación)", bare("[Ii]mportacion")],
  ["asignacion (→ asignación)", bare("[Aa]signacion")],
  ["revision (→ revisión)", bare("[Rr]evision")],
  ["conexion (→ conexión)", bare("[Cc]onexion")],
  ["sesion (→ sesión)", bare("[Ss]esion")],
  ["descripcion (→ descripción)", bare("[Dd]escripcion")],
  [
    "version (→ versión) outside {{placeholders}}",
    new RegExp(`(?<!\\{\\{)(?<![${LATIN}])[Vv]ersion(?![${LATIN}])(?!\\}\\})`),
  ],
  ["reindexacion (→ reindexación)", bare("[Rr]eindexacion")],
  ["precaucion (→ precaución)", bare("precaucion")],

  // -ía / -ías
  ["dias (→ días)", bare("[Dd]ias")],
  ["categoria (→ categoría)", bare("[Cc]ategoria")],
  ["politica (→ política)", bare("[Pp]olitica")],

  // High-freq misc
  ["numero (→ número)", bare("[Nn]umero")],
  ["codigo (→ código)", bare("[Cc]odigo")],
  ["ultimo/ultima (→ último/última)", bare("[Uu]ltim[oa]s?")],
  ["tambien (→ también)", bare("[Tt]ambien")],
  ["pais (→ país)", bare("[Pp]ais")],
  ["rapido (→ rápido)", bare("[Rr]apid[oa]")],
  ["estan (→ están)", bare("[Ee]stan")],
  ["exito (→ éxito)", bare("[Ee]xito")],
  ["automatico/a (→ automático/a)", bare("[Aa]utomatic[oa]")],
  ["electronico/a (→ electrónico/a)", bare("[Ee]lectronic[oa]")],
  ["despues (→ después)", bare("[Dd]espues")],

  // Verb forms
  ["sera/seran (→ será/serán)", bare("seran?")],
  ["estara (→ estará)", bare("estara")],
  ["podra (→ podrá)", bare("podra")],
];

describe("INV-ES-DIAC-1: es.json is free of pseudo-diacritic bugs", () => {
  test.each(guards)("%s", (_label, pattern) => {
    const hits = countMatches(pattern);
    expect(hits, `${hits.length} string(s) still missing diacritics`).toEqual(
      [],
    );
  });
});

describe("INV-ES-DIAC-2: template placeholders remain ASCII", () => {
  test("no {{placeholder}} contains accented characters", () => {
    const rx = /\{\{[^}]*[áéíóúñÁÉÍÓÚÑ][^}]*\}\}/;
    const hits = entries.filter(([, v]) => rx.test(v));
    expect(
      hits,
      `Placeholders with accents: ${hits.map(([k]) => k).join(", ")}`,
    ).toEqual([]);
  });
});
