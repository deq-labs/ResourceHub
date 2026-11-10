// Local SOAP mock for PartnerDocumentService. It serves the committed WSDL and
// enforces WS-Security UsernameToken auth, so the adapter's auth path is exercised locally.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import soap from 'soap';

const PORT = Number(process.env.PORT ?? 8088);
const USERNAME = process.env.SOAP_MOCK_USERNAME ?? 'partner-demo';
const PASSWORD = process.env.SOAP_MOCK_PASSWORD ?? 'partner-demo-password';
const WSDL_PATH = process.env.WSDL_PATH ?? new URL('./partner-docs.wsdl', import.meta.url);

const wsdl = readFileSync(WSDL_PATH, 'utf8');

const base = Date.parse('2026-01-05T09:00:00Z');
const day = 24 * 60 * 60 * 1000;
const seed = [
  [
    'PD-1001',
    'Cold chain handling SOP',
    'Temperature excursions and the escalation path for refrigerated shipments.',
    'Operations',
  ],
  [
    'PD-1002',
    'Adverse event reporting guide',
    'What to capture, who to notify and the 24-hour reporting window.',
    'Safety',
  ],
  [
    'PD-1003',
    'Partner onboarding checklist',
    'Documents and system access a new distribution partner needs.',
    'Onboarding',
  ],
  [
    'PD-1004',
    'Label change notice: 50mg tablets',
    'Updated storage statement on the outer carton from Q2.',
    'Regulatory',
  ],
  [
    'PD-1005',
    'Returns and recall workflow',
    'Steps for lot-level recalls, quarantine and credit notes.',
    'Operations',
  ],
  [
    'PD-1006',
    'Data privacy addendum',
    'How patient-identifiable data is minimised in partner reports.',
    'Compliance',
  ],
];
const documents = seed.map(([id, title, summary, category], i) => ({
  DocumentId: id,
  Title: title,
  Summary: summary,
  Category: category,
  Revision: 1 + (i % 3),
  UpdatedAt: new Date(base + i * 14 * day).toISOString(),
}));

const PAGE_SIZE = 4;
const submitted = [];

function fault(code, message) {
  return { Fault: { faultcode: code, faultstring: message, statusCode: 500 } };
}

const service = {
  PartnerDocumentService: {
    PartnerDocumentPort: {
      Ping() {
        return { Status: 'OK', ServerTime: new Date().toISOString() };
      },
      GetDocumentsSince(args) {
        const since = Date.parse(args?.Since ?? '1970-01-01T00:00:00Z');
        if (Number.isNaN(since)) throw fault('soap:Client', 'Since must be an xsd:dateTime');
        const matching = documents.filter((d) => Date.parse(d.UpdatedAt) > since);
        const offset = Number(args?.PageToken ?? 0) || 0;
        const page = matching.slice(offset, offset + PAGE_SIZE);
        const next = offset + PAGE_SIZE < matching.length ? String(offset + PAGE_SIZE) : undefined;
        return { Documents: { Document: page }, ...(next ? { NextPageToken: next } : {}) };
      },
      SubmitDocument(args) {
        if (!args?.Document?.Title) throw fault('soap:Client', 'Document.Title is required');
        const ref = `PDREF-${randomUUID().slice(0, 8).toUpperCase()}`;
        submitted.push({ ref, ...args.Document });
        return { ReferenceId: ref };
      },
    },
  },
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', submitted: submitted.length }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  const soapServer = soap.listen(server, '/soap/partner-docs', service, wsdl);
  // WS-Security UsernameToken check. A request without a valid token gets a SOAP fault.
  soapServer.authenticate = (security) => {
    const token = security?.UsernameToken;
    const password = typeof token?.Password === 'object' ? token.Password.$value : token?.Password;
    return token?.Username === USERNAME && password === PASSWORD;
  };
  soapServer.log = (type, data) => {
    if (type === 'error') console.error('[soap-mock]', data);
  };
  console.log(`[soap-mock] PartnerDocumentService on :${PORT}/soap/partner-docs?wsdl`);
});
