# DROP IT ON SHELBY (DIOS)
### By Angelmykl · Built on ShelbyNet

> *"Drag it. Drop it. Shelby stores it — encrypted, decentralized, yours forever."*

DIOS is a decentralized encrypted file storage and sharing application built on [ShelbyNet](https://shelby.xyz) — a high-performance, decentralized storage protocol built on Aptos. Files are encrypted in the browser before upload, registered on-chain, and can be shared directly between wallets.

---

## ✨ Features

- **🔐 Client-side AES-256-GCM encryption** — Files are encrypted in the browser before they ever leave your device. The server never sees your plaintext data.
- **⛓ On-chain registration** — Every uploaded file is registered on the ShelbyNet blockchain via a wallet transaction, giving you a permanent, verifiable proof of storage.
- **🔗 Wallet-to-wallet file sharing** — Share encrypted files directly with another wallet address. The receiver gets a Share Link and must sign with their wallet to download.
- **⏱ Configurable expiry** — Choose how long files live on Shelby: 1 minute, 1 hour, 24 hours, 7 days, 30 days, or 1 year.
- **🌗 Dark / Light mode** — Toggleable theme with your preference saved locally.
- **📱 Mobile-friendly** — Fully responsive, touch-optimized, works on any device.
- **🗂 Persistent file list** — Your uploaded and shared files persist across browser refreshes via localStorage.
- **💀 Key self-destruct** — Optionally destroy the local decryption key after a file expires.

---

## 🔒 How Encryption Works

```
Your File
   ↓
AES-256-GCM Encrypt (random key, in browser)
   ↓
Encrypted bytes → Shelby RPC (stored on ShelbyNet)
Decryption key  → localStorage only (never leaves your browser)
```

**Sharing flow:**
```
Sender clicks Share → enters receiver wallet address
   ↓
File key is wrapped with a random shareKey (AES-GCM)
   ↓
Share package uploaded to Shelby on-chain
   ↓
Share Link = location + shareKey (base64 encoded)
   ↓
Receiver pastes Share Link → file unlocked
   ↓
Receiver signs with wallet (proves ownership) → downloads
```

The Share Link contains the decryption key material. Treat it like a password — only share it via trusted channels.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React 18 |
| Blockchain | ShelbyNet (Aptos-compatible) |
| Storage | Shelby Protocol SDK v0.3.x |
| Wallet | Aptos Wallet Adapter (Petra, Martian, etc.) |
| Encryption | Web Crypto API — AES-256-GCM |
| Fonts | Orbitron, Space Mono, Syne (Google Fonts) |
| Styling | CSS Modules with dark/light theme |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- An Aptos wallet (e.g. [Petra](https://petra.app)) connected to **ShelbyNet**
- ShelbyNet API key (optional — adds auth to the proxy)

### Installation

```bash
git clone https://github.com/Angelmykl/drop-it-on-shelby-by-angelmykl.git
cd drop-it-on-shelby-by-angelmykl
npm install
```

### Environment Variables

Create a `.env.local` file in the root:

```env
SHELBYNET_API_KEY=your_api_key_here
```

> The API key is added server-side by the Next.js proxy (`pages/api/shelbynet/[...path].js`) — it is never exposed to the browser.

### Run Locally

```bash
npm run dev
```

Live: https://drop-it-on-shelby-by-angelmykl.vercel.app/

### Add ShelbyNet to Petra Wallet

1. Open Petra → Settings → Network → Add Network
2. **Name:** ShelbyNet
3. **RPC URL:** `https://api.shelbynet.shelby.xyz/v1`
4. Switch to ShelbyNet
5. Claim test tokens from the [ShelbyUSD Faucet](https://docs.shelby.xyz/apis/faucet/shelbyusd)

---

## 📁 Project Structure

```
├── pages/
│   ├── index.js                  # Main app UI and logic
│   ├── _app.js                   # Wallet adapter + fetch proxy patch
│   └── api/
│       └── shelbynet/
│           └── [...path].js      # Server-side proxy for ShelbyNet RPC
├── styles/
│   ├── globals.css               # Global styles, theme variables, dark/light
│   └── Home.module.css           # Component-scoped styles
└── lib/
    └── shelbynetTx.js            # Shelby transaction helpers
```

---

## 🔗 How to Share a File

**Sender:**
1. Upload a file — it gets encrypted and stored on Shelby
2. Click **🔗 Share** on any file in "My Files"
3. Enter the receiver's wallet address (`0x...`)
4. Click **Generate Share Link** — approve the wallet popup
5. A Share Link is copied to your clipboard — send it to the receiver via DM, email, etc.

**Receiver:**
1. Connect your wallet to DIOS
2. Paste the Share Link in the "Shared with Me" section
3. Click **Find** — the file is verified and unlocked
4. Click **🔑 Sign & Download** — sign with your wallet to confirm ownership
5. The file downloads and decrypts automatically

---

## 🌐 Deployment

This app is deployed on [Vercel](https://vercel.com). Every push to `main` triggers an automatic redeployment.

**Environment variables to set in Vercel dashboard:**
- `SHELBYNET_API_KEY` — your ShelbyNet API key

---

## 🙏 Credits

- [Shelby Protocol](https://shelby.xyz) — decentralized storage infrastructure
- [Aptos Labs](https://aptoslabs.com) — blockchain foundation
- Built with ❤️ by **Angelmykl**

---

## 📄 License

MIT
