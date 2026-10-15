import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const MIN_PASSWORD = 12;
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const PRIMARY_EMAIL = "mel.wade@flcoe.org";
const PRIMARY_PASSWORD_HASH =
  "320aae528f2487c05ea5a3628e763cd2:fd89bb7ea9f2663275cf611fd9ab93427821e6c86415aedbf5380df4e61401b6bdf82f683366584056a169fd1a810bfeafff2b9ee8cedfc8c2da0cf2f24cbcf9";

let usersPath = "";
let sessionsPath = "";
let users = [];
let sessions = [];
let writeChain = Promise.resolve();

export function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_MS / 1000);
  return `unifi_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return "unifi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

export function readCookie(header, name) {
  if (!header) return "";
  const parts = header.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  if (!match) return "";
  return decodeURIComponent(match.slice(name.length + 1));
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const key = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export function visibleSites(sites, user) {
  const list = Array.isArray(sites) ? sites : [];
  if (!user || user.disabled) return [];
  if (user.fullAccess) return list;
  const allowed = new Set(user.siteIds || []);
  return list.filter((site) => allowed.has(site.id));
}

export async function initAuth(dataDir) {
  usersPath = path.join(dataDir, "users.json");
  sessionsPath = path.join(dataDir, "sessions.json");
  await mkdir(dataDir, { recursive: true });
  users = await readJson(usersPath, []);
  sessions = await readJson(sessionsPath, []);
  await ensurePrimaryUser();
  pruneSessions();
  await persistSessions();
}

export function findUserByToken(token) {
  pruneSessions();
  const session = sessions.find((item) => item.token === token && item.expiresAt > Date.now());
  if (!session) return null;
  const user = users.find((item) => item.id === session.userId);
  if (!user || user.disabled) return null;
  return publicUser(user);
}

export async function login(email, password) {
  const user = users.find((item) => item.email === normalizeEmail(email));
  if (!user) return { error: "Email or password is incorrect." };
  const matches = await verifyPassword(password, user.passwordHash);
  if (!matches) return { error: "Email or password is incorrect." };
  if (user.disabled) return { error: "This account is disabled." };
  const token = randomBytes(32).toString("hex");
  sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_MS });
  await persistSessions();
  return { token, user: publicUser(user) };
}

export async function logout(token) {
  sessions = sessions.filter((item) => item.token !== token);
  await persistSessions();
}

export function listUsers() {
  return users.map(publicUser);
}

export async function createUser(input) {
  const email = normalizeEmail(input.email);
  const error = validateUser(input, { creating: true, email });
  if (error) return { error };
  if (users.some((item) => item.email === email)) return { error: "That email is already used." };
  const user = {
    id: randomBytes(12).toString("hex"),
    email,
    passwordHash: await hashPassword(input.password),
    fullAccess: Boolean(input.fullAccess),
    admin: Boolean(input.admin),
    siteIds: input.fullAccess ? [] : uniqueIds(input.siteIds),
    disabled: false,
  };
  users.push(user);
  await persistUsers();
  return { user: publicUser(user) };
}

export async function updateUser(id, input) {
  const user = users.find((item) => item.id === id);
  if (!user) return { error: "User not found." };
  const email = input.email == null ? user.email : normalizeEmail(input.email);
  const next = {
    ...user,
    email,
    fullAccess: input.fullAccess == null ? user.fullAccess : Boolean(input.fullAccess),
    admin: input.admin == null ? Boolean(user.admin) : Boolean(input.admin),
    siteIds: input.siteIds == null ? user.siteIds : uniqueIds(input.siteIds),
    disabled: input.disabled == null ? user.disabled : Boolean(input.disabled),
  };
  if (next.fullAccess) next.siteIds = [];
  const error = validateUser(
    { ...next, password: input.password || "" },
    { creating: false, email, ignoreId: id },
  );
  if (error) return { error };
  if (users.some((item) => item.email === email && item.id !== id)) return { error: "That email is already used." };
  if (losesLastAdmin(user, next)) return { error: "Keep at least one enabled admin." };
  if (input.password) next.passwordHash = await hashPassword(input.password);
  Object.assign(user, next);
  if (user.disabled) sessions = sessions.filter((item) => item.userId !== user.id);
  await persistUsers();
  await persistSessions();
  return { user: publicUser(user) };
}

export async function changePassword(userId, currentPassword, nextPassword) {
  const user = users.find((item) => item.id === userId);
  if (!user || user.disabled) return { error: "User not found." };
  const matches = await verifyPassword(currentPassword, user.passwordHash);
  if (!matches) return { error: "Current password is incorrect." };
  if (String(nextPassword || "").length < MIN_PASSWORD) {
    return { error: "Use a password of at least 12 characters." };
  }
  user.passwordHash = await hashPassword(nextPassword);
  await persistUsers();
  return { ok: true };
}

export async function deleteUser(id) {
  const user = users.find((item) => item.id === id);
  if (!user) return { error: "User not found." };
  if (user.admin && !user.disabled && enabledAdmins().length <= 1) {
    return { error: "Keep at least one enabled admin." };
  }
  users = users.filter((item) => item.id !== id);
  sessions = sessions.filter((item) => item.userId !== id);
  await persistUsers();
  await persistSessions();
  return { ok: true };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullAccess: Boolean(user.fullAccess),
    admin: Boolean(user.admin),
    siteIds: user.fullAccess ? [] : [...(user.siteIds || [])],
    disabled: Boolean(user.disabled),
  };
}

function validateUser(input, { creating, email, ignoreId }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "")) return "Enter a valid email address.";
  const password = input.password == null ? "" : String(input.password);
  if ((creating || password) && password.length < MIN_PASSWORD) {
    return "Use a password of at least 12 characters.";
  }
  if (!input.fullAccess && uniqueIds(input.siteIds).length === 0) return "Select at least one site.";
  if (ignoreId && users.some((item) => item.email === email && item.id !== ignoreId)) {
    return "That email is already used.";
  }
  return "";
}

function losesLastAdmin(current, next) {
  const wasAdmin = current.admin && !current.disabled;
  const staysAdmin = next.admin && !next.disabled;
  return wasAdmin && !staysAdmin && enabledAdmins().length <= 1;
}

function enabledAdmins() {
  return users.filter((item) => item.admin && !item.disabled);
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function ensurePrimaryUser() {
  const existing = users.find((item) => item.email === PRIMARY_EMAIL);
  if (existing) {
    if (!existing.admin) {
      existing.admin = true;
      await persistUsers();
    }
    return;
  }
  if (users.length > 0) return;
  users.push({
    id: randomBytes(12).toString("hex"),
    email: PRIMARY_EMAIL,
    passwordHash: PRIMARY_PASSWORD_HASH,
    fullAccess: true,
    admin: true,
    siteIds: [],
    disabled: false,
  });
  await persistUsers();
}

function pruneSessions() {
  const now = Date.now();
  sessions = sessions.filter((item) => item.expiresAt > now);
}

async function persistUsers() {
  await enqueue(() => writeFile(usersPath, JSON.stringify({ users })));
}

async function persistSessions() {
  await enqueue(() => writeFile(sessionsPath, JSON.stringify({ sessions })));
}

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (file.endsWith("users.json")) return Array.isArray(parsed.users) ? parsed.users : fallback;
    if (file.endsWith("sessions.json")) return Array.isArray(parsed.sessions) ? parsed.sessions : fallback;
    return fallback;
  } catch {
    return fallback;
  }
}
