/**
 * Bootstrap a person and a one-time link code without going through the bot
 * (needed for the very first admin/founder).
 *   npm run invite -- founder "Bikram Kalsi"
 */
import "dotenv/config";
import { db, must } from "../src/db.js";
import { issueLinkCode } from "../src/core/auth.js";

const [role, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();
const roles = ["member", "reviewer", "dev", "founder", "admin"];
if (!roles.includes(role) || !name) {
  console.error(`Usage: npm run invite -- <${roles.join("|")}> "<full name>"`);
  process.exit(1);
}
const person = (must(await db().from("people").insert({ name, role }).select("id")) as any[])[0];
const code = await issueLinkCode(person.id);
console.log(`${name} (${role}): send /start ${code} to the bot within 72 hours.`);
