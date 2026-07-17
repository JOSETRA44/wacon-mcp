import type { Store } from "./store.js";
import { MAX_WATCH_MINUTES } from "./watch.js";

/**
 * "How long is it worth staying online?" answered from history instead of guesswork.
 *
 * Message arrivals in a given weekday+hour slot behave like a Poisson process:
 * we know the historical rate λ (messages/hour) for each slot, so we can compute
 * how long an agent must wait to have a good chance of catching something — and,
 * crucially, tell it when staying is a waste of tokens.
 */

const WINDOW_DAYS = 56; // 8 weeks of history
const CONFIDENCE = 0.8; // aim to catch ≥1 message with 80% probability

export type ActivityLevel = "dead" | "quiet" | "normal" | "busy";

export interface HourForecast {
  /** Hours from now (0 = current hour). */
  inHours: number;
  dow: number;
  hour: number;
  expectedPerHour: number;
  level: ActivityLevel;
}

export interface WatchWindowSuggestion {
  now: { dow: number; hour: number; expectedPerHour: number; level: ActivityLevel };
  /** 0 means: don't bother watching right now. */
  recommendedMinutes: number;
  expectedMessagesInWindow: number;
  rationale: string;
  nextBusyWindow: { startsInHours: number; dow: number; hour: number; expectedPerHour: number } | null;
  forecast: HourForecast[];
  basedOnDays: number;
}

const DOW_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function level(rate: number): ActivityLevel {
  if (rate < 0.1) return "dead";
  if (rate < 1) return "quiet";
  if (rate < 4) return "normal";
  return "busy";
}

export function suggestWatchWindow(store: Store, chatJid?: string): WatchWindowSuggestion {
  const histogram = store.inboundActivityHistogram(WINDOW_DAYS, chatJid);
  const weeks = WINDOW_DAYS / 7;

  // rate[dow][hour] = expected inbound messages per hour in that slot
  const rate = new Map<string, number>();
  for (const row of histogram) {
    rate.set(`${row.dow}:${row.hour}`, row.count / weeks);
  }
  const rateAt = (dow: number, hour: number): number => rate.get(`${dow}:${hour}`) ?? 0;

  const now = new Date();
  const nowDow = now.getDay();
  const nowHour = now.getHours();
  const nowRate = rateAt(nowDow, nowHour);

  // 12-hour forecast from the current slot
  const forecast: HourForecast[] = [];
  for (let i = 0; i < 12; i++) {
    const t = new Date(now.getTime() + i * 3600_000);
    const r = rateAt(t.getDay(), t.getHours());
    forecast.push({ inHours: i, dow: t.getDay(), hour: t.getHours(), expectedPerHour: Number(r.toFixed(2)), level: level(r) });
  }

  // "Busy" is relative: a chat averaging 1 msg/h has no absolute peak, but it
  // still has hours that are 10x better than now. Compare against the current
  // slot as well as the absolute threshold.
  const nextBusy =
    forecast.find((f) => f.inHours > 0 && (f.expectedPerHour >= 4 || f.expectedPerHour >= Math.max(0.5, rateAt(nowDow, nowHour) * 3))) ?? null;

  // Poisson: P(at least 1 message in t hours) = 1 - e^(-λt) = CONFIDENCE
  //   =>  t = -ln(1 - CONFIDENCE) / λ
  let recommendedMinutes = 0;
  let rationale: string;
  const dowName = DOW_NAMES[nowDow] ?? "";

  const busyHint = nextBusy
    ? ` La próxima ventana activa es en ~${nextBusy.inHours}h (${nextBusy.hour}:00, ~${nextBusy.expectedPerHour} msg/h): vigilar entonces cuesta muchos menos tokens por mensaje captado.`
    : "";

  if (nowRate < 0.1) {
    rationale = `Franja muerta (${dowName} ${nowHour}:00, ~${nowRate.toFixed(1)} msg/h históricos). Esperar aquí gasta tokens sin captar nada.${busyHint}`;
  } else {
    // Poisson: time to reach CONFIDENCE probability of ≥1 message.
    const requiredMinutes = Math.round((-Math.log(1 - CONFIDENCE) / nowRate) * 60);
    if (requiredMinutes > MAX_WATCH_MINUTES && nextBusy) {
      // Waiting here would need longer than any watch is allowed to live, and
      // there is a materially better slot coming. Say so plainly instead of
      // recommending a marathon vigil.
      recommendedMinutes = 0;
      rationale = `${dowName} ${nowHour}:00 es lento (~${nowRate.toFixed(
        1
      )} msg/h): harían falta ~${Math.round(requiredMinutes / 60)}h para tener ${Math.round(
        CONFIDENCE * 100
      )}% de captar algo, más de lo que dura una vigilancia.${busyHint}`;
    } else {
      recommendedMinutes = Math.min(MAX_WATCH_MINUTES, Math.max(5, requiredMinutes));
      rationale = `${dowName} ${nowHour}:00 tiene ~${nowRate.toFixed(
        1
      )} msg/h históricos. Con ${recommendedMinutes} min hay ~${Math.round(CONFIDENCE * 100)}% de probabilidad de captar al menos un mensaje.`;
      if (requiredMinutes > MAX_WATCH_MINUTES) {
        rationale += ` Es una franja lenta y no hay una ventana mejor a la vista; considera revisar con get_digest más tarde en vez de vigilar en vivo.`;
      }
    }
  }

  return {
    now: { dow: nowDow, hour: nowHour, expectedPerHour: Number(nowRate.toFixed(2)), level: level(nowRate) },
    recommendedMinutes,
    expectedMessagesInWindow: Number(((nowRate * recommendedMinutes) / 60).toFixed(2)),
    rationale,
    nextBusyWindow: nextBusy
      ? { startsInHours: nextBusy.inHours, dow: nextBusy.dow, hour: nextBusy.hour, expectedPerHour: nextBusy.expectedPerHour }
      : null,
    forecast,
    basedOnDays: WINDOW_DAYS,
  };
}
