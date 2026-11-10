import type { DemoUser } from '@resourcehub/db';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --card:#111827; --fg:#f3f4f6; --muted:#9ca3af; --line:#1f2937; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } p.sub { color:var(--muted); margin:0 0 20px; }
  .badge { display:inline-block; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:1px 8px; margin-bottom:12px; }
  button.user { width:100%; text-align:left; display:flex; justify-content:space-between; gap:12px; align-items:center; background:none; color:inherit; border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin:0 0 8px; cursor:pointer; font:inherit; }
  button.user:hover, button.user:focus-visible { border-color:var(--accent); outline:none; }
  .name { font-weight:600; } .meta { color:var(--muted); font-size:13px; }
  .row { display:flex; gap:8px; } input { flex:1; min-width:0; font:inherit; padding:9px 12px; border-radius:10px; border:1px solid var(--line); background:transparent; color:inherit; }
  .go { font:inherit; padding:9px 16px; border-radius:10px; border:0; background:var(--accent); color:#fff; cursor:pointer; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:24px 0 10px; }
  footer { color:var(--muted); font-size:12px; margin-top:16px; text-align:center; }
`;

function hidden(params: Record<string, string | undefined>): string {
  const keys = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ];
  return keys
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? '')}">`)
    .join('');
}

export function renderAuthorizePage(
  issuer: string,
  params: Record<string, string | undefined>,
  users: DemoUser[],
): string {
  let target = '';
  try {
    target = new URL(params.redirect_uri ?? '').host;
  } catch {
    /* validated earlier */
  }
  const action = `${issuer}/authorize`;
  const list = users
    .map(
      (u) => `<form method="post" action="${esc(action)}">${hidden(params)}
        <input type="hidden" name="oid" value="${esc(u.oid)}">
        <button class="user" type="submit"><span><span class="name">${esc(u.name)}</span><br><span class="meta">${esc(u.email)}</span></span><span class="meta">${esc(u.title)}</span></button>
      </form>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Dev identity provider</title><style>${STYLE}</style></head><body><main><div class="card">
<span class="badge">Local dev IdP · OIDC + PKCE</span>
<h1>Sign in to ResourceHub</h1>
<p class="sub">Signing in to <strong>${esc(target)}</strong>. In Azure this screen is Microsoft Entra External ID.</p>
<h2>Demo users</h2>${list}
<h2>Someone new (for invitations)</h2>
<form method="post" action="${esc(action)}">${hidden(params)}
  <div class="row"><input name="email" type="email" required placeholder="new.hire@example.com" value="${esc(params.login_hint ?? '')}"><input name="name" placeholder="Name (optional)"><button class="go" type="submit">Continue</button></div>
</form>
</div><footer>Issuer ${esc(issuer)}</footer></main></body></html>`;
}

export function renderError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in error</title><style>${STYLE}</style></head>
<body><main><div class="card"><h1>Sign-in request rejected</h1><p class="sub">${esc(message)}</p></div></main></body></html>`;
}
