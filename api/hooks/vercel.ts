import { Api } from "grammy";
import { config } from "../../src/config.js";
import { handleVercel, verifyVercel } from "../../src/modules/devmon/hooks.js";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyVercel(raw, req.headers.get("x-vercel-signature"))) return new Response("bad signature", { status: 401 });
  const result = await handleVercel(new Api(config.opsBotToken), JSON.parse(raw));
  return Response.json(result);
}
