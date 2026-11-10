// k6 load test: two tenants hammering the API at once, with an isolation check on EVERY response.
//
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 grafana/k6:1.3.0 run - < loadtest/k6/two-tenants.js
//
// Run the API with raised limits so the test measures the app, not the rate limiter:
//   RATE_LIMIT_PER_IP_PER_MINUTE=1000000 RATE_LIMIT_PER_TENANT_PER_MINUTE=1000000 RATE_LIMIT_AUTH_PER_MINUTE=1000
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 60); // requests/second per tenant
const DURATION = __ENV.DURATION || '60s';

const TENANTS = {
  contoso: {
    host: 'contoso.localhost',
    user: 'dev-olivia',
    own: 'Clinical Operations',
    foreign: 'Patient Care',
    slug: 'adverse-event-reporting-in-24-hours',
  },
  northwind: {
    host: 'northwind.localhost',
    user: 'dev-nora',
    own: 'Patient Care',
    foreign: 'Clinical Operations',
    slug: 'sepsis-screening-and-escalation-pathway',
  },
};

const leaks = new Rate('cross_tenant_leaks');
const tenantLatency = {
  contoso: new Trend('latency_contoso', true),
  northwind: new Trend('latency_northwind', true),
};

export const options = {
  scenarios: Object.fromEntries(
    Object.keys(TENANTS).map((t) => [
      t,
      {
        executor: 'constant-arrival-rate',
        rate: RATE,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: 20,
        maxVUs: 100,
        exec: 'traffic',
        env: { TENANT: t },
      },
    ]),
  ),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<300', 'p(99)<800'],
    cross_tenant_leaks: ['rate==0'], // a single leak fails the run
    checks: ['rate>0.99'],
  },
};

function param(query, name) {
  const m = new RegExp(`[?&]${name}=([^&]*)`).exec(query);
  return m ? m[1] : '';
}

/** The full browser sign-in, server side: login -> dev IdP -> callback -> refresh. */
function signIn(t) {
  const { host, user } = TENANTS[t];
  const login = http.get(`${BASE}/api/v1/auth/login`, { headers: { Host: host }, redirects: 0 });
  const authorize = login.headers.Location;
  const query = authorize.slice(authorize.indexOf('?') + 1);
  const oidc = login.cookies.rh_oidc[0].value;
  const picked = http.post(`${BASE}/api/v1/dev-idp/authorize`, `${query}&oid=${user}`, {
    headers: { Host: 'localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    redirects: 0,
  });
  const cb = picked.headers.Location;
  const back = http.get(
    `${BASE}/api/v1/auth/callback?code=${param(cb, 'code')}&state=${param(cb, 'state')}`,
    {
      headers: { Host: host, Cookie: `rh_oidc=${oidc}` },
      redirects: 0,
    },
  );
  const refresh = back.cookies.rh_refresh[0].value;
  const session = http.post(`${BASE}/api/v1/auth/refresh`, null, {
    headers: { Host: host, Cookie: `rh_refresh=${refresh}` },
  });
  return session.json('accessToken');
}

export function setup() {
  return { contoso: signIn('contoso'), northwind: signIn('northwind') };
}

const PATHS = (t) => [
  '/api/v1/resources?limit=12',
  '/api/v1/resources?limit=12&q=checklist',
  `/api/v1/resources/${TENANTS[t].slug}`,
  '/api/v1/categories',
  '/api/v1/tags',
  '/api/v1/branding',
  '/api/v1/me',
];

export function traffic(tokens) {
  const t = __ENV.TENANT;
  const paths = PATHS(t);
  const path = paths[Math.floor(Math.random() * paths.length)];
  const res = http.get(`${BASE}${path}`, {
    headers: { Host: TENANTS[t].host, Authorization: `Bearer ${tokens[t]}` },
    tags: { tenant: t, endpoint: path.split('?')[0].replace(/[0-9a-z-]{20,}$/, ':slug') },
  });
  tenantLatency[t].add(res.timings.duration);
  const leaked = typeof res.body === 'string' && res.body.includes(TENANTS[t].foreign);
  leaks.add(leaked);
  check(res, {
    'status 200': (r) => r.status === 200,
    'no data from the other tenant': () => !leaked,
  });
}
