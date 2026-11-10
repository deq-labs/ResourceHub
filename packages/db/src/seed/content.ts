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
    hubTitle: 'Contoso Field Hub',
    tagline: 'Approved materials, SOPs and training for Contoso field and medical teams.',
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
      slug: 'clinical-operations',
      name: 'Clinical Operations',
      description: 'Trial conduct, site management and monitoring.',
      icon: 'flask-conical',
    },
    {
      slug: 'regulatory',
      name: 'Regulatory',
      description: 'Submissions, labeling and inspection readiness.',
      icon: 'scale',
    },
    {
      slug: 'medical-affairs',
      name: 'Medical Affairs',
      description: 'Approved scientific responses and HCP materials.',
      icon: 'stethoscope',
    },
    {
      slug: 'training',
      name: 'Training',
      description: 'Onboarding paths and compliance training.',
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
      title: 'Site initiation visit checklist',
      summary: 'Everything a CRA confirms before a site can enroll its first patient.',
      category: 'clinical-operations',
      tags: ['checklist', 'sites', 'cra'],
      featured: true,
      daysAgo: 2,
      author: 'dev-erin',
      body: `## Before the visit\n\n- Confirm the **delegation log** is signed by the PI\n- Verify IRB/EC approval letters for the current protocol version\n- Check investigational product storage logs (2–8 °C, continuous monitoring)\n\n## During the visit\n\n1. Walk through the protocol synopsis and schedule of assessments\n2. Train site staff on the EDC and capture training records\n3. Review the informed consent process end to end\n\n> Sites may not screen patients until the SIV report is approved in the CTMS.`,
    },
    {
      title: 'Protocol deviation classification guide',
      summary: 'How to grade deviations as minor, major or critical, with examples.',
      category: 'clinical-operations',
      tags: ['gcp', 'quality'],
      daysAgo: 9,
      author: 'dev-erin',
      body: `Deviations are graded by their impact on **subject safety** and **data integrity**.\n\n| Grade | Example | Escalate within |\n|---|---|---|\n| Minor | Visit 2 days outside window | Next monitoring visit |\n| Major | Missed safety lab | 5 business days |\n| Critical | Dosing without consent | 24 hours |\n\nLog every deviation in the CTMS, even if the site self-reports it.`,
    },
    {
      title: 'Label change notice: Contosamab 50 mg',
      summary: 'Updated storage statement on the outer carton effective Q2.',
      category: 'regulatory',
      tags: ['labeling', 'notice'],
      featured: true,
      daysAgo: 4,
      author: 'dev-adam',
      body: `The outer carton now reads **"Store in a refrigerator (2–8 °C). Do not freeze."**\n\n- Existing stock remains valid until expiry\n- Field teams should replace demo cartons by the end of the quarter\n- Customer questions go to Medical Information, not to sales`,
    },
    {
      title: 'Inspection readiness: the first 30 minutes',
      summary: 'Who to call and which room to prepare when an inspector arrives unannounced.',
      category: 'regulatory',
      tags: ['inspection', 'gcp', 'checklist'],
      daysAgo: 21,
      author: 'dev-adam',
      body: `1. Greet the inspector and verify credentials\n2. Call the **inspection lead** on the hotline\n3. Open the front room and the document request log\n4. Never speculate: "I'll find out and come back to you" is a complete answer`,
    },
    {
      title: 'Standard response: Contosamab and renal impairment',
      summary: 'Approved medical information response for HCP questions on dosing in CKD.',
      category: 'medical-affairs',
      tags: ['standard-response', 'hcp'],
      daysAgo: 6,
      author: 'dev-erin',
      body: `This response is approved for **unsolicited** requests from healthcare professionals only.\n\nNo dose adjustment is required for mild or moderate renal impairment (eGFR ≥ 30). Data in severe impairment are limited; see section 5.2 of the SmPC.`,
    },
    {
      title: 'Adverse event reporting in 24 hours',
      summary: 'What counts as an AE, what to capture, and where to send it.',
      category: 'medical-affairs',
      tags: ['safety', 'pharmacovigilance', 'checklist'],
      featured: true,
      daysAgo: 1,
      author: 'dev-olivia',
      body: `**Any** employee who hears about an adverse event must report it within **24 hours**, even if it seems minor or unrelated.\n\nCapture the four minimum criteria:\n\n- An identifiable patient\n- An identifiable reporter\n- A suspect product\n- An adverse event\n\nSubmit through the safety intake form. Do not investigate further yourself.`,
    },
    {
      title: 'New field rep onboarding: week one',
      summary: 'Systems access, shadowing schedule and required compliance modules.',
      category: 'training',
      tags: ['onboarding', 'compliance'],
      daysAgo: 12,
      author: 'dev-olivia',
      body: `### Day 1\nLaptop, CRM access, and the **Code of Conduct** module.\n\n### Days 2–3\nShadow a senior rep; observe at least four HCP calls.\n\n### Days 4–5\nComplete product training and pass the certification quiz (80%).`,
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
      title: 'Speaker program compliance FAQ (draft)',
      summary: 'Working draft. Not yet approved for distribution.',
      category: 'training',
      tags: ['compliance'],
      status: 'draft',
      daysAgo: 0,
      author: 'dev-erin',
      body: `_Draft: pending legal review._\n\nFair market value caps and venue rules for speaker programs.`,
    },
  ],
};

