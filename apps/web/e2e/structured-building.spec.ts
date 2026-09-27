import {expect, test, type Page} from "@playwright/test";

const camera = async (page: Page) => (await page.getByTestId("place-viewport").getAttribute("data-camera"))!.split(",").map(Number);
const ready = async (page: Page) => expect(page.getByTestId("place-viewport")).toHaveAttribute("data-ready","true");

for (const width of [1280,390]) test(`create a building, enter it and climb its stairs at ${width}`, async ({page}) => {
  const errors:string[]=[], paid:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/api/generate-page",r=>{paid.push(r.request().url());return r.abort();});
  await page.setViewportSize({width,height:width===390?844:900});
  await page.goto("/sketch/world?demo=1");await ready(page);
  await page.getByRole("combobox",{name:"Starting layout"}).selectOption("empty");
  await page.getByRole("combobox",{name:"Component type"}).selectOption("building");
  await page.getByRole("button",{name:"Add object",exact:true}).click();
  await page.getByRole("combobox",{name:"Building floors"}).selectOption("2");
  await page.getByRole("textbox",{name:"Floor 2 name"}).fill("Workshop loft");
  await page.getByRole("button",{name:"Add window",exact:true}).click();
  await expect(page.getByRole("combobox",{name:"Window 2 wall"})).toBeVisible();
  await page.getByRole("combobox",{name:"Window 2 floor"}).selectOption("1");
  await page.getByRole("checkbox",{name:"Confirm authored dimensions"}).check();
  await page.getByRole("button",{name:"Preview",exact:true}).click();
  await expect(page.getByRole("region",{name:"World change preview"})).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button",{name:"Cancel preview",exact:true}).click();
  await page.getByRole("button",{name:"3D",exact:true}).click();await ready(page);
  await page.screenshot({path:`test-results/structured-building-${width}-exterior.png`});
  await page.getByRole("button",{name:"Walk",exact:true}).click();await ready(page);
  await page.getByTestId("place-viewport").scrollIntoViewIfNeeded();
  await page.keyboard.down("w");
  try {await expect.poll(async()=>(await camera(page))[2],{intervals:[30]}).toBeLessThan(12.4);} finally {await page.keyboard.up("w");}
  expect((await camera(page))[1]).toBeCloseTo(1.6,1);
  await page.screenshot({path:`test-results/structured-building-${width}-inside.png`});
  await page.keyboard.down("a");
  try {await expect.poll(async()=>(await camera(page))[0],{intervals:[30]}).toBeLessThan(7.15);} finally {await page.keyboard.up("a");}
  // Correct input-delivery overshoot before entering the narrow stair opening.
  await page.waitForTimeout(150);
  for (let i=0;i<40;i++) {
    const x=(await camera(page))[0]!; if(Math.abs(x-7.05)<0.14) break;
    await page.keyboard.press(x>7.05?"a":"d",{delay:5});
    await page.waitForTimeout(150);
  }
  expect((await camera(page))[0]).toBeGreaterThan(6.9);
  expect((await camera(page))[0]).toBeLessThan(7.2);
  await page.keyboard.down("w");
  try {await expect.poll(async()=>(await camera(page))[1]).toBeGreaterThan(4.7);await expect.poll(async()=>(await camera(page))[2],{intervals:[30]}).toBeLessThan(6.3);} finally {await page.keyboard.up("w");}
  await page.keyboard.down("ArrowLeft");
  try {await expect.poll(async()=>Number(await page.getByTestId("place-viewport").getAttribute("data-yaw")),{intervals:[30]}).toBeGreaterThan(3.12);} finally {await page.keyboard.up("ArrowLeft");}
  await page.screenshot({path:`test-results/structured-building-${width}-loft.png`});
  await page.keyboard.down("ArrowRight");
  try {await expect.poll(async()=>Number(await page.getByTestId("place-viewport").getAttribute("data-yaw")),{intervals:[30]}).toBeLessThan(0.02);} finally {await page.keyboard.up("ArrowRight");}
  const upper=await camera(page);expect(upper[1]).toBeCloseTo(4.8,1);
  await page.keyboard.down("s");
  try {await expect.poll(async()=>(await camera(page))[2]).toBeGreaterThan(12.1);} finally {await page.keyboard.up("s");}
  await expect.poll(async()=>(await camera(page))[1]).toBeLessThan(1.7);
  await page.keyboard.down("d");
  try {await expect.poll(async()=>(await camera(page))[0],{intervals:[30]}).toBeGreaterThan(9.95);} finally {await page.keyboard.up("d");}
  await page.keyboard.down("s");
  try {await expect.poll(async()=>(await camera(page))[2]).toBeGreaterThan(15.3);} finally {await page.keyboard.up("s");}
  const range=await page.getByTestId("place-viewport").locator("canvas").evaluate(el=>{const c=document.createElement("canvas");c.width=c.height=64;const ctx=c.getContext("2d")!;ctx.drawImage(el as HTMLCanvasElement,0,0,64,64);const a=[...ctx.getImageData(0,0,64,64).data].filter((_,i)=>i%4!==3);return Math.max(...a)-Math.min(...a);});
  expect(range).toBeGreaterThan(30);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);expect(paid).toEqual([]);
});
