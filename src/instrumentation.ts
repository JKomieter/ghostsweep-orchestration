import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://140fec88fb3a0069b45eb58afc2c88ed@o4509952985792512.ingest.us.sentry.io/4510901479211008",
  environment: process.env.NODE_ENV ?? "development",
  sendDefaultPii: true,
  tracesSampleRate: 1.0,
  integrations: [
    Sentry.expressIntegration(),
  ],
});

export default Sentry;