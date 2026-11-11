import { newId } from '../schema/columns.js';
import * as schema from '../schema/index.js';
import { DEMO_TENANTS, DEMO_USERS } from './demo-data.js';
import type { SeedStep } from './seed.js';

interface SeedResource {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  body: string;
  status?: 'draft' | 'published' | 'archived';
  featured?: boolean;
  daysAgo: number;
  author: string;
}

interface SeedHub {
  tenantId: string;
  branding: typeof schema.tenantBranding.$inferInsert;
  categories: { slug: string; name: string; description: string; icon: string }[];
  resources: SeedResource[];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const userId = (oid: string) => DEMO_USERS.find((u) => u.oid === oid)!.id;

const CONTOSO: SeedHub = {
  tenantId: DEMO_TENANTS.contoso.id,
  branding: {
    tenantId: DEMO_TENANTS.contoso.id,
    hubTitle: 'Contoso Operations Hub',
    tagline: 'SOPs, quality standards and training for Contoso plant and field teams.',
    colors: {
      primary: '#0f766e',
      primaryForeground: '#ffffff',
      accent: '#f59e0b',
      background: '#f6faf9',
    },
    font: 'IBM Plex Sans',
  },
  categories: [
    {
      slug: 'plant-operations',
      name: 'Plant Operations',
      description: 'Line procedures, shift handovers and changeovers.',
      icon: 'factory',
    },
    {
      slug: 'quality',
      name: 'Quality & Compliance',
      description: 'Inspections, audits and nonconformance handling.',
      icon: 'badge-check',
    },
    {
      slug: 'engineering',
      name: 'Engineering',
      description: 'Maintenance standards and engineering change notices.',
      icon: 'wrench',
    },
    {
      slug: 'training',
      name: 'Training',
      description: 'Onboarding paths and certification.',
      icon: 'graduation-cap',
    },
    {
      slug: 'brand',
      name: 'Brand & Marketing',
      description: 'Approved brand assets and usage rules.',
      icon: 'palette',
    },
  ],
  resources: [
    {
      title: 'Line startup checklist',
      summary: 'Everything an operator confirms before a production line starts a shift.',
      category: 'plant-operations',
      tags: ['checklist', 'lines', 'operators'],
      featured: true,
      daysAgo: 2,
      author: 'dev-erin',
      body: `## Before startup\n\n- Confirm the **shift handover log** is signed by the outgoing lead\n- Check guards, interlocks and emergency stops are in place\n- Verify the first-article sample from the last run was approved\n\n## At startup\n\n1. Run the line empty for two cycles\n2. Check the torque and fill settings against the job card\n3. Record the start time and the batch number in the MES\n\n> The line may not run product until the startup check is signed off in the MES.`,
    },
    {
      title: 'Nonconformance classification guide',
      summary: 'How to grade a nonconformance as minor, major or critical, with examples.',
      category: 'quality',
      tags: ['quality', 'audit'],
      daysAgo: 9,
      author: 'dev-erin',
      body: `Nonconformances are graded by their impact on **customer safety** and **product function**.\n\n| Grade | Example | Escalate within |\n|---|---|---|\n| Minor | Label slightly off-centre | Next shift review |\n| Major | Torque outside tolerance on 3 units | 5 business days |\n| Critical | Missing safety guard on a shipped unit | 24 hours |\n\nLog every nonconformance in the QMS, even if the line fixes it straight away.`,
    },
    {
      title: 'Engineering change notice: ECN-2291 bracket redesign',
      summary: 'New bracket material and fastener spec, effective Q2.',
      category: 'engineering',
      tags: ['ecn', 'notice'],
      featured: true,
      daysAgo: 4,
      author: 'dev-adam',
      body: `The mounting bracket moves from mild steel to **galvanised steel** with M8 stainless fasteners.\n\n- Existing stock may be used until it runs out\n- Update the work instructions at stations 4 and 7 by the end of the quarter\n- Customer questions go to the account team, not to the line`,
    },
    {
      title: 'Customer audit: the first 30 minutes',
      summary: 'Who to call and which room to prepare when an auditor arrives.',
      category: 'quality',
      tags: ['audit', 'checklist'],
      daysAgo: 21,
      author: 'dev-adam',
      body: `1. Greet the auditor and sign them in with a visitor badge\n2. Call the **quality lead** on the hotline\n3. Open the front meeting room and the document request log\n4. Never guess: "I'll find out and come back to you" is a complete answer`,
    },
    {
      title: 'Preventive maintenance intervals: conveyors',
      summary: 'Inspection and lubrication schedule for belt and roller conveyors.',
      category: 'engineering',
      tags: ['maintenance'],
      daysAgo: 6,
      author: 'dev-erin',
      body: `| Task | Interval |\n|---|---|\n| Belt tension and tracking check | Weekly |\n| Roller bearing lubrication | Monthly |\n| Drive chain inspection | Quarterly |\n\nLog every task in the CMMS. Overdue tasks lock the line's next changeover.`,
    },
    {
      title: 'Near-miss reporting in 24 hours',
      summary: 'What counts as a near miss, what to capture, and where to send it.',
      category: 'plant-operations',
      tags: ['safety', 'reporting', 'checklist'],
      featured: true,
      daysAgo: 1,
      author: 'dev-olivia',
      body: `**Anyone** who sees a near miss must report it within **24 hours**, even if nobody was hurt and it seems minor.\n\nCapture the four minimum criteria:\n\n- Where it happened\n- What happened\n- Who saw it\n- What could have happened\n\nSubmit through the safety intake form. Don't investigate further yourself.`,
    },
    {
      title: 'New operator onboarding: week one',
      summary: 'Site induction, buddy shifts and required safety modules.',
      category: 'training',
      tags: ['onboarding', 'safety'],
      daysAgo: 12,
      author: 'dev-olivia',
      body: `### Day 1\nSite induction, PPE fitting, and the **Code of Conduct** module.\n\n### Days 2–3\nBuddy shifts with a senior operator on at least two lines.\n\n### Days 4–5\nComplete machine-specific training and pass the certification quiz (80%).`,
    },
    {
      title: 'Brand asset usage rules (2026)',
      summary: 'Logo clear space, color tokens and co-branding with partners.',
      category: 'brand',
      tags: ['brand', 'design'],
      daysAgo: 30,
      author: 'dev-adam',
      body: `- Keep clear space equal to the height of the "C" around the logo\n- Primary teal **#0F766E** for headers; amber **#F59E0B** for highlights only\n- Partner logos sit to the right, separated by a 1px rule`,
    },
    {
      title: 'Supplier visit policy FAQ (draft)',
      summary: 'Working draft. Not yet approved for distribution.',
      category: 'training',
      tags: ['policy'],
      status: 'draft',
      daysAgo: 0,
      author: 'dev-erin',
      body: `_Draft: pending legal review._\n\nGift limits, hospitality rules and who may host supplier visits on site.`,
    },
  ],
};

const NORTHWIND: SeedHub = {
  tenantId: DEMO_TENANTS.northwind.id,
  branding: {
    tenantId: DEMO_TENANTS.northwind.id,
    hubTitle: 'Northwind Store Library',
    tagline: 'Store procedures, merchandising guides and onboarding for Northwind Traders teams.',
    colors: {
      primary: '#4338ca',
      primaryForeground: '#ffffff',
      accent: '#db2777',
      background: '#f7f7fc',
    },
    font: 'Nunito Sans',
  },
  categories: [
    {
      slug: 'store-operations',
      name: 'Store Operations',
      description: 'Opening, closing and day-to-day store routines.',
      icon: 'store',
    },
    {
      slug: 'merchandising',
      name: 'Merchandising',
      description: 'Planograms, promotions and visual standards.',
      icon: 'shopping-bag',
    },
    {
      slug: 'logistics',
      name: 'Warehouse & Logistics',
      description: 'Deliveries, stock rooms and emergency procedures.',
      icon: 'truck',
    },
    {
      slug: 'people',
      name: 'HR & Onboarding',
      description: 'Policies, benefits and new-starter guides.',
      icon: 'users',
    },
  ],
  resources: [
    {
      title: 'Opening and closing the store',
      summary: 'The opening checklist, the closing checklist, and who to call at each step.',
      category: 'store-operations',
      tags: ['opening', 'closing', 'checklist'],
      featured: true,
      daysAgo: 1,
      author: 'dev-ned',
      body: `Two keyholders open and close **together**, every time.\n\n**Opening:**\n\n1. Disarm the alarm and walk the shop floor\n2. Count the till floats\n3. Check overnight deliveries against the manifest\n4. Switch on lighting and the music system\n5. Unlock the doors on time\n6. Post the day's targets in the staff room\n\nIf anything looks wrong on arrival, step outside and call the area manager on **#4455**.`,
    },
    {
      title: 'Cash handling and till reconciliation',
      summary: 'Float counts, safe drops and how to reconcile a till at end of day.',
      category: 'store-operations',
      tags: ['cash', 'security'],
      daysAgo: 8,
      author: 'dev-ned',
      body: `- Start every till with the standard float\n- Make a safe drop whenever a till holds more than the limit\n- Two people count at end of day, out of view of customers\n- Record variances over the threshold in the incident log\n- Never leave keys in the safe or the till`,
    },
    {
      title: 'Planogram compliance walk',
      summary: 'How to check shelves against the planogram and fix gaps before opening.',
      category: 'merchandising',
      tags: ['planogram', 'visual', 'checklist'],
      featured: true,
      daysAgo: 3,
      author: 'dev-nora',
      body: `Walk **every aisle** with the current planogram set before opening on reset days.\n\nCheck facings, shelf labels and promotional end caps. Fix gaps from the stock room first, then raise a ticket for anything that's out of stock.`,
    },
    {
      title: 'Receiving deliveries: check, count, store',
      summary: 'Checking a delivery against the manifest, with expectations for each store.',
      category: 'logistics',
      tags: ['deliveries'],
      daysAgo: 15,
      author: 'dev-ned',
      body: `1. Check the seal number against the manifest\n2. Count cases before signing\n3. Note damage on the driver's copy\n4. Move chilled stock to the cold room first\n5. Put away within two hours\n\nStores are audited monthly; the target is **≥ 95% accuracy**.`,
    },
    {
      title: 'Fire evacuation: assembly points',
      summary: 'Evacuation routes, assembly points and the role of the fire warden.',
      category: 'logistics',
      tags: ['emergency', 'fire'],
      daysAgo: 40,
      author: 'dev-nora',
      body: `Guide customers to the **nearest marked exit**, not the way they came in.\n\nThe duty manager acts as fire warden until the fire service arrives, and takes the staff roll call at the assembly point.`,
    },
    {
      title: 'New starter guide: your first month',
      summary: 'Badges, mandatory training, your buddy and who to ask.',
      category: 'people',
      tags: ['onboarding'],
      daysAgo: 5,
      author: 'dev-nora',
      body: `Welcome to Northwind Traders!\n\n- **Week 1:** name badge, till login, mandatory e-learning\n- **Weeks 2–3:** shifts alongside your buddy\n- **Week 4:** sign-off and your first one-to-one`,
    },
  ],
};

async function seedHub(db: Parameters<SeedStep>[0], hub: SeedHub): Promise<void> {
  await db.insert(schema.tenantBranding).values(hub.branding);
  const cats = await db
    .insert(schema.categories)
    .values(hub.categories.map((c, i) => ({ ...c, tenantId: hub.tenantId, sort: i })))
    .returning();
  const catId = new Map(cats.map((c) => [c.slug, c.id]));

  const tagNames = [...new Set(hub.resources.flatMap((r) => r.tags))];
  const tagRows = await db
    .insert(schema.tags)
    .values(tagNames.map((t) => ({ tenantId: hub.tenantId, name: t.replace(/-/g, ' '), slug: t })))
    .returning();
  const tagId = new Map(tagRows.map((t) => [t.slug, t.id]));

  for (const r of hub.resources) {
    const id = newId();
    const when = new Date(Date.now() - r.daysAgo * 86_400_000);
    const status = r.status ?? 'published';
    await db.insert(schema.resources).values({
      id,
      tenantId: hub.tenantId,
      title: r.title,
      slug: slugify(r.title),
      summary: r.summary,
      body: { format: 'markdown', content: r.body },
      status,
      featured: r.featured ?? false,
      publishedAt: status === 'published' ? when : null,
      categoryId: catId.get(r.category) ?? null,
      authorId: userId(r.author),
      createdAt: when,
      updatedAt: when,
    });
    await db
      .insert(schema.resourceTags)
      .values(
        r.tags.map((t) => ({ tenantId: hub.tenantId, resourceId: id, tagId: tagId.get(t)! })),
      );
  }
}

/** Demo integrations: private partner mocks for Contoso, public APIs for Northwind. */
async function seedIntegrations(db: Parameters<SeedStep>[0]): Promise<void> {
  const c = DEMO_TENANTS.contoso.id;
  const n = DEMO_TENANTS.northwind.id;
  await db.insert(schema.integrations).values([
    {
      tenantId: c,
      kind: 'soap',
      provider: 'partner-docs',
      name: 'Partner document library',
      config: {
        endpoint: 'http://localhost:8088/soap/partner-docs',
        username: 'partner-demo',
        passwordDigest: false,
      },
      secretRef: 'env:PARTNER_SOAP_PASSWORD',
      scheduleMinutes: 60,
    },
    {
      tenantId: c,
      kind: 'rest',
      provider: 'partner-feed',
      name: 'Partner content feed',
      config: { baseUrl: 'http://localhost:8089' },
      secretRef: 'env:PARTNER_FEED_TOKEN',
    },
    {
      tenantId: n,
      kind: 'soap',
      provider: 'country-info',
      name: 'European country profiles',
      config: {
        endpoint: 'http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso',
        continent: 'EU',
      },
    },
    {
      tenantId: n,
      kind: 'rest',
      provider: 'spaceflight-news',
      name: 'Industry news',
      config: { baseUrl: 'https://api.spaceflightnewsapi.net', maxItems: 12 },
    },
  ]);
}

export const seedContent: SeedStep = async (db) => {
  await seedHub(db, CONTOSO);
  await seedHub(db, NORTHWIND);
  await seedIntegrations(db);
};
