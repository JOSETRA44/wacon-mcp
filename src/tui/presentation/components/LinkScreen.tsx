import { useMemo, type ReactNode } from "react";
import { Box, Text } from "ink";
import qrcodeTerminal from "qrcode-terminal";
import type { UltraState } from "../../application/controller.js";
import { theme } from "../theme.js";
import { Spinner } from "./Spinner.js";

function renderQr(qr: string): string[] {
  let art = "";
  // qrcode-terminal calls back synchronously.
  qrcodeTerminal.generate(qr, { small: true }, (s: string) => (art = s));
  return art.replace(/\r/g, "").split("\n").filter((l, i, a) => l.length > 0 || i < a.length - 1);
}

/**
 * First-run / lost-session screen, laid out like WhatsApp Web's: the steps
 * on one side, the code on the other. The QR refreshes in place as WhatsApp
 * rotates it, and the app continues by itself the moment it is scanned.
 */
export function LinkScreen({ link, width, height }: { link: UltraState["link"]; width: number; height: number }) {
  const qrLines = useMemo(() => (link.qr ? renderQr(link.qr) : []), [link.qr]);
  const qrW = qrLines.reduce((n, l) => Math.max(n, l.length), 0);
  const fits = qrLines.length + 6 <= height && qrW + 4 <= width;
  const sideBySide = width >= qrW + 56;

  const steps = (
    <Box flexDirection="column" width={sideBySide ? 48 : Math.min(60, width - 4)} marginRight={sideBySide ? 4 : 0}>
      <Text color={theme.text} bold>Usa WhatsApp en tu terminal</Text>
      <Text> </Text>
      <Text color={theme.muted}>1. Abre WhatsApp en tu teléfono</Text>
      <Text color={theme.muted}>2. Toca Menú ⋮ o Ajustes</Text>
      <Text color={theme.muted}>3. Elige Dispositivos vinculados</Text>
      <Text color={theme.muted}>4. Toca Vincular un dispositivo</Text>
      <Text color={theme.muted}>5. Apunta la cámara a este código</Text>
      <Text> </Text>
      <Text color={theme.faint}>El código se renueva solo cada ~30 s.</Text>
      <Text color={theme.faint}>Ctrl+C para salir.</Text>
    </Box>
  );

  let right: ReactNode;
  if (link.phase === "error") {
    right = (
      <Box flexDirection="column">
        <Text color={theme.error} bold>No pude hablar con el daemon de Wacon</Text>
        <Text color={theme.muted}>{link.error}</Text>
        <Text color={theme.faint}>Prueba `wacon doctor` en otra terminal.</Text>
      </Box>
    );
  } else if (link.phase === "checking") {
    right = (
      <Text color={theme.muted}>
        <Spinner color={theme.accent} /> Conectando con WhatsApp…
      </Text>
    );
  } else if (!link.qr) {
    right = (
      <Text color={theme.muted}>
        <Spinner color={theme.accent} /> Pidiendo un código a WhatsApp…
      </Text>
    );
  } else if (!fits) {
    right = (
      <Box flexDirection="column">
        <Text color={theme.warn}>La ventana es muy pequeña para el código QR.</Text>
        <Text color={theme.muted}>{`Agrándala a ${qrW + 4}×${qrLines.length + 6} o más (ahora ${width}×${height}),`}</Text>
        <Text color={theme.muted}>o reduce el tamaño de letra con Ctrl + −.</Text>
      </Box>
    );
  } else {
    right = (
      <Box flexDirection="column" paddingX={1} backgroundColor="#ffffff">
        {qrLines.map((l, i) => (
          // Dark modules on white, exactly as phones expect to scan.
          <Text key={i} color="#000000" backgroundColor="#ffffff">
            {l.replace(/[█▀▄ ]/g, (ch) => ({ "█": " ", " ": "█", "▀": "▄", "▄": "▀" })[ch] ?? ch)}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box width={width} height={height} backgroundColor={theme.bg} flexDirection="column" justifyContent="center" alignItems="center">
      <Box marginBottom={1}>
        <Text color={theme.accent} bold>{"◉ wacon"}</Text>
      </Box>
      <Box flexDirection={sideBySide ? "row" : "column"} alignItems="center" borderStyle="round" borderColor={theme.border} paddingX={3} paddingY={1}>
        {fits || !link.qr ? steps : null}
        {right}
      </Box>
    </Box>
  );
}
