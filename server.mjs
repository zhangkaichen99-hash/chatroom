import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 4180);
const ROOT = new URL(".", import.meta.url).pathname;
const rooms = new Map();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json; charset=utf-8"],
]);

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { messages: [], clients: new Set() });
  }
  return rooms.get(roomId);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Body too large");
  }
  return JSON.parse(body);
}

function isValidEncryptedMessage(message) {
  return (
    typeof message?.id === "string" &&
    typeof message?.senderId === "string" &&
    typeof message?.iv === "string" &&
    typeof message?.ciphertext === "string" &&
    message.iv.length < 200 &&
    message.ciphertext.length < 70_000
  );
}

function writeSse(response, eventName, data) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "86400",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const messageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  const eventsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);

  if (request.method === "POST" && messageMatch) {
    try {
      const roomId = decodeURIComponent(messageMatch[1]);
      const room = getRoom(roomId);
      const encryptedMessage = await readBody(request);

      if (!isValidEncryptedMessage(encryptedMessage)) {
        sendJson(response, 400, { error: "Invalid encrypted message" });
        return;
      }

      room.messages.push(encryptedMessage);
      if (room.messages.length > 250) room.messages.splice(0, room.messages.length - 250);

      for (const client of room.clients) {
        writeSse(client, "message", encryptedMessage);
      }

      sendJson(response, 201, { ok: true });
    } catch {
      sendJson(response, 400, { error: "Could not accept message" });
    }
    return;
  }

  if (request.method === "GET" && eventsMatch) {
    const roomId = decodeURIComponent(eventsMatch[1]);
    const room = getRoom(roomId);

    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");

    for (const message of room.messages) {
      writeSse(response, "message", message);
    }

    room.clients.add(response);
    request.on("close", () => room.clients.delete(response));
    return;
  }

  if (request.method === "GET") {
    await handleStatic(request, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`QuietRoom is running at http://localhost:${PORT}`);
});
