import { Api } from "grammy";
import { config } from "../../src/config.js";
import { handleVercel, verifyVercel } from "../../src/modules/devmon/hooks.js";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyVercel(raw, req.headers.get("x-vercel-signature"))) return new Response("bad signature", { status: 401 });
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response("unparseable payload", { status: 400 }); }
  const result = await handleVercel(new Api(config.opsBotToken), evt);
  return Response.json(result);
}
