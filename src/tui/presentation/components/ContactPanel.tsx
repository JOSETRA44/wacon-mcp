import { Box, Text } from "ink";
import type { AgendaItem } from "../../domain/agenda.js";
import { agendaDayLabel } from "../../domain/agenda.js";
import type { Commitment, ContactInfo } from "../../domain/contact.js";
import { truncate, wrap } from "../../domain/text.js";
import { useTheme } from "../themes.js";
import { Spinner } from "./Spinner.js";

/**
 * Alt+I: what Wacon already knows about this contact — learned facts, the
 * profile's notes, how you write to them, what you promised, what is on
 * the agenda with them. All local: opening it costs no tokens.
 */

interface Props {
  name: string;
  isGroup: boolean;
  info: ContactInfo | null;
  loading: boolean;
  commitments: Commitment[];
  agenda: AgendaItem[];
  hasAgent: boolean;
  width: number;
  height: number;
}

/** memory/facts.ts FACT_CATEGORIES, as a person would say them. */
const CATEGORY: Record<string, string> = {
  identidad: "quién es", ocupacion: "trabajo/estudios", relacion: "relación", fechas: "fechas", gustos: "le gusta",
  disgustos: "no le gusta", contexto: "contexto", salud: "salud", objetivos: "planes",
};

export function ContactPanel({ name, isGroup, info, loading, commitments, agenda, hasAgent, width, height }: Props) {
  const theme = useTheme().c;
  const inner = width - 4;
  type L = { text: string; color?: string; bold?: boolean };
  const lines: L[] = [];
  const head = (t: string) => {
    if (lines.length) lines.push({ text: "" });
    lines.push({ text: t, color: theme.accentSoft, bold: true });
  };
  const add = (t: string, color: string | undefined = theme.text, indent = "") => {
    for (const [i, l] of wrap(t, inner - indent.length).entries()) lines.push({ text: (i === 0 ? indent : " ".repeat(indent.length)) + l, color });
  };

  if (info) {
    if (info.style) add(info.style, theme.muted);
    if (info.tags.length) add(`Etiquetas: ${info.tags.join(", ")}`, theme.muted);
    head("Lo que sé");
    if (info.facts.length === 0) add(hasAgent ? "Aún nada. En el panel de IA usa «Recordar lo importante»." : "Aún nada guardado.", theme.faint);
    for (const f of info.facts.slice(0, 10)) add(`${CATEGORY[f.category] ?? f.category}: ${f.fact}`, theme.text, "• ");
    for (const n of info.notes.slice(0, 3)) {
      head(n.section);
      for (const l of n.lines) add(l, theme.text, "• ");
    }
  }
  if (commitments.length) {
    head("Le prometiste");
    for (const c of commitments.slice(0, 5)) add(`«${c.text}» · hace ${c.ageDays} d`, theme.warn, "⏳ ");
  }
  if (agenda.length) {
    head("En tu agenda");
    for (const a of agenda.slice(0, 5)) {
      const ts = a.kind === "event" ? a.startTs : a.dueTs;
      add(`${ts ? `${agendaDayLabel(ts, Date.now())} · ` : ""}${a.title}`, theme.text, a.kind === "event" ? "📅 " : "☐ ");
    }
  }
  const bodyH = Math.max(1, height - 3);

  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={theme.panel} borderStyle="round" borderColor={theme.accent}>
      <Box paddingX={1}>
        <Text color={theme.text} bold>{truncate(`ⓘ ${name}`, inner - 10)}</Text>
        <Text color={theme.faint}>{isGroup ? "  grupo" : ""}</Text>
        {loading ? (
          <Text>
            {"  "}
            <Spinner color={theme.accent} />
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" paddingX={1} height={bodyH} overflow="hidden">
        {lines.length === 0 && !loading ? <Text color={theme.faint}>{truncate("Wacon todavía no sabe nada de este chat.", inner)}</Text> : null}
        {lines.slice(0, bodyH).map((l, i) => (
          <Text key={i} color={l.color} bold={l.bold}>
            {l.text || " "}
          </Text>
        ))}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.faint}>{truncate("Alt+I o Esc cerrar · solo datos locales, sin gastar tokens", inner)}</Text>
      </Box>
    </Box>
  );
}
