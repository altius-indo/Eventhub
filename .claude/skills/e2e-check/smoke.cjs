// Smoke flow: sign up by email OTP, create an event, add a function and a family, open the guest link.
// Copy this file as a starting point for feature-specific flows.
const { chromium, devices } = require("playwright");
const { Client } = require("pg");
const path = require("path");

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS || path.join(require("os").tmpdir(), "eventhub-e2e");
require("fs").mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
const check = (cond, what) => {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`ok - ${what}`);
};

/** Latest dev-outbox message to an address (OTP codes, invitations, guest links). */
async function latest(to) {
  for (let i = 0; i < 20; i++) {
    const r = await db.query('select body, channel from dev_outbox where "to" = $1 order by created_at desc limit 1', [to]);
    if (r.rows[0]) return r.rows[0];
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no message to ${to}`);
}

async function signUp(page, email, name) {
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", email);
  await page.click("main button[type=submit]");
  await page.waitForURL("**/login/verify");
  await page.fill("#code", (await latest(email)).body.match(/\d{6}/)[0]);
  await page.click("main button:has-text('Verify')");
  await page.waitForURL("**/welcome**");
  await page.fill("#name", name);
  await page.click("main button[type=submit]");
  await page.waitForURL(/\/events/);
}

(async () => {
  await db.connect();
  const browser = await chromium.launch();
  const errors = [];
  const page = await (await browser.newContext({ ...devices["Pixel 7"] })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());

  await signUp(page, "host@example.com", "Asha");
  check(true, "host signs up with an email code");

  await page.click("text=Create event");
  await page.fill("#name", "Smoke Wedding");
  await page.fill("#coupleNames", "Smoke & Test");
  await page.fill("#startDate", "2030-01-10");
  await page.click("main button:has-text('Create event')");
  await page.waitForURL(/\/events\/[0-9a-f-]{36}$/);
  const ev = page.url();
  check(true, "event created");

  await page.goto(`${ev}/schedule/new`);
  await page.fill("#name", "Sangeet");
  await page.click("main button:has-text('Add function')");
  await page.waitForURL(/\/schedule$/);

  await page.goto(`${ev}/guests/new`);
  await page.fill("#householdName", "Sharma family");
  await page.fill("#m0_name", "Rajesh Sharma");
  await page.click("main button:has-text('Add a family')");
  await page.waitForSelector("text=Family added.");
  const link = (await page.textContent("[data-testid=guest-link]")).trim();
  check(/\/g\/[A-Za-z0-9_-]{44}$/.test(link), "family has a guest link");
  await shot(page, "family");

  const guest = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(link);
  await guest.waitForSelector("text=Sharma family");
  check((await guest.locator("text=Sangeet").count()) > 0, "guest link opens the family's page");
  await shot(guest, "guest-page");

  check(errors.length === 0, `no client errors${errors.length ? ` (${errors.join("; ")})` : ""}`);
  console.log(`screenshots: ${SHOTS}`);
  await browser.close();
  await db.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
