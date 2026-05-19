interface Env {
  MESSAGES: KVNamespace;
  DOMAINS: string;
  API_KEY?: string;
  FORWARD_TO?: string;
  MAX_MESSAGES?: string;
}

type StoredMessage = {
  id: string;
  to: string;
  from: string;
  subject: string;
  receivedAt: string;
  raw: string;
  preview: string;
  text: string | null;
};

type DisplayMessage = StoredMessage & {
  cleanPreview: string;
  cleanText: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const domains = parseDomains(env.DOMAINS);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (env.API_KEY && !isAuthorized(request, env.API_KEY)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (domains.length === 0) {
      return json({ error: "No domains configured" }, 500);
    }

    const url = new URL(request.url);

    if (url.pathname === "/domains" && request.method === "GET") {
      return json({ domains });
    }

    if (url.pathname === "/create" && request.method === "POST") {
      const local = generateLocalPart();
      const tag = normalizeTag(url.searchParams.get("tag"));
      const address = `${local}${tag ? `+${tag}` : ""}@${domains[0]}`;
      await ensureAddressIndex(env, address);
      return json({ address }, 201);
    }

    if (url.pathname === "/messages" && request.method === "GET") {
      const addressParam = url.searchParams.get("address");
      if (!addressParam) {
        return json({ error: "Missing address" }, 400);
      }
      const address = normalizeAddress(addressParam, domains);
      if (!address) {
        return json({ error: "Invalid address" }, 400);
      }
      const ids = await getAddressIndex(env, address);
      const messages = await Promise.all(
        ids.map((id) => env.MESSAGES.get(`msg:${id}`, "json"))
      );
      return json({
        address,
        messages: messages.filter(Boolean).map(formatMessageForResponse),
      });
    }

    if (url.pathname.startsWith("/messages/") && request.method === "GET") {
      const id = url.pathname.replace("/messages/", "");
      if (!id) {
        return json({ error: "Missing id" }, 400);
      }
      const message = await env.MESSAGES.get(`msg:${id}`, "json");
      if (!message) {
        return json({ error: "Not found" }, 404);
      }
      return json(formatMessageForResponse(message));
    }

    return json({ error: "Not found" }, 404);
  },

  async email(message: EmailMessage, env: Env): Promise<void> {
    const domains = parseDomains(env.DOMAINS);
    const id = crypto.randomUUID();
    const to = extractAddress(message.to) || message.to || "";
    const from = extractAddress(message.from) || message.from || "";
    const subject = message.headers.get("subject") || "";
    const raw = await readRaw(message.raw);
    const text = extractPlainText(raw);
    const preview = text ? text.slice(0, 280) : extractPreview(raw, 280);
    const receivedAt = new Date().toISOString();

    const normalizedTo = normalizeAddress(to, domains);
    if (!normalizedTo) {
      return;
    }
    const stored: StoredMessage = {
      id,
      to: normalizedTo,
      from,
      subject,
      receivedAt,
      raw,
      preview,
      text,
    };

    await env.MESSAGES.put(`msg:${id}`, JSON.stringify(stored));

    await addToAddressIndexes(env, normalizedTo, id);

    if (env.FORWARD_TO) {
      await message.forward(env.FORWARD_TO);
    }
  },
};

function isAuthorized(request: Request, apiKey: string): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const [, token] = header.split(" ");
  return token === apiKey;
}

function generateLocalPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => (b % 36).toString(36))
    .join("");
}

function parseDomains(input?: string): string[] {
  if (!input) return [];
  const parts = input
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unique = new Set<string>();
  for (const domain of parts) {
    unique.add(domain);
  }
  return Array.from(unique);
}

function normalizeAddress(input: string, domains: string[]): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const [local, domain] = trimmed.split("@");
    if (!local || !domain) return null;
    if (!domains.includes(domain)) return null;
    return `${local}@${domain}`;
  }

  const defaultDomain = domains[0];
  if (!defaultDomain) return null;
  return `${trimmed}@${defaultDomain}`;
}

