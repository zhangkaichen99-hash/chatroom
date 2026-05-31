# QuietRoom Private Chat

A no-dependency private chat prototype. The browser encrypts messages with AES-GCM before sending them to the relay server. The server only sees room ids, timestamps, and encrypted blobs.

## Run

```bash
node server.mjs
```

Then open:

```text
http://localhost:4180
```

## Install on iPhone with GitHub Pages

GitHub Pages can host the app screen, icon, manifest, and offline shell. It cannot run `server.mjs`, so real-time chat needs a separate HTTPS relay server.

1. Upload these files to GitHub Pages:

```text
index.html
styles.css
app.js
manifest.webmanifest
service-worker.js
icons/
```

2. Host `server.mjs` somewhere that supports Node and HTTPS, such as Render, Railway, Fly.io, a VPS, or your own server.
3. Open the GitHub Pages URL in Safari.
4. Put the public relay URL into **Relay server URL**.
5. Enter your room and passphrase.
6. Tap Safari Share, then Add to Home Screen.

Invite links include the relay URL when it is different from the GitHub Pages URL, so friends can open the same room.
Friends can also paste the full invite link into **Invitation link** on the sign-in screen. QuietRoom fills the room, secret, and relay server for them, then they only add their name.

## Privacy Model

- The passphrase is kept in the URL fragment after `#`, so browsers do not send it to the server.
- Messages are encrypted in the browser with a key derived from the room name and passphrase.
- The relay server keeps recent encrypted messages in memory only.
- Anyone with the full invite link can enter the room, so share it carefully.

For production, host behind HTTPS and add user identity verification, message deletion, and a stronger audited protocol before trusting it for high-risk communication.
