// Loaded first via `node --import ./dist/instrumentation.js dist/main.js`.
// With APPLICATIONINSIGHTS_CONNECTION_STRING set, the Azure Monitor OpenTelemetry distro exports
// traces (HTTP in/out, Postgres, Redis), metrics and logs to Application Insights. ESM modules
// are auto-instrumented through the import-in-the-middle loader hook registered below.
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  const require = createRequire(import.meta.url);
  const distro = require.resolve('@azure/monitor-opentelemetry');
  const hook = createRequire(distro).resolve('@opentelemetry/instrumentation/hook.mjs');
  register(pathToFileURL(hook));

  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio: Number(process.env.OTEL_SAMPLING_RATIO ?? '1'),
    enableLiveMetrics: true,
    instrumentationOptions: {
      http: { enabled: true },
      postgreSql: { enabled: true },
      redis: { enabled: true },
      redis4: { enabled: true },
    },
  });
}