function normalizeTag(input: string | null): string | null {
  if (!input) return null;
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;
  return cleaned.replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

function getBaseAddress(address: string): string {
  const [local, domain] = address.split("@");
  if (!local || !domain) return address;
  const baseLocal = local.split("+")[0];
  return `${baseLocal}@${domain}`;
}

async function ensureAddressIndex(env: Env, address: string): Promise<void> {
  const key = `addr:${address.toLowerCase()}`;
  const existing = await env.MESSAGES.get(key);
  if (!existing) {
    await env.MESSAGES.put(key, JSON.stringify([]));
  }

  const baseAddress = getBaseAddress(address).toLowerCase();
  if (baseAddress !== address.toLowerCase()) {
    const baseKey = `addr:${baseAddress}`;
    const baseExisting = await env.MESSAGES.get(baseKey);
    if (!baseExisting) {
      await env.MESSAGES.put(baseKey, JSON.stringify([]));
    }
  }
}

async function getAddressIndex(env: Env, address: string): Promise<string[]> {
  const key = `addr:${address.toLowerCase()}`;
  const raw = await env.MESSAGES.get(key);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function addToAddressIndex(env: Env, address: string, id: string): Promise<void> {
  const key = `addr:${address.toLowerCase()}`;
  const max = Number(env.MAX_MESSAGES || "20");
  const current = await getAddressIndex(env, address);
  const updated = [id, ...current.filter((item) => item !== id)].slice(0, max);
  await env.MESSAGES.put(key, JSON.stringify(updated));
}

async function addToAddressIndexes(env: Env, address: string, id: string): Promise<void> {
  await addToAddressIndex(env, address, id);
  const baseAddress = getBaseAddress(address);
  if (baseAddress !== address) {
    await addToAddressIndex(env, baseAddress, id);
  }
}

async function readRaw(stream: ReadableStream): Promise<string> {
  const response = new Response(stream);
  const text = await response.text();
  return text.slice(0, 200000);
}

function extractPreview(raw: string, maxLength: number): string {
  const parts = raw.split("\n\n");
  const body = parts.length > 1 ? parts.slice(1).join("\n\n") : raw;
  return body.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanTextForDisplay(input: string): string {
  const normalized = input.replace(/\0/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const cleaned: string[] = [];
  let emptyCount = 0;
  for (const line of lines) {
    const trimmedEnd = line.trimEnd();
    if (!trimmedEnd.trim()) {
      emptyCount += 1;
      if (emptyCount <= 2) cleaned.push("");
      continue;
    }
    emptyCount = 0;
    cleaned.push(trimmedEnd);
  }
  return cleaned.join("\n").trim();
}

function extractPlainText(raw: string): string | null {
  const split = splitHeadersBody(raw);
  if (!split) return null;

  const boundary = getBoundary(split.headers);
  if (boundary) {
    const parts = split.body.split(`--${boundary}`);
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, "").trim();
      if (!trimmed || trimmed === "--") continue;
      const partSplit = splitHeadersBody(trimmed);
      if (!partSplit) continue;
      if (hasPlainText(partSplit.headers)) {
        return decodeBody(partSplit.body, partSplit.headers);
      }
    }
    return null;
  }

  if (hasPlainText(split.headers)) {
    return decodeBody(split.body, split.headers);
  }

  return null;
}

function splitHeadersBody(raw: string): { headers: string; body: string } | null {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  const index = match.index;
  return {
    headers: raw.slice(0, index),
    body: raw.slice(index + match[0].length),
  };
}

function getBoundary(headers: string): string | null {
  const match = headers.match(/boundary="?([^";]+)"?/i);
  return match && match[1] ? match[1] : null;
}

function hasPlainText(headers: string): boolean {
  return /content-type:\s*text\/plain/i.test(headers);
}

function decodeBody(body: string, headers: string): string {
  const encodingMatch = headers.match(/content-transfer-encoding:\s*([^\s;]+)/i);
  const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : "7bit";
  if (encoding === "base64") {
    const cleaned = body.replace(/\s+/g, "");
    try {
      return atob(cleaned);
    } catch {
      return body.trim();
    }
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body.trim();
}

function decodeQuotedPrintable(input: string): string {
  const softBreaksRemoved = input.replace(/=\r?\n/g, "");
  return softBreaksRemoved.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return String.fromCharCode(code);
  });
}

function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  if (match && match[1]) return match[1].trim().toLowerCase();
  return value.trim().toLowerCase();
}

function formatMessageForResponse(message: StoredMessage): DisplayMessage {
  const baseText = message.text ?? "";
  const cleanText = baseText ? cleanTextForDisplay(baseText) : null;
  const cleanPreviewSource = cleanText || message.preview || "";
  const cleanPreview = cleanTextForDisplay(cleanPreviewSource).replace(/\s+/g, " ").trim();
  return {
    ...message,
    cleanPreview,
    cleanText,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}
