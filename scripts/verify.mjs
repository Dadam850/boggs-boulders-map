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
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream"],
  });

  const adamCtx = await browser.createBrowserContext();
  const jordanCtx = await browser.createBrowserContext();
  await adamCtx.overridePermissions(BASE, ["geolocation"]);
  await jordanCtx.overridePermissions(BASE, ["geolocation"]);

  const adam = await adamCtx.newPage();
  const jordan = await jordanCtx.newPage();
  adam.setDefaultTimeout(30000);
  jordan.setDefaultTimeout(30000);
  adam.on("console", (msg) => console.log("ADAM", msg.type(), msg.text()));
  jordan.on("console", (msg) => console.log("JORDAN", msg.type(), msg.text()));
  adam.on("pageerror", (err) => console.log("ADAM pageerror", err.message));

  await adam.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await jordan.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await adam.setGeolocation({ latitude: 31.243, longitude: -86.749873, accuracy: 6 });
  await jordan.setGeolocation({ latitude: 31.2485, longitude: -86.738, accuracy: 6 });

  await adam.goto(BASE, { waitUntil: "domcontentloaded" });
  await jordan.goto(BASE, { waitUntil: "domcontentloaded" });
  const groupCode = `v${Date.now().toString().slice(-8)}`;
  console.log("group", groupCode);
  await login(adam, "Adam", groupCode);
  await login(jordan, "Jordan", groupCode);

  console.log("waiting for map save and the other rider");
  await adam.waitForFunction(() => document.body.innerText.includes("Map saved on this phone"), { timeout: 120000 });
  await adam.waitForFunction(() => document.body.innerText.includes("Jordan"), { timeout: 30000 });
  await jordan.waitForFunction(() => document.body.innerText.includes("Adam"), { timeout: 30000 });

  await adam.click('[data-testid="everyone"]');
  await new Promise((r) => setTimeout(r, 800));
  await adam.screenshot({ path: `${OUT}/map-two-riders.png` });
  console.log("shot two riders");

  const input = await adam.$('[data-testid="camera-input"]');
  await input.uploadFile("/tmp/pin-photo.jpg");
  await adam.waitForSelector('[data-testid="photo-pin"]', { timeout: 15000 });
  await jordan.waitForSelector('[data-testid="photo-pin"]', { timeout: 25000 });
  await adam.waitForSelector('[data-pending="0"]', { timeout: 20000 });
  console.log("both see the photo pin");
  await adam.click('[data-testid="center"]');
  await new Promise((r) => setTimeout(r, 700));
  const pinInfo = await adam.evaluate(() =>
    [...document.querySelectorAll(".photo-pin")].map((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: top ? `${top.tagName}.${top.className}` : null,
      };
    }),
  );
  console.log("pins", JSON.stringify(pinInfo));
  await adam.screenshot({ path: "/tmp/before-click.png" });
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    const handle = await adam.$(".photo-pin");
    if (!handle) continue;
    try {
      await handle.click();
      await adam.waitForSelector('[data-testid="photo-viewer"]', { timeout: 4000 });
      opened = true;
    } catch (error) {
      console.log("photo click retry", error.message);
    }
  }
  if (!opened) throw new Error("photo viewer did not open");
  await adam.screenshot({ path: `${OUT}/photo-viewer.png` });
  console.log("shot photo viewer");
  await adam.click("text/Close");

  await adam.setOfflineMode(true);
  await adam.reload({ waitUntil: "domcontentloaded" });
  await adam.waitForSelector('[data-testid="map"]', { timeout: 20000 });
  await adam.waitForFunction(() => {
    const tiles = [...document.querySelectorAll(".leaflet-tile")];
    return tiles.some((img) => img.complete && img.naturalWidth > 0);
  }, { timeout: 20000 });
  await adam.waitForFunction(() => document.body.innerText.includes("Jordan") || document.body.innerText.includes("you"), { timeout: 20000 });
  const offlineTiles = await adam.evaluate(() =>
    [...document.querySelectorAll(".leaflet-tile")].filter((img) => img.complete && img.naturalWidth > 0).length,
  );
  console.log("offline tiles", offlineTiles);
  await adam.screenshot({ path: `${OUT}/map-offline.png` });

  const offlineInput = await adam.$('[data-testid="camera-input"]');
  await offlineInput.uploadFile("/tmp/pin-photo.jpg");
  await new Promise((r) => setTimeout(r, 500));
  const pendingBefore = await adam.evaluate(() => document.querySelectorAll('[data-pending="1"]').length);
  console.log("pending pins before reload", pendingBefore);
  await adam.reload({ waitUntil: "domcontentloaded" });
  await adam.waitForSelector('[data-testid="map"]', { timeout: 20000 });
  await adam.waitForSelector('[data-pending="1"]', { timeout: 15000 });
  console.log("pending photo survived offline reload");

  const beforeOffline = await fetch(`${BASE}/api/photos?group=${groupCode}`).then((res) => res.json());
  const beforeCount = Array.isArray(beforeOffline.photos) ? beforeOffline.photos.length : 0;
  console.log("photos in Azure before offline shot", beforeCount);

  await adam.setOfflineMode(false);
  await new Promise((r) => setTimeout(r, 1000));
  const probe = await adam.evaluate(async () => {
    let health = "err";
    try {
      health = String((await fetch("/api/health")).status);
    } catch (error) {
      health = String(error);
    }
    return { onLine: navigator.onLine, health, pending: document.querySelectorAll('[data-pending="1"]').length };
  });
  console.log("after online", JSON.stringify(probe));
  await adam.waitForFunction(
    async (group, previous) => {
      try {
        const res = await fetch(`/api/photos?group=${group}`);
        if (!res.ok) return false;
        const data = await res.json();
        return Array.isArray(data.photos) && data.photos.length > previous;
      } catch {
        return false;
      }
    },
    { timeout: 30000 },
    groupCode,
    beforeCount,
  );
  console.log("photo reached Azure after signal returned");

  await browser.close();
  console.log("VERIFY_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
