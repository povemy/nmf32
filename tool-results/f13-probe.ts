// Isolated probe of mockPspAllowed() production fail-closed semantics.
process.env.NODE_ENV = "production";
const { PrismaClient } = await import("@prisma/client");
const { PSP_MOCK_ENABLED_SETTING_KEY, mockPspAllowed } = await import("/home/z/my-project/src/lib/psp.ts");
const db = new PrismaClient();
try {
  // T1: row MISSING in production → must be false (fail closed)
  await db.setting.deleteMany({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY } });
  console.log("T1 prod row-missing:", (await mockPspAllowed()) === false ? "PASS (denied)" : "FAIL (allowed!)");
  // T2: row MALFORMED → false
  await db.setting.upsert({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY }, create: { key: PSP_MOCK_ENABLED_SETTING_KEY, valueJson: "not-json{" }, update: { valueJson: "not-json{" } });
  console.log("T2 prod row-malformed:", (await mockPspAllowed()) === false ? "PASS (denied)" : "FAIL (allowed!)");
  // T3: row explicitly true → allowed (conscious opt-in)
  await db.setting.upsert({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY }, create: { key: PSP_MOCK_ENABLED_SETTING_KEY, valueJson: "true" }, update: { valueJson: "true" } });
  console.log("T3 prod explicit-true:", (await mockPspAllowed()) === true ? "PASS (allowed)" : "FAIL (denied!)");
  // T4: truthy non-boolean → denied
  await db.setting.upsert({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY }, create: { key: PSP_MOCK_ENABLED_SETTING_KEY, valueJson: "1" }, update: { valueJson: "1" } });
  console.log("T4 prod truthy-non-bool:", (await mockPspAllowed()) === false ? "PASS (denied)" : "FAIL (allowed!)");
  // cleanup: remove the probe row entirely (restores the pre-probe state)
  await db.setting.deleteMany({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY } });
  console.log("cleanup: probe Setting rows removed");
} finally { await db.$disconnect(); }
