import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initAuth, listUsers, login, verifyPassword, visibleSites, createUser, updateUser, deleteUser, changePassword } from "./auth.mjs";

const primaryHash =
  "320aae528f2487c05ea5a3628e763cd2:fd89bb7ea9f2663275cf611fd9ab93427821e6c86415aedbf5380df4e61401b6bdf82f683366584056a169fd1a810bfeafff2b9ee8cedfc8c2da0cf2f24cbcf9";

test("primary password hash matches and full access sees every site", async () => {
  assert.match(primaryHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("not-the-password", primaryHash), false);
  const sites = [
    { id: "a", name: "North" },
    { id: "b", name: "South" },
  ];
  assert.deepEqual(visibleSites(sites, { fullAccess: true, siteIds: [], disabled: false }), sites);
  assert.deepEqual(
    visibleSites(sites, { fullAccess: false, siteIds: ["b"], disabled: false }).map((site) => site.id),
    ["b"],
  );
});

test("seeds the primary user and can add, disable, and delete another user", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "unifi-auth-"));
  await initAuth(dir);
  const seeded = listUsers();
  assert.equal(seeded[0].email, "mel.wade@flcoe.org");
  assert.equal(seeded[0].fullAccess, true);
  assert.equal(seeded[0].admin, true);

  const created = await createUser({
    email: "tech@example.com",
    password: "yard-gate-key",
    fullAccess: false,
    admin: false,
    siteIds: ["site-west"],
  });
  assert.equal(created.user.siteIds[0], "site-west");
  assert.equal(created.user.admin, false);

  const signedIn = await login("tech@example.com", "yard-gate-key");
  assert.equal(signedIn.user.email, "tech@example.com");

  const tooShort = await changePassword(created.user.id, "yard-gate-key", "short-pass");
  assert.match(tooShort.error, /12 characters/);
  const wrong = await changePassword(created.user.id, "not-the-password", "a-longer-secret");
  assert.match(wrong.error, /incorrect/);
  const changed = await changePassword(created.user.id, "yard-gate-key", "a-longer-secret");
  assert.equal(changed.ok, true);
  const withNew = await login("tech@example.com", "a-longer-secret");
  assert.equal(withNew.user.email, "tech@example.com");

  const disabled = await updateUser(created.user.id, { disabled: true });
  assert.equal(disabled.user.disabled, true);
  const blocked = await login("tech@example.com", "a-longer-secret");
  assert.match(blocked.error, /disabled/);

  const removed = await deleteUser(created.user.id);
  assert.equal(removed.ok, true);
  const demoted = await updateUser(seeded[0].id, { admin: false });
  assert.match(demoted.error, /admin/);
  const locked = await deleteUser(seeded[0].id);
  assert.match(locked.error, /admin/);
  await rm(dir, { recursive: true, force: true });
});

test("keeps a saved account list that replaced the original user", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "unifi-auth-"));
  await writeFile(
    path.join(dir, "users.json"),
    JSON.stringify({
      users: [
        {
          id: "demo",
          email: "demo@flcoe.org",
          passwordHash: "saved-hash",
          fullAccess: true,
          admin: true,
          siteIds: [],
          disabled: false,
        },
      ],
    }),
  );
  await initAuth(dir);
  assert.deepEqual(
    listUsers().map((user) => user.email),
    ["demo@flcoe.org"],
  );
  await rm(dir, { recursive: true, force: true });
});
