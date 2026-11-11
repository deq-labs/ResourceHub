import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

// Needs the worker running (pnpm dev) and the docker-compose SOAP mock.
test('an admin syncs the partner SOAP library; documents arrive as drafts', async ({ page }) => {
  await page.goto('http://contoso.localhost:5173/admin/integrations');
  await page.getByRole('button', { name: /single sign-on/i }).click();
  await page.getByRole('button', { name: /Olivia Owens/ }).click();
  await page.goto('http://contoso.localhost:5173/admin/integrations');

  const card = page
    .locator('div', { has: page.getByText('Partner document library', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Sync now' }) })
    .last();
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected in \d+ ms/)).toBeVisible();

  await card.getByRole('button', { name: 'Sync now' }).click();
  await expect(card.getByText('succeeded').first()).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/6 fetched · 6 new/)).toBeVisible();
  await shot(page, 'admin-integrations');

  await page.goto('http://contoso.localhost:5173/resources?status=draft');
  await expect(page.getByText('Lockout/tagout procedure')).toBeVisible();
});
