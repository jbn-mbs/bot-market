import { Api } from "grammy";
import { config } from "../../src/config.js";
import { handleGithub, verifyGithub } from "../../src/modules/devmon/hooks.js";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyGithub(raw, req.headers.get("x-hub-signature-256"))) return new Response("bad signature", { status: 401 });
  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return Response.json({ pong: true });
  return Response.json(await handleGithub(new Api(config.opsBotToken), event, JSON.parse(raw)));
}
