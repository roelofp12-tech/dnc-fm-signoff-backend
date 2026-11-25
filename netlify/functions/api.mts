import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

const APPROVERS: Record<string, string> = {
  mbonisi: "Mbonisi Ngcofe",
  mandisa: "Mandisa Jozi",
  roelof: "Roelof Paul (test)",
};
const FORMS: Record<string, string> = {
  dailycheck: "Daily Check",
  contractor: "Contractor On-Site",
  callout: "Callout",
  reactive: "Reactive Maintenance",
};

const ALLOWED_ORIGINS = ["https://stately-naiad-078cd1.netlify.app"];
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
let corsOrigin = "";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "origin" } : {}),
    },
  });

const authorised = (req: Request) => {
  const key = Netlify.env.get("FM_SIGNOFF_KEY");
  return !!key && req.headers.get("x-fm-key") === key;
};
const expired = (r: any) => Date.now() - new Date(r.createdAt).getTime() > EXPIRY_MS;

const reqStore = () => getStore({ name: "requests", consistency: "strong" });
const tokStore = () => getStore({ name: "tokens", consistency: "strong" });

const clean = (s: unknown, max: number) => String(s ?? "").slice(0, max);
const newToken = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

function publicView(r: any, approverKey: string) {
  return {
    id: r.id,
    formType: r.formType,
    formLabel: r.formLabel,
    fields: r.fields,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    approverName: r.approvers[approverKey]?.name,
    status: r.status,
    signed: r.signed,
  };
}

export default async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : "";
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsOrigin
        ? {
            "access-control-allow-origin": corsOrigin,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type, x-fm-key",
            "access-control-max-age": "86400",
            vary: "origin",
          }
        : {},
    });
  }
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [res, arg] = parts;
  const rs = reqStore();
  const ts = tokStore();

  try {
    if (res === "requests" && !authorised(req)) return json({ error: "Not allowed" }, 401);

    if (res === "requests" && req.method === "POST") {
      const body = await req.json();
      const formType = clean(body.formType, 20);
      if (!FORMS[formType]) return json({ error: "Unknown form type" }, 400);
      const keys: string[] = Array.isArray(body.approvers) ? body.approvers.filter((k: string) => APPROVERS[k]) : [];
      if (!keys.length) return json({ error: "Choose at least one approver" }, 400);
      const fields = (Array.isArray(body.fields) ? body.fields : []).slice(0, 20).map((f: any) => [clean(f[0], 60), clean(f[1], 500)]);
      const id = newToken().slice(0, 10);
      const approvers: Record<string, { name: string; token: string }> = {};
      for (const k of keys) {
        const token = newToken();
        approvers[k] = { name: APPROVERS[k], token };
        await ts.setJSON(token, { id, approver: k });
      }
      const record = {
        id,
        formType,
        formLabel: FORMS[formType],
        fields,
        createdAt: new Date().toISOString(),
        createdBy: clean(body.createdBy || "Roelof Paul", 60),
        approvers,
        status: "pending",
        signed: null,
      };
      await rs.setJSON("r/" + id, record);
      return json(record, 201);
    }

    if (res === "requests" && req.method === "GET") {
      const { blobs } = await rs.list({ prefix: "r/" });
      const all = (await Promise.all(blobs.map((b) => rs.get(b.key, { type: "json" })))).filter(Boolean) as any[];
      all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json(all.slice(0, 30));
    }

    if (res === "sign" && arg) {
      const link = (await ts.get(arg, { type: "json" })) as { id: string; approver: string } | null;
      if (!link) return json({ error: "This link isn't valid." }, 404);
      const entry = await rs.getWithMetadata("r/" + link.id, { type: "json" });
      if (!entry) return json({ error: "This request no longer exists." }, 404);
      const record: any = entry.data;

      if (record.status !== "signed" && expired(record))
        return json({ error: "This link has expired. Ask for a new one." }, 410);

      if (req.method === "GET") return json(publicView(record, link.approver));

      if (req.method === "POST") {
        if (record.status === "signed") return json({ error: "already_signed", ...publicView(record, link.approver) }, 409);
        const body = await req.json();
        const name = clean(body.name, 80).trim();
        const signature = String(body.signature || "");
        if (!name) return json({ error: "Enter your name first" }, 400);
        if (!signature.startsWith("data:image/png;base64,") || signature.length > 300000)
          return json({ error: "Signature missing or too large" }, 400);
        record.status = "signed";
        record.signed = {
          name,
          approverKey: link.approver,
          approverListed: record.approvers[link.approver]?.name,
          at: new Date().toISOString(),
          signature,
        };
        const { modified } = await rs.setJSON("r/" + link.id, record, { onlyIfMatch: entry.etag });
        if (!modified) {
          const fresh: any = await rs.get("r/" + link.id, { type: "json" });
          return json({ error: "already_signed", ...publicView(fresh, link.approver) }, 409);
        }
        return json(publicView(record, link.approver));
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e: any) {
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
};

export const config: Config = { path: "/api/*" };
