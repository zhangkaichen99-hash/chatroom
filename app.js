const setupPanel = document.querySelector("#setupPanel");
const chatPanel = document.querySelector("#chatPanel");
const setupForm = document.querySelector("#setupForm");
const messageForm = document.querySelector("#messageForm");
const displayNameInput = document.querySelector("#displayName");
const roomNameInput = document.querySelector("#roomName");
const roomSecretInput = document.querySelector("#roomSecret");
const relayUrlInput = document.querySelector("#relayUrl");
const roomTitle = document.querySelector("#roomTitle");
const connectionStatus = document.querySelector("#connectionStatus");
const copyInviteButton = document.querySelector("#copyInviteButton");
const messages = document.querySelector("#messages");
const messageInput = document.querySelector("#messageInput");
const toast = document.querySelector("#toast");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RELAY_STORAGE_KEY = "quietroom-relay-url";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // QuietRoom still works without offline install caching.
    });
  });
}

let appState = {
  clientId: crypto.randomUUID(),
  displayName: "",
  roomId: "",
  roomSecret: "",
  relayUrl: "",
  cryptoKey: null,
  eventSource: null,
  seenMessages: new Set(),
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function normalizeRoomName(value) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeRelayUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return window.location.origin;
  const url = new URL(trimmed);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function apiUrl(path) {
  return `${appState.relayUrl}${path}`;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function hashToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveRoomKey(roomId, secret) {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`quietroom:${roomId}`),
      iterations: 310_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function roomFingerprint(roomId, secret) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${roomId}:${secret}`));
  return hashToHex(hash).slice(0, 16);
}

async function encryptMessage(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = {
    id: crypto.randomUUID(),
    senderId: appState.clientId,
    senderName: appState.displayName,
    text,
    sentAt: new Date().toISOString(),
  };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, appState.cryptoKey, encoder.encode(JSON.stringify(payload)));

  return {
    id: payload.id,
    senderId: appState.clientId,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

async function decryptMessage(encryptedMessage) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encryptedMessage.iv) },
    appState.cryptoKey,
    base64ToBytes(encryptedMessage.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

function renderMessage(message) {
  if (appState.seenMessages.has(message.id)) return;
  appState.seenMessages.add(message.id);

  const article = document.createElement("article");
  article.className = message.senderId === appState.clientId ? "message own" : "message";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("span");
  sender.textContent = message.senderName;
  const time = document.createElement("time");
  time.dateTime = message.sentAt;
  time.textContent = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.sentAt));
  meta.append(sender, time);

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = message.text;

  article.append(meta, text);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

async function sendMessage(text) {
  const encryptedMessage = await encryptMessage(text);
  const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(appState.roomId)}/messages`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encryptedMessage),
  });

  if (!response.ok) throw new Error("Message send failed");
}

function connectRoom() {
  appState.eventSource?.close();
  appState.eventSource = new EventSource(apiUrl(`/api/rooms/${encodeURIComponent(appState.roomId)}/events?client=${appState.clientId}`));
  connectionStatus.textContent = "Connected privately";

  appState.eventSource.addEventListener("open", () => {
    connectionStatus.textContent = "Connected privately";
  });

  appState.eventSource.addEventListener("message", async (event) => {
    try {
      const encryptedMessage = JSON.parse(event.data);
      const decryptedMessage = await decryptMessage(encryptedMessage);
      renderMessage(decryptedMessage);
    } catch {
      connectionStatus.textContent = "Could not decrypt one message";
    }
  });

  appState.eventSource.addEventListener("error", () => {
    connectionStatus.textContent = "Reconnecting...";
  });
}

function buildInviteUrl(roomId, secret) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams({ room: roomId });
  if (appState.relayUrl && appState.relayUrl !== window.location.origin) params.set("relay", appState.relayUrl);
  url.search = params.toString();
  url.hash = `secret=${encodeURIComponent(secret)}`;
  return url.toString();
}

function readInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  return {
    roomId: params.get("room") ?? "",
    relayUrl: params.get("relay") ?? "",
    secret: hashParams.get("secret") ?? "",
  };
}

async function enterRoom({ displayName, roomId, secret, relayUrl }) {
  appState.displayName = displayName.trim();
  appState.roomId = normalizeRoomName(roomId);
  appState.roomSecret = secret;
  appState.relayUrl = normalizeRelayUrl(relayUrl);
  appState.cryptoKey = await deriveRoomKey(appState.roomId, secret);
  appState.seenMessages = new Set();
  localStorage.setItem(RELAY_STORAGE_KEY, appState.relayUrl);

  roomTitle.textContent = appState.roomId;
  connectionStatus.textContent = `Key ${await roomFingerprint(appState.roomId, secret)}`;
  setupPanel.hidden = true;
  chatPanel.hidden = false;
  messages.innerHTML = "";
  connectRoom();
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomId = normalizeRoomName(roomNameInput.value);
  if (!roomId) {
    showToast("Use a room name with letters or numbers.");
    return;
  }

  try {
    await enterRoom({
      displayName: displayNameInput.value,
      roomId,
      secret: roomSecretInput.value,
      relayUrl: relayUrlInput.value,
    });

    history.replaceState(null, "", buildInviteUrl(roomId, roomSecretInput.value));
  } catch {
    showToast("Check the relay server URL and passphrase.");
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  try {
    await sendMessage(text);
  } catch {
    messageInput.value = text;
    showToast("Message could not be sent.");
  }
});

copyInviteButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(buildInviteUrl(appState.roomId, appState.roomSecret));
  showToast("Private invite link copied.");
});

const invite = readInviteFromUrl();
relayUrlInput.value = invite.relayUrl || localStorage.getItem(RELAY_STORAGE_KEY) || "";
if (invite.roomId && invite.secret) {
  roomNameInput.value = invite.roomId;
  roomSecretInput.value = invite.secret;
  showToast("Invite loaded. Add your name to enter.");
}
