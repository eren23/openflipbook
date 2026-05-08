/**
 * Server-side Sentry init — Next.js calls this once per server boot.
 * Init is a no-op when SENTRY_DSN isn't set, so this file is safe to ship
 * without Sentry configured.
 */
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  const runtime = process.env.NEXT_RUNTIME;
  if (runtime === "nodejs" || runtime === "edge") {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
      sendDefaultPii: false,
      beforeSend(event) {
        // Drop request bodies / headers that may carry user-typed queries.
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          if (event.request.headers) {
            for (const k of Object.keys(event.request.headers)) {
              if (k.toLowerCase() === "authorization" || k.toLowerCase().includes("api-key")) {
                event.request.headers[k] = "[redacted]";
              }
            }
          }
        }
        return event;
      },
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
