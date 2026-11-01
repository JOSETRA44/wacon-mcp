import { useEffect } from "react";
import { Box, Text } from "ink";
import type { CellRect, ImagePort } from "../../application/ports.js";
import { truncate } from "../../domain/text.js";
import { useTheme } from "../themes.js";
import { Spinner } from "./Spinner.js";

interface Props {
  images: ImagePort;
  data: Uint8Array | null;
  failed: boolean;
  title: string;
  position: string;
  width: number;
  height: number;
}

/**
 * Full-screen photo viewer drawn with sixel. It covers the whole body on
 * purpose: Ink rewrites any screen row whose text changes, and a row that is
 * entirely this static overlay never changes — so the pixels stay put.
 */
export function ImageViewer({ images, data, failed, title, position, width, height }: Props) {
  const theme = useTheme().c;
  // Inside the border, below the title line (1-based terminal coordinates).
  const rect: CellRect = { row: 3, col: 3, cols: Math.max(4, width - 4), rows: Math.max(2, height - 4) };

  useEffect(() => {
    if (!data) return;
    // Let Ink flush this frame first; drawing earlier gets painted over.
    const t = setTimeout(() => void images.draw(data, rect, theme.bg ?? "#000000").catch(() => undefined), 90);
    return () => clearTimeout(t);
    // rect is derived from width/height
  }, [data, width, height, images, theme.bg]);

  // Leaving the viewer must wipe the pixels so the chat repaints cleanly.
  useEffect(() => () => images.release(), [images]);

  return (
    <Box position="absolute" top={0} left={0} width={width} height={height} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.bg}>
      <Box height={1} paddingX={1}>
        <Text color={theme.text} bold>{truncate(`📷 ${title}`, Math.max(10, width - 60))}</Text>
        <Text color={theme.muted}>{`  ${position}`}</Text>
        <Text color={theme.faint}>{"   ←→ otra foto · v abrir en el visor del sistema · Esc cerrar"}</Text>
      </Box>
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        {failed ? (
          <Text color={theme.error}>No pude mostrar esta imagen. Pulsa v para abrirla en el visor del sistema.</Text>
        ) : !data ? (
          <Text color={theme.muted}>
            <Spinner color={theme.accent} /> descargando…
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
    </Box>
  );
}