const NORTHWIND: SeedHub = {
  tenantId: DEMO_TENANTS.northwind.id,
  branding: {
    tenantId: DEMO_TENANTS.northwind.id,
    hubTitle: 'Northwind Care Library',
    tagline: 'Protocols, policies and onboarding for Northwind Health clinical staff.',
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
      slug: 'patient-care',
      name: 'Patient Care',
      description: 'Bedside protocols and care pathways.',
      icon: 'heart-pulse',
    },
    {
      slug: 'nursing-protocols',
      name: 'Nursing Protocols',
      description: 'Medication, infection control and escalation.',
      icon: 'clipboard-list',
    },
    {
      slug: 'facilities',
      name: 'Facilities',
      description: 'Equipment, safety and emergency procedures.',
      icon: 'building-2',
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
      title: 'Sepsis screening and escalation pathway',
      summary: 'qSOFA screening, the sepsis six, and who to page at each step.',
      category: 'patient-care',
      tags: ['sepsis', 'escalation', 'checklist'],
      featured: true,
      daysAgo: 1,
      author: 'dev-ned',
      body: `Screen every adult with suspected infection using **qSOFA**.\n\nIf two or more are positive, start the **sepsis six within one hour**:\n\n1. Oxygen to target saturation\n2. Blood cultures\n3. IV antibiotics\n4. IV fluids\n5. Lactate\n6. Urine output monitoring\n\nPage the rapid response team on **#4455**.`,
    },
    {
      title: 'Falls prevention bundle',
      summary: 'Risk assessment on admission and the five bedside interventions.',
      category: 'patient-care',
      tags: ['falls', 'safety'],
      daysAgo: 8,
      author: 'dev-ned',
      body: `- Complete the Morse Falls Scale within 4 hours of admission\n- Bed in lowest position, call bell in reach\n- Non-slip footwear\n- Hourly rounding for high-risk patients\n- Review sedating medications with pharmacy`,
    },
    {
      title: 'High-alert medication double-check',
      summary: 'Which medications need an independent second-nurse check.',
      category: 'nursing-protocols',
      tags: ['medication', 'safety', 'checklist'],
      featured: true,
      daysAgo: 3,
      author: 'dev-nora',
      body: `Independent double-checks are required for **insulin infusions, heparin, potassium chloride concentrate, opioids via PCA,** and **chemotherapy**.\n\nThe second nurse checks from the original order, not from the first nurse's calculation.`,
    },
    {
      title: 'Hand hygiene: the five moments',
      summary: 'WHO five moments, with audit expectations for each ward.',
      category: 'nursing-protocols',
      tags: ['infection-control'],
      daysAgo: 15,
      author: 'dev-ned',
      body: `1. Before touching a patient\n2. Before a clean or aseptic procedure\n3. After body fluid exposure risk\n4. After touching a patient\n5. After touching patient surroundings\n\nWards are audited monthly; the target is **≥ 95% compliance**.`,
    },
    {
      title: 'Fire evacuation: horizontal first',
      summary: 'Progressive horizontal evacuation and the role of the fire warden.',
      category: 'facilities',
      tags: ['emergency', 'fire'],
      daysAgo: 40,
      author: 'dev-nora',
      body: `Move patients **horizontally** through at least one set of fire doors before considering vertical evacuation.\n\nThe nurse in charge acts as fire warden until the site fire team arrives.`,
    },
    {
      title: 'New starter guide: your first month',
      summary: 'Badges, mandatory training, preceptors and who to ask.',
      category: 'people',
      tags: ['onboarding'],
      daysAgo: 5,
      author: 'dev-nora',
      body: `Welcome to Northwind Health!\n\n- **Week 1:** ID badge, IT access, mandatory e-learning\n- **Weeks 2–3:** supernumerary shifts with your preceptor\n- **Week 4:** competency sign-off and your first one-to-one`,
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

export const seedContent: SeedStep = async (db) => {
  await seedHub(db, CONTOSO);
  await seedHub(db, NORTHWIND);
};
