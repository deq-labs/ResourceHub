import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

async function signInAs(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: /sign-on|sign in/i }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('a Contoso admin manages members, branding and sees the audit trail', async ({ page }) => {
  await signInAs(page, 'http://contoso.localhost:5173', 'Adam Alvarez');
  await page.getByRole('link', { name: /Admin/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace admin' })).toBeVisible();
  await expect(page.getByText('olivia@contoso.example')).toBeVisible();
  await shot(page, 'admin-members');

  await page.getByRole('link', { name: 'Branding' }).click();
  await expect(page.getByText('Live preview')).toBeVisible();
  await shot(page, 'admin-branding');

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.locator('code', { hasText: 'auth.login' }).first()).toBeVisible();
  await shot(page, 'admin-audit');
});

test('platform admin impersonates a tenant user with a recorded reason', async ({
  page,
  context,
}) => {
  await page.goto('http://admin.localhost:5173/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Pat Platform/ }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await expect(page.getByText('Contoso Pharma')).toBeVisible();
  await shot(page, 'platform-tenants');

  await page
    .getByRole('row', { name: /Contoso Pharma/ })
    .getByRole('button', { name: 'Impersonate' })
    .click();
  await page
    .getByLabel('Member', { exact: true })
    .selectOption({ label: 'Victor Vance · viewer · victor@contoso.example' });
  await page.getByLabel(/Reason/).fill('Demo: verifying what a viewer sees on the hub');
  await shot(page, 'platform-impersonate');
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Start impersonation' }).click(),
  ]);
  await tab.waitForLoadState();
  await expect(tab.getByText(/is viewing as Victor Vance/)).toBeVisible();
  await shot(tab, 'impersonation-banner');
});
