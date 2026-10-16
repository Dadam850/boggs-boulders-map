import puppeteer from "puppeteer-core";
import { mkdir } from "fs/promises";

const BASE = "http://127.0.0.1:41773";
const OUT = "/opt/cursor/artifacts";

async function settle(page) {
  for (let i = 0; i < 4; i++) {
    try {
      await page.waitForSelector('[data-testid="rider-name"]', { timeout: 20000 });
      await new Promise((r) => setTimeout(r, 600));
      if (await page.$('[data-testid="rider-name"]')) return;
    } catch (error) {
      console.log("waiting for login", error.message);
    }
  }
  throw new Error("login screen did not stay up");
}

async function setInput(page, selector, value) {
  await page.$eval(
    selector,
    (el, next) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      proto.set.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

async function login(page, name, groupCode) {
  await settle(page);
  await setInput(page, '[data-testid="rider-name"]', name);
  await setInput(page, '[data-testid="group-code"]', groupCode);
  await page.click('[data-testid="start"]');
  await page.waitForSelector('[data-testid="map"]', { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes("you"), { timeout: 20000 });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const adamCtx = await browser.createBrowserContext();
  const jordanCtx = await browser.createBrowserContext();
  await adamCtx.overridePermissions(BASE, ["geolocation"]);
  await jordanCtx.overridePermissions(BASE, ["geolocation"]);
  const adam = await adamCtx.newPage();
  const jordan = await jordanCtx.newPage();
  adam.setDefaultTimeout(30000);
  jordan.setDefaultTimeout(30000);
  adam.on("pageerror", (err) => console.log("ADAM pageerror", err.message));
  jordan.on("pageerror", (err) => console.log("JORDAN pageerror", err.message));
  await adam.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await jordan.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });

  const start = { latitude: 31.416, longitude: -86.572 };
  await adam.setGeolocation({ ...start, accuracy: 6 });
  await jordan.setGeolocation({ latitude: 31.412, longitude: -86.565, accuracy: 6 });
  await adam.goto(BASE, { waitUntil: "domcontentloaded" });
  await jordan.goto(BASE, { waitUntil: "domcontentloaded" });
  const groupCode = `c${Date.now().toString().slice(-8)}`;
  console.log("group", groupCode);
  await login(adam, "Adam", groupCode);
  await adam.waitForSelector(".park-trail", { timeout: 15000 });
  const trailBox = await adam.evaluate(() => {
    const paths = [...document.querySelectorAll(".park-trail")];
    return paths.map((el) => {
      const box = el.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    });
  });
  console.log("park trails", JSON.stringify(trailBox));
  if (!trailBox.some((box) => box.w > 80 && box.h > 80)) throw new Error("trail lines are not visible");
  await adam.screenshot({ path: `${OUT}/trail-lines.png` });
  await login(jordan, "Jordan", groupCode);
  await adam.waitForFunction(() => document.body.innerText.includes("Jordan"), { timeout: 25000 });
  await jordan.waitForFunction(() => document.body.innerText.includes("Adam"), { timeout: 25000 });

  const steps = [
    { latitude: 31.4164, longitude: -86.5714 },
    { latitude: 31.4169, longitude: -86.5706 },
    { latitude: 31.4175, longitude: -86.5698 },
    { latitude: 31.4181, longitude: -86.569 },
    { latitude: 31.4186, longitude: -86.5682 },
  ];
  for (const step of steps) {
    await adam.setGeolocation({ ...step, accuracy: 6 });
    await new Promise((r) => setTimeout(r, 700));
  }
  await adam.waitForSelector(".crumb-line.self", { timeout: 15000 });
  await adam.click('[data-testid="center"]');
  await new Promise((r) => setTimeout(r, 600));
  const adamCrumbs = await adam.evaluate(() => document.querySelectorAll(".crumb-line.self").length);
  console.log("adam crumb lines", adamCrumbs);
  await adam.screenshot({ path: `${OUT}/breadcrumbs.png` });

  await jordan.waitForSelector(".crumb-line:not(.self)", { timeout: 25000 });
  await jordan.click('[data-testid="everyone"]');
  await new Promise((r) => setTimeout(r, 800));
  await jordan.screenshot({ path: `${OUT}/breadcrumbs-group.png` });
  console.log("jordan sees adam's path");

  const trail = await fetch(`${BASE}/api/riders?group=${groupCode}`).then((res) => res.json());
  const adamRider = (trail.riders ?? []).find((rider) => rider.name === "Adam");
  const adamTrail = (trail.trails ?? []).find((item) => item.name === "Adam");
  console.log("stored crumbs", adamTrail ? adamTrail.crumbs.length : 0);
  if (!adamRider || !adamTrail || adamTrail.crumbs.length < 3) throw new Error("breadcrumb was not stored in blob");

  const oldAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const keep = await fetch(`${BASE}/api/riders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: adamRider.userId,
      name: "Adam",
      group: groupCode,
      lat: adamRider.lat,
      lng: adamRider.lng,
      record: false,
      trail: [...adamTrail.crumbs, { lat: 31.405, lng: -86.58, at: oldAt }],
    }),
  }).then((res) => res.json());
  const kept = (keep.trails ?? []).find((item) => item.userId === adamRider.userId);
  if (!kept?.crumbs.some((crumb) => crumb.at === oldAt)) throw new Error("old crumb was dropped");
  console.log("90-day crumb kept", kept.crumbs.length);

  const paused = await fetch(`${BASE}/api/riders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: adamRider.userId,
      name: "Adam",
      group: groupCode,
      lat: 31.42,
      lng: -86.56,
      record: false,
      trail: kept.crumbs,
    }),
  }).then((res) => res.json());
  const pausedTrail = (paused.trails ?? []).find((item) => item.userId === adamRider.userId);
  if (pausedTrail.crumbs.length !== kept.crumbs.length) throw new Error("paused recording still added a point");
  console.log("paused recording left the path alone");

  await adam.click('[data-testid="crumbs-show"]');
  await adam.waitForFunction(() => document.querySelectorAll(".crumb-line").length === 0, { timeout: 10000 });
  console.log("paths hidden");
  await adam.screenshot({ path: `${OUT}/paths-hidden.png` });
  await adam.click('[data-testid="crumbs-show"]');
  await adam.waitForSelector(".crumb-line.self", { timeout: 10000 });

  await adam.click('[data-testid="crumbs-clear"]');
  await adam.waitForFunction(() => document.body.innerText.includes("Erase path?"), { timeout: 5000 });
  await adam.click('[data-testid="crumbs-clear"]');
  await adam.waitForFunction(
    async (group, userId) => {
      const res = await fetch(`/api/riders?group=${group}`);
      const data = await res.json();
      const mine = (data.trails ?? []).find((item) => item.userId === userId);
      return mine && mine.crumbs.length === 0 && typeof mine.clearedAt === "number";
    },
    { timeout: 15000 },
    groupCode,
    adamRider.userId,
  );
  console.log("path cleared from blob storage");

  await browser.close();
  console.log("CRUMBS_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
