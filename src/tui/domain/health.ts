/**
 * When the daemon's own state puts messages at risk, the user must see it in
 * the app — the full-disk failures that lost a video only ever reached a log.
 */
export interface HealthInput {
  authError: string | null;
  freeDiskBytes: number | null;
}

/** Below this, Baileys can no longer stage media (it writes ~2x the file to temp). */
export const LOW_DISK_BYTES = 1024 ** 3;

export function healthWarning(h: HealthInput | null): string | null {
  if (!h) return null;
  if (h.freeDiskBytes !== null && h.freeDiskBytes < LOW_DISK_BYTES) {
    const mb = Math.max(0, Math.round(h.freeDiskBytes / 1024 ** 2));
    return `⚠ Disco casi lleno (${mb} MB libres): fotos y videos pueden no llegar. Libera espacio.`;
  }
  if (h.authError) return "⚠ No se pudo guardar la sesión de WhatsApp. Revisa el espacio en disco (wacon doctor).";
  return null;
}
