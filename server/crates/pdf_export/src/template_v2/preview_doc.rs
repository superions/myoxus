// SPDX-License-Identifier: AGPL-3.0-or-later
//! Representative preview content; upload validation keeps its small syntax fixture.

use crate::ir::{
  IrDocument,
  block::{
    AssetData, BlobRef, Block, CalloutVariant, CodeBlock, HeadingLevel, ImageRef, ListType, TableCell, TableRow,
  },
  inline::{InlineSpan, TextMarks},
};

use super::stub_doc::build_stub_doc;

struct PreviewCopy {
  title: &'static str,
  headings: [&'static str; 10],
  paragraphs: [&'static str; 10],
  notes: [&'static str; 4],
  labels: [&'static str; 8],
}

fn copy(locale: &str) -> PreviewCopy {
  match locale.split(['-', '_']).next().unwrap_or("en") {
    "de" => PreviewCopy {
      title: "Projektbericht – Template-Vorschau",
      headings: [
        "1. Zusammenfassung",
        "Rahmen und Zielsetzung",
        "Beobachtungen aus der Praxis",
        "Abhängigkeiten und Risiken",
        "Qualität im Detail",
        "Hinweis zur Einordnung",
        "2. Ergebnisse und Bewertung",
        "3. Planung und Zusammenarbeit",
        "4. Abbildungen und technische Inhalte",
        "5. Ausblick und Quellen",
      ],
      paragraphs: [
        "Dieser Beispielbericht zeigt, wie ein längeres Dokument mit der ausgewählten Vorlage wirkt. Er verbindet fortlaufenden Text mit einer klaren Gliederung, nachvollziehbaren Ergebnissen und ergänzenden Anmerkungen. Beurteile nicht nur die erste Überschrift: Wichtig sind auch lesbare Absätze, ruhige Übergänge und ausreichend Platz für Fußnoten am unteren Seitenrand. Alle Angaben sind fiktiv und dienen ausschließlich der Layoutbeurteilung.",
        "Ein gemeinsamer Bericht muss für unterschiedliche Leser verständlich bleiben. Die Zusammenfassung vermittelt die Entscheidung, während die folgenden Abschnitte den Weg dorthin erläutern. Längere Absätze machen Zeilenlänge, Blocksatz und Trennungen sichtbar. Beim Vergleich mehrerer Vorlagen sollte derselbe Inhalt deshalb unterschiedlich gestaltet, aber weder verkürzt noch in seiner Bedeutung verändert erscheinen. Seitenkopf, Seitenfuß und Nummerierung begleiten den gesamten Text.",
        "Im ersten Arbeitsabschnitt wurden vorhandene Unterlagen gesichtet und offene Fragen gesammelt. Danach hat das Team Beobachtungen geordnet, Annahmen kenntlich gemacht und konkrete nächste Schritte vereinbart. Die Rückmeldungen waren überwiegend positiv, enthielten aber auch widersprüchliche Erwartungen. Gerade solche Unterschiede gehören in einen brauchbaren Bericht: Sie erklären, warum eine Entscheidung getroffen wurde und welche Punkte später erneut geprüft werden sollten.",
        "Abhängigkeiten werden früh besprochen, damit ein fehlender Beitrag nicht erst kurz vor dem Abschluss auffällt. Für jede offene Frage gibt es einen Ansprechpartner, einen überprüfbaren nächsten Schritt und einen vereinbarten Termin. Dieser Abschnitt enthält bewusst mehrere vollständige Sätze. So lässt sich erkennen, ob die Vorlage lange Gedanken gut lesbar setzt und die zugehörige Anmerkung auf derselben Seite unterbringt.",
        "Qualität entsteht nicht durch möglichst viele Hervorhebungen. Eine gute Vorlage unterscheidet wichtige Aussagen, zusätzliche Erläuterungen und technische Bezeichnungen auf zurückhaltende Weise. Auch kleine Überschriften müssen zum Fließtext passen. Prüfe den Abstand vor und nach diesem Abschnitt, die Wirkung kurzer Zeilen und das Zusammenspiel mit dem folgenden Text. Die Hierarchie soll auch ohne zusätzliche Farben verständlich bleiben.",
        "Diese sechste Überschriftenebene ist eine bewusst seltene Vertiefung. Im Alltag sollten Dokumente so einfach wie möglich gegliedert sein. Die Vorschau zeigt sie dennoch, damit sich Schriftgröße, Gewicht und Abstände aller unterstützten Ebenen beurteilen lassen. Der Inhalt bleibt gewöhnlicher Text und wird durch die Vorlage formatiert. Dadurch werden auch unerwünschte Umbrüche zwischen einer Überschrift und ihrem ersten Absatz sichtbar.",
        "Die folgende Tabelle stellt mehrere Ergebnisse mit unterschiedlich langen Erläuterungen gegenüber. Ihre Zellen sollen umbrechen können, ohne benachbarte Inhalte zu verdecken. Ein Bericht benötigt außerdem eine erkennbare Kopfzeile und eine zum Fließtext passende Schrift. Die Zahlen sind Beispiele; sie dienen nicht als Leistungsversprechen. Vergleiche insbesondere die Ausrichtung, den Abstand innerhalb der Zellen und die Lesbarkeit der ausführlichsten Beschreibung.",
        "Für die nächste Etappe werden Aufgaben in einer sinnvollen Reihenfolge zusammengeführt. Die nummerierte Liste beschreibt den Ablauf; untergeordnete Aufzählungen ergänzen konkrete Arbeitsschritte. Die Aufgabenliste unterscheidet bereits erledigte und noch offene Punkte. Eine kurze Erläuterung bleibt im normalen Text, damit Listen nicht zu einem zweiten Dokument werden. Das Zitat fasst die gemeinsame Leitlinie zusammen und soll sich erkennbar, aber ruhig vom übrigen Inhalt abheben.",
        "Abbildungen, Quellcode und Formeln haben andere Anforderungen als Fließtext. Die Grafik muss mit ihrem Seitenverhältnis vollständig erhalten bleiben, während längere Codezeilen eine nachvollziehbare Darstellung benötigen. Eine Bildunterschrift gehört zur Abbildung und sollte nicht allein auf der nächsten Seite stehen. Die mathematische Schreibweise enthält sowohl einen Ausdruck im Satz als auch eine abgesetzte Formel. Beide sollen sich typografisch in den Bericht einfügen.",
        "Zum Abschluss werden die wichtigsten offenen Fragen und nächsten Entscheidungen festgehalten. Ein längerer Bericht soll auch nach mehreren Seiten zusammenhängend wirken: Überschriften, Tabellen, Anmerkungen und gewöhnliche Absätze müssen dieselbe visuelle Sprache sprechen. Prüfe deshalb auch die letzte Seite und nicht nur den Einstieg. Die abschließende Endnote enthält ergänzende Hintergrundinformationen, die den Lesefluss nicht unterbrechen sollen und über ihren Verweis erreichbar bleiben.",
      ],
      notes: [
        "Fußnote zur Zusammenfassung: Diese Anmerkung zeigt kleinere Schrift, einen längeren Zeilenumbruch und den Abstand zum Haupttext. Sie ist Teil des Dokuments und keine zusätzliche Bedienoberfläche.",
        "Fußnote zu den Risiken: Annahmen und offene Fragen müssen beim Lesen erkennbar bleiben. Eine Anmerkung kann außerdem einen Quellenlink und hervorgehobenen Text enthalten.",
        "Fußnote zur Planung: Die Reihenfolge ist ein Beispiel. Termine und Verantwortlichkeiten werden im tatsächlichen Bericht durch die jeweiligen Inhalte ersetzt.",
        "Endnote: Diese ergänzende Erläuterung steht nach dem Haupttext. Sie dient dazu, die Darstellung von Endnoten und den zugehörigen Verweis in einer mehrseitigen Vorlage zu beurteilen.",
      ],
      labels: [
        "Bereich",
        "Ergebnis",
        "Einordnung",
        "Grundlagen klären",
        "Ergebnisse gemeinsam prüfen",
        "Nächste Schritte festhalten",
        "Eine klare Struktur unterstützt Entscheidungen und lässt Raum für begründete Abweichungen.",
        "Abbildung: beispielhafte Verteilung der Arbeitsschritte",
      ],
    },
    "fr" => PreviewCopy {
      title: "Rapport de projet – Aperçu du modèle",
      headings: [
        "1. Synthèse",
        "Contexte et objectifs",
        "Observations pratiques",
        "Dépendances et risques",
        "La qualité dans le détail",
        "Précision méthodologique",
        "2. Résultats et évaluation",
        "3. Planification et collaboration",
        "4. Illustrations et contenu technique",
        "5. Perspectives et sources",
      ],
      paragraphs: [
        "Ce rapport fictif montre la présentation d’un document long avec le modèle sélectionné. Il associe un texte suivi, une structure claire, des résultats et des remarques complémentaires. Ne vous limitez pas au premier titre : examinez aussi la lisibilité des paragraphes, les transitions et la place réservée aux notes de bas de page. Les informations servent uniquement à évaluer la mise en page.",
        "Un rapport commun doit rester compréhensible pour différents lecteurs. La synthèse présente la décision, puis les sections suivantes expliquent le raisonnement. Les paragraphes longs révèlent la longueur des lignes, la justification et les coupures de mots. Lors de la comparaison des modèles, le même contenu doit conserver son sens. Les en-têtes, pieds de page et numéros accompagnent l’ensemble du texte.",
        "L’équipe a commencé par examiner les documents disponibles et recueillir les questions ouvertes. Elle a ensuite organisé ses observations, explicité ses hypothèses et défini les étapes suivantes. Les retours ont été positifs, mais certaines attentes restaient contradictoires. Un rapport utile rend ces différences visibles afin d’expliquer les décisions et d’identifier les points qui devront être réexaminés plus tard.",
        "Les dépendances sont abordées suffisamment tôt pour éviter les découvertes de dernière minute. Chaque question ouverte possède un responsable, une prochaine action vérifiable et une échéance convenue. Ce passage comporte volontairement plusieurs phrases complètes. Il permet d’observer la présentation d’un raisonnement développé et de vérifier que la note associée trouve une place lisible au bas de la page.",
        "La qualité ne dépend pas du nombre de passages mis en évidence. Un bon modèle distingue les affirmations importantes, les explications et les termes techniques avec mesure. Les petits titres doivent eux aussi s’intégrer au texte courant. Examinez les espaces avant et après cette section ainsi que les lignes courtes. La hiérarchie doit rester compréhensible sans multiplier les couleurs.",
        "Ce sixième niveau de titre illustre une précision rarement nécessaire. Dans les documents courants, une structure simple reste préférable. Il figure ici pour permettre l’évaluation de la taille, de la graisse et de l’espacement de tous les niveaux pris en charge. Le modèle conserve la responsabilité de la présentation et doit éviter qu’un titre soit séparé de son premier paragraphe.",
        "Le tableau suivant compare plusieurs résultats dont les explications ont des longueurs différentes. Les cellules doivent autoriser les retours à la ligne sans masquer le contenu voisin. Une ligne d’en-tête identifiable facilite la lecture. Les chiffres ne constituent aucune promesse de performance. Comparez surtout l’alignement, l’espace intérieur et la lisibilité de la description la plus détaillée avec le texte du rapport.",
        "La prochaine étape rassemble les tâches dans un ordre cohérent. La liste numérotée présente le déroulement et les sous-listes apportent des précisions. Les cases à cocher distinguent les actions terminées des points encore ouverts. Une courte explication reste dans le texte courant. La citation exprime une orientation commune ; elle doit être identifiable sans dominer visuellement le reste du document.",
        "Les illustrations, le code source et les formules ont des contraintes différentes du texte courant. Le graphique doit conserver ses proportions et rester complet. La légende appartient à l’illustration et ne devrait pas se retrouver seule sur la page suivante. Le code doit être lisible. Une expression mathématique dans la phrase et une formule séparée montrent leur intégration à la typographie générale.",
        "La conclusion rassemble les questions restantes et les prochaines décisions. Après plusieurs pages, le rapport doit toujours présenter un ensemble cohérent. Titres, tableaux, notes et paragraphes ordinaires suivent le même langage visuel. Examinez aussi la dernière page. La note finale apporte un complément qui ne doit pas interrompre la lecture et doit rester accessible depuis son renvoi dans le texte.",
      ],
      notes: [
        "Note de bas de page : cette remarque montre une police plus petite, le retour à la ligne et la distance avec le texte principal. Elle fait partie du document.",
        "Note sur les risques : les hypothèses doivent rester visibles. Une note peut contenir un lien vers une source et du texte mis en évidence.",
        "Note sur la planification : cet ordre est un exemple. Le rapport réel fournit ses propres échéances et responsabilités.",
        "Note finale : cette précision suit le texte principal. Elle permet d’évaluer les notes de fin et leur renvoi dans un modèle de plusieurs pages.",
      ],
      labels: [
        "Domaine",
        "Résultat",
        "Évaluation",
        "Clarifier les bases",
        "Examiner les résultats ensemble",
        "Définir les prochaines étapes",
        "Une structure claire facilite les décisions et laisse une place aux écarts justifiés.",
        "Illustration : répartition indicative des étapes de travail",
      ],
    },
    "es" => PreviewCopy {
      title: "Informe de proyecto – Vista previa de la plantilla",
      headings: [
        "1. Resumen",
        "Contexto y objetivos",
        "Observaciones prácticas",
        "Dependencias y riesgos",
        "La calidad en detalle",
        "Nota metodológica",
        "2. Resultados y evaluación",
        "3. Planificación y colaboración",
        "4. Ilustraciones y contenido técnico",
        "5. Perspectivas y fuentes",
      ],
      paragraphs: [
        "Este informe ficticio muestra cómo presenta un documento largo la plantilla seleccionada. Combina texto continuo, una estructura clara, resultados y comentarios complementarios. No revises solo el primer título: comprueba también la legibilidad de los párrafos, las transiciones y el espacio reservado a las notas al pie. Los datos se utilizan únicamente para evaluar la composición de las páginas del documento.",
        "Un informe compartido debe resultar comprensible para distintos lectores. El resumen presenta la decisión y los apartados posteriores explican el razonamiento. Los párrafos largos permiten valorar la longitud de las líneas, la justificación y la división de palabras. Al comparar plantillas, el contenido debe conservar su significado. Los encabezados, pies de página y números acompañan al texto a lo largo del informe.",
        "El equipo comenzó revisando la documentación disponible y reuniendo las preguntas abiertas. Después ordenó las observaciones, hizo explícitas sus hipótesis y acordó los siguientes pasos. Las respuestas fueron positivas, aunque algunas expectativas seguían siendo contradictorias. Un informe útil muestra esas diferencias para explicar las decisiones e identificar los asuntos que deberán revisarse en una fase posterior del trabajo.",
        "Las dependencias se comentan con antelación para evitar descubrimientos de última hora. Cada pregunta abierta tiene una persona responsable, una siguiente acción verificable y un plazo acordado. Este apartado contiene varias frases completas de forma deliberada. Así se puede observar la presentación de un razonamiento extenso y comprobar que su nota asociada dispone de un espacio legible al pie de la página.",
        "La calidad no depende de destacar el mayor número posible de frases. Una buena plantilla distingue con moderación las afirmaciones principales, las explicaciones y los términos técnicos. Los títulos pequeños también deben integrarse en el texto. Comprueba el espacio anterior y posterior a este apartado y la apariencia de las líneas cortas. La jerarquía debe entenderse sin recurrir a colores adicionales.",
        "Este sexto nivel de título representa un detalle que rara vez resulta necesario. En los documentos habituales conviene mantener una estructura sencilla. Aquí permite evaluar el tamaño, el grosor y los espacios de todos los niveles disponibles. La plantilla sigue siendo responsable de la composición y debe evitar que un título quede separado de su primer párrafo en otra página.",
        "La tabla siguiente compara varios resultados con explicaciones de distinta longitud. Las celdas deben permitir saltos de línea sin ocultar el contenido vecino. Una cabecera reconocible facilita la lectura. Las cifras son ejemplos y no representan promesas de rendimiento. Compara la alineación, el espacio interior y la legibilidad de la explicación más extensa con el resto del texto del informe.",
        "La próxima etapa reúne las tareas en un orden coherente. La lista numerada describe el proceso y las sublistas añaden acciones concretas. Las casillas distinguen los puntos terminados de los pendientes. Una explicación breve permanece en el texto normal para que la lista no se convierta en otro documento. La cita resume una orientación compartida y debe destacar de forma discreta.",
        "Las ilustraciones, el código fuente y las fórmulas tienen requisitos diferentes a los del texto continuo. El gráfico debe conservar sus proporciones y mostrarse completo. Su leyenda no debería aparecer sola en la página siguiente. El código debe seguir siendo legible. Una expresión matemática dentro de la frase y otra fórmula independiente permiten comprobar su integración en la tipografía general del informe.",
        "La conclusión reúne las preguntas pendientes y las próximas decisiones. Tras varias páginas, el informe debe seguir formando un conjunto coherente. Los títulos, tablas, notas y párrafos comparten el mismo lenguaje visual. Revisa también la última página. La nota final añade información que no debe interrumpir la lectura y que debe seguir siendo accesible mediante su referencia en el texto.",
      ],
      notes: [
        "Nota al pie del resumen: este comentario muestra una letra más pequeña, el salto de línea y la distancia respecto al texto principal. Forma parte del documento.",
        "Nota sobre los riesgos: las hipótesis deben seguir siendo visibles. Una nota también puede contener un enlace a una fuente y texto destacado.",
        "Nota sobre la planificación: el orden es un ejemplo. El informe real aporta sus propios plazos y responsabilidades.",
        "Nota final: esta explicación aparece después del texto principal y permite evaluar las notas finales y sus referencias en una plantilla de varias páginas.",
      ],
      labels: [
        "Área",
        "Resultado",
        "Evaluación",
        "Aclarar las bases",
        "Revisar juntos los resultados",
        "Definir los siguientes pasos",
        "Una estructura clara facilita las decisiones y permite desviaciones justificadas.",
        "Ilustración: distribución de ejemplo de las etapas de trabajo",
      ],
    },
    _ => PreviewCopy {
      title: "Project report – Template preview",
      headings: [
        "1. Executive summary",
        "Context and objectives",
        "Observations from practice",
        "Dependencies and risks",
        "Quality in detail",
        "A note on interpretation",
        "2. Results and assessment",
        "3. Planning and collaboration",
        "4. Figures and technical content",
        "5. Outlook and references",
      ],
      paragraphs: [
        "This sample report shows how a longer document looks in the selected template. It combines continuous text with a clear structure, traceable results and supporting notes. Look beyond the first heading: readable paragraphs, calm transitions and enough space for footnotes at the bottom of the page matter just as much. All information is fictional and is provided only to assess the document layout.",
        "A shared report must remain understandable to different readers. The summary presents the decision, while the following sections explain the reasoning. Longer paragraphs reveal line length, justification and hyphenation. When comparing templates, the same content should therefore retain its meaning rather than be shortened to fit. Headers, footers and page numbers accompany the text throughout the report and should remain consistent on later pages.",
        "The team began by reviewing existing material and collecting open questions. It then grouped observations, made assumptions explicit and agreed on concrete next steps. Feedback was broadly positive, but some expectations remained contradictory. A useful report makes those differences visible: they explain why a decision was made and identify the issues that should be reviewed again at a later stage of the work.",
        "Dependencies are discussed early so that a missing contribution does not become a surprise just before completion. Every open question has an owner, a verifiable next action and an agreed review date. This section deliberately contains several complete sentences. It shows whether the template can present a developed argument clearly and keep the supporting note readable at the bottom of the same page.",
        "Quality does not come from highlighting as many statements as possible. A good template distinguishes important claims, supporting explanations and technical terms with restraint. Smaller headings must also fit the body text. Review the space before and after this section, the appearance of short lines and the transition into the next paragraph. The hierarchy should remain understandable without relying on additional colors.",
        "This sixth heading level represents a detail that is rarely necessary in an ordinary report. Everyday documents should keep their structure as simple as possible. It appears here so that the size, weight and spacing of every supported level can be assessed. The template remains responsible for presentation and should avoid separating a heading from its first paragraph across a page boundary.",
        "The following table compares several results with explanations of different lengths. Its cells should wrap without obscuring neighboring content. A recognizable header row and type that fits the body text help readers follow the comparison. The figures are examples rather than performance promises. Pay particular attention to alignment, padding within the cells and the readability of the longest explanation in the table.",
        "The next stage brings tasks together in a sensible order. The numbered list describes the process, while nested bullets add concrete actions. The task list distinguishes completed work from open points. A short explanation stays in ordinary prose so that the list does not become a second document. The quotation summarizes a shared principle and should be distinct without overpowering the surrounding content.",
        "Figures, source code and equations have different requirements from body text. The graphic should preserve its proportions and remain fully visible, while longer code lines need a readable presentation. A caption belongs with its figure and should not be stranded on the following page. Mathematical notation appears both inside a sentence and as a separate equation so that both forms can be assessed in the same report.",
        "The conclusion records the remaining questions and the next decisions. A longer report should still feel coherent after several pages: headings, tables, notes and ordinary paragraphs need to share the same visual language. Review the final page as well as the opening. The endnote adds background information that should not interrupt the main argument and should remain accessible from its reference in the text.",
      ],
      notes: [
        "Summary footnote: this note demonstrates smaller type, a longer wrapped line and separation from the main text. It belongs to the document rather than to an additional user interface.",
        "Risk footnote: assumptions and open questions must remain visible. A note may also contain a source link and emphasized text.",
        "Planning footnote: the sequence is an example. A real report supplies its own dates and responsibilities.",
        "Endnote: this additional explanation follows the main text. It demonstrates endnote layout and its reference in a document that spans several pages.",
      ],
      labels: [
        "Area",
        "Result",
        "Assessment",
        "Clarify the foundations",
        "Review the results together",
        "Record the next steps",
        "A clear structure supports decisions and leaves room for justified exceptions.",
        "Figure: illustrative distribution of work stages",
      ],
    },
  }
}

fn text(value: &str) -> InlineSpan {
  InlineSpan::Text {
    text: value.into(),
    marks: TextMarks::default(),
  }
}

fn paragraph(content: Vec<InlineSpan>) -> Block {
  Block::Paragraph {
    content,
    children: vec![],
  }
}

/// Build bounded, deterministic content through the same IR used for real exports.
/// Locale selection changes the sample, never the stored template or document.
pub fn build_preview_doc(locale: &str) -> IrDocument {
  let content = copy(locale);
  let mut doc = build_stub_doc();
  doc.metadata.title = Some(content.title.into());
  doc.metadata.author = None;
  doc.metadata.workspace_name = None;
  doc.metadata.branding.organization_name = None;
  doc.options.locale = locale.into();

  let levels = [
    HeadingLevel::H1,
    HeadingLevel::H2,
    HeadingLevel::H3,
    HeadingLevel::H4,
    HeadingLevel::H5,
    HeadingLevel::H6,
  ];
  let mut blocks = Vec::new();
  for index in 0..10 {
    blocks.push(Block::Heading {
      level: levels.get(index).copied().unwrap_or(HeadingLevel::H1),
      content: vec![text(content.headings[index])],
      children: vec![],
    });
    let mut spans = vec![text(content.paragraphs[index])];
    if let Some(note) = [0, 3, 7].iter().position(|entry| *entry == index) {
      spans.push(InlineSpan::Footnote {
        content: vec![text(content.notes[note])],
      });
    }
    blocks.push(paragraph(spans));
    match index {
      1 => blocks.push(paragraph(vec![
        InlineSpan::Text {
          text: content.labels[3].into(),
          marks: TextMarks {
            bold: Some(true),
            ..Default::default()
          },
        },
        text(" · "),
        InlineSpan::Text {
          text: content.labels[4].into(),
          marks: TextMarks {
            italic: Some(true),
            ..Default::default()
          },
        },
        text(" · "),
        InlineSpan::Text {
          text: content.labels[5].into(),
          marks: TextMarks {
            underline: Some(true),
            ..Default::default()
          },
        },
        text(" · "),
        InlineSpan::Text {
          text: "example.com".into(),
          marks: TextMarks {
            link: Some("https://example.com/".into()),
            ..Default::default()
          },
        },
      ])),
      6 => {
        let mut rows = vec![TableRow {
          cells: content.labels[..3]
            .iter()
            .map(|label| TableCell {
              content: vec![text(label)],
              is_header: true,
              col_span: 1,
              row_span: 1,
              align: None,
              fill: None,
              foreground: None,
            })
            .collect(),
        }];
        for row in 0..6 {
          rows.push(TableRow {
            cells: [
              format!("{} {}", content.labels[0], row + 1),
              format!("{} %", 40 + row * 9),
              content.paragraphs[row]
                .split('.')
                .next()
                .unwrap_or(content.labels[2])
                .into(),
            ]
            .into_iter()
            .map(|value| TableCell {
              content: vec![text(&value)],
              is_header: false,
              col_span: 1,
              row_span: 1,
              align: None,
              fill: None,
              foreground: None,
            })
            .collect(),
          });
        }
        blocks.push(Block::Table {
          rows,
          caption: Some(vec![text(content.headings[6])]),
          column_widths: None,
          header_rows: Some(1),
          appearance: None,
          density: None,
        });
      }
      7 => {
        for index in 3..6 {
          blocks.push(Block::List {
            list_type: ListType::Numbered,
            content: vec![text(content.labels[index])],
            checked: false,
            children: vec![Block::List {
              list_type: ListType::Bulleted,
              content: vec![text(content.notes[2])],
              checked: false,
              children: vec![],
            }],
          });
        }
        for checked in [true, false] {
          blocks.push(Block::List {
            list_type: ListType::Todo,
            content: vec![text(content.labels[if checked { 4 } else { 5 }])],
            checked,
            children: vec![],
          });
        }
        blocks.push(Block::Quote {
          content: vec![text(content.labels[6])],
          children: vec![],
        });
        blocks.push(Block::Callout {
          variant: CalloutVariant::Note,
          emoji: None,
          content: vec![text(content.notes[2])],
          children: vec![],
        });
      }
      8 => {
        let primary = doc.metadata.branding.primary.as_deref().unwrap_or("currentColor");
        let svg = format!(
          r#"<svg xmlns="http://www.w3.org/2000/svg" width="480" height="100" viewBox="0 0 480 100"><g fill="{primary}"><rect x="0" y="10" width="100" height="80" rx="8"/><rect x="120" y="10" width="150" height="80" rx="8" opacity="0.7"/><rect x="290" y="10" width="190" height="80" rx="8" opacity="0.4"/></g></svg>"#
        );
        let asset = AssetData {
          mime: "image/svg+xml".into(),
          bytes: svg.into_bytes(),
          filename: Some("preview-stages.svg".into()),
        };
        doc.assets.clear();
        doc.assets.insert("preview-stages".into(), asset.clone());
        blocks.push(Block::Image(ImageRef {
          blob: BlobRef {
            blob_id: "preview-stages".into(),
            mime_hint: Some(asset.mime.clone()),
          },
          caption: Some(vec![text(content.labels[7])]),
          width_hint: Some(480.0),
          height_hint: Some(100.0),
          data: Some(asset),
        }));
        blocks.push(Block::Code(CodeBlock { language: Some("rust".into()), code: "struct Milestone {\n    title: String,\n    complete: bool,\n}\n\nfn completed(items: &[Milestone]) -> usize {\n    items.iter().filter(|item| item.complete).count()\n}".into(), caption: None }));
        blocks.push(paragraph(vec![InlineSpan::Latex {
          source: "a^2 + b^2 = c^2".into(),
        }]));
        blocks.push(Block::LatexBlock {
          source: "sum_(i=1)^n i = (n (n + 1)) / 2".into(),
        });
      }
      9 => {
        blocks.push(paragraph(vec![
          text(content.labels[6]),
          InlineSpan::LocalFootnote {
            definition_id: "preview-endnote".into(),
            placement: yjs::footnote::FootnotePlacement::Endnote,
            number: Some(1),
            reference_index: 1,
            references: 1,
            locale: locale.into(),
            body: None,
          },
        ]));
        blocks.push(Block::LocalNoteDefinition {
          definition_id: "preview-endnote".into(),
          placement: yjs::footnote::FootnotePlacement::Endnote,
          number: Some(1),
          references: 1,
          children: vec![paragraph(vec![text(content.notes[3])])],
        });
      }
      _ => {}
    }
  }
  doc.root = Block::Page {
    title: vec![text(content.title)],
    children: blocks,
  };
  doc
}
