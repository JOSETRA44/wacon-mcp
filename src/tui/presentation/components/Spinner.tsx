import { Text, useAnimation } from "ink";
import { SPINNER } from "../theme.js";

/** Braille spinner. Ink shares one timer across every animated component. */
export function Spinner({ color, active = true }: { color?: string; active?: boolean }) {
  const { frame } = useAnimation({ interval: 80, isActive: active });
  return <Text color={color}>{active ? SPINNER[frame % SPINNER.length] : " "}</Text>;
}

/** "escribiendo" with dots that breathe — WhatsApp's typing cue. */
export function TypingDots({ color }: { color?: string }) {
  const { frame } = useAnimation({ interval: 350 });
  return <Text color={color}>{"escribiendo" + ".".repeat((frame % 3) + 1).padEnd(3)}</Text>;
}
