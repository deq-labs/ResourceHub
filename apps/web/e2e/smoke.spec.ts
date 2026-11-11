import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SCREENSHOTS; // set to a folder to capture demo screenshots

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/** Sign in through the real OIDC flow: SPA -> /auth/login -> dev IdP -> /auth/callback. */
async function signInAs(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/`);
  await expect(page.getByRole('button', { name: /single sign-on/i })).toBeVisible();
  await shot(page, `signin-${new URL(origin).hostname.split('.')[0]}`);
  await page.getByRole('button', { name: /single sign-on/i }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to ResourceHub' })).toBeVisible();
  await shot(page, 'dev-idp');
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('a Contoso editor signs in, browses, searches and opens a resource', async ({ page }) => {
  await signInAs(page, 'http://contoso.localhost:5173', 'Erin Edwards');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Contoso Operations Hub' }),
  ).toBeVisible();
  await expect(page.getByText('Browse by category')).toBeVisible();
  await shot(page, 'contoso-home');

  await page.getByRole('link', { name: 'Resources', exact: true }).click();
  await expect(page.getByText('Supplier visit policy FAQ (draft)')).toBeVisible(); // editors see drafts
  await shot(page, 'contoso-resources');

  await page.getByPlaceholder('Search titles, summaries and content').fill('near miss');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('Near-miss reporting in 24 hours').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Near-miss reporting in 24 hours' }),
  ).toBeVisible();
  await expect(page.locator('article')).toContainText('four minimum criteria');
  await shot(page, 'contoso-resource');
});

test('Northwind is a different, isolated workspace with its own branding', async ({ page }) => {
  await signInAs(page, 'http://northwind.localhost:5173', 'Nora Nguyen');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Northwind Store Library' }),
  ).toBeVisible();
  await expect(page.getByText('Opening and closing the store').first()).toBeVisible();
  await expect(page.getByText('Contoso')).toHaveCount(0);
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-primary'),
  );
  expect(primary.trim()).toBe('#4338ca');
  await shot(page, 'northwind-home');
});

test('a viewer cannot open drafts and sees no editor controls', async ({ page }) => {
  await signInAs(page, 'http://contoso.localhost:5173', 'Victor Vance');
  await expect(page.getByRole('link', { name: /Taxonomy/ })).toHaveCount(0);
  await page.goto('http://contoso.localhost:5173/resources/supplier-visit-policy-faq-draft');
  await expect(page.getByText('Resource not found')).toBeVisible();
});

test('an unknown host shows "No workspace here"', async ({ page }) => {
  await page.goto('http://nobody.localhost:5173/');
  await expect(page.getByRole('heading', { name: 'No workspace here' })).toBeVisible();
});
