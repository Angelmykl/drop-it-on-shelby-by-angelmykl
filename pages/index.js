import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { Buffer } from "buffer";
import styles from "../styles/Home.module.css";

import {
  createDefaultErasureCodingProvider,
  expectedTotalChunksets,
  generateCommitments,
  ShelbyBlobClient,
  ShelbyClient,
} from "@shelby-protocol/sdk/browser";

const DURATIONS = [
  { key: "1m", label: "1 min", ms: 60_000 },
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "24h", label: "24 hours", ms: 86_400_000 },
  { key: "7d", label: "7 days", ms: 604_800_000 },
  { key: "30d", label: "1 month", ms: 2_592_000_000 },
  { key: "365d", label: "1 year", ms: 31_536_000_000 },
];

function fmt(ms) {
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromB64(s) { return new Uint8Array(atob(s).split("").map((c) => c.charCodeAt(0))); }

async function aesEncrypt(fileBytes) {
  const keyRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, fileBytes);
  return { iv, keyRaw, cipher: new Uint8Array(cipher) };
}

async function aesDecrypt(cipherBytes, keyRaw, iv) {
  const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new Uint8Array(plain);
}

/** Derive an AES-GCM wrapping key from a Share Token signature (no backend). */
async function deriveWrapKeyFromSignature(sigString) {
  const enc = new TextEncoder();
  const sigBytes = enc.encode(sigString);
  const hash = await crypto.subtle.digest("SHA-256", sigBytes);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrapKeyMaterial({ keyB64, ivB64 }, sigString) {
  const wrapKey = await deriveWrapKeyFromSignature(sigString);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ keyB64, ivB64 }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, wrapKey, plain);
  return { nonceB64: b64(nonce), cipherB64: b64(new Uint8Array(cipher)) };
}

async function unwrapKeyMaterial({ nonceB64, cipherB64 }, sigString) {
  const wrapKey = await deriveWrapKeyFromSignature(sigString);
  const nonce = fromB64(nonceB64);
  const cipher = fromB64(cipherB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, wrapKey, cipher);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
}

function randomShareName(owner, fileName) {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(r).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `dios_share_${owner.slice(2, 8)}_${encodeURIComponent(fileName).slice(0, 24)}_${hex}.json`;
}

export default function Home() {
  const {
    connected, connect, disconnect, wallets, wallet, account,
    signAndSubmitTransaction, signMessage,
  } = useWallet();

  const addr = account?.address?.toString?.() || account?.address || "";
  const activeWallet = wallet?.name || "";

  const [durationKey, setDurationKey] = useState("24h");
  const [afterDestroyKey, setAfterDestroyKey] = useState(true);
  const [files, setFiles] = useState([]);
  const [sharedWithMe, setSharedWithMe] = useState([]);

  // Sharing UI
  const [recipientAddr, setRecipientAddr] = useState("");
  const [recipientToken, setRecipientToken] = useState("");
  const [shareFileName, setShareFileName] = useState("");
  const [sharePackageCid, setSharePackageCid] = useState("");
  const [redeemCid, setRedeemCid] = useState("");
  const [myShareToken, setMyShareToken] = useState("");

  const [log, setLog] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [walletModal, setWalletModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const durationMs = useMemo(() => DURATIONS.find((d) => d.key === durationKey)?.ms ?? DURATIONS[2].ms, [durationKey]);
  const detectedWallets = useMemo(() => (wallets || []).filter((w) => !!w?.name), [wallets]);

  const shelbyClient = useMemo(() => {
    return new ShelbyClient({
      network: Network.SHELBYNET,
      // No client-side key: requests are routed through /api/shelbynet which adds the key server-side.
    });
  }, []);

  const aptosClient = useMemo(() => {
    return new Aptos(new AptosConfig({
      network: Network.SHELBYNET,
      // ShelbyNet fullnode access should work without a browser-exposed key.
    }));
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setFiles((prev) =>
        prev.filter((f) => {
          const expired = f.expiresAt ? now >= f.expiresAt : false;
          if (expired && afterDestroyKey) {
            localStorage.removeItem(`dios:key:${f.owner}:${f.name}`);
            localStorage.removeItem(`dios:iv:${f.owner}:${f.name}`);
          }
          return !expired;
        })
      );
      setSharedWithMe((prev) =>
        prev.filter((f) => {
          const expired = f.expiresAt ? now >= f.expiresAt : false;
          if (expired && afterDestroyKey && f.sharedBy) {
            localStorage.removeItem(`dios:key:${f.sharedBy}:${f.name}`);
            localStorage.removeItem(`dios:iv:${f.sharedBy}:${f.name}`);
          }
          return !expired;
        })
      );
    }, 1000);
    return () => clearInterval(t);
  }, [afterDestroyKey]);

  async function openWalletPicker() {
    setLog("");
    if (connected) return;
    if (detectedWallets.length <= 1) {
      const w = detectedWallets[0];
      if (!w) return setLog("No Aptos wallet detected. Install Petra/Martian/Fewcha/etc, then refresh.");
      try { await connect(w.name); } catch (e) { setLog(`Wallet connect failed: ${e?.message || e}`); }
      return;
    }
    setWalletModal(true);
  }

  async function connectWallet(name) {
    try { await connect(name); setWalletModal(false); }
    catch (e) { setLog(`Wallet connect failed: ${e?.message || e}`); }
  }

  function pickFile() { inputRef.current?.click(); }

  async function handleFile(file) {
    if (!addr) return setLog("Connect wallet first.");
    // No client-side API keys required; ShelbyNet requests go through /api/shelbynet
    if (!signAndSubmitTransaction) return setLog("Wallet does not support signAndSubmitTransaction.");

    const expiresAt = Date.now() + durationMs;
    const uploadedAt = Date.now();
    const expirationMicros = (expiresAt) * 1000;

    setBusy(true);
    try {
      setLog(`Encrypting ${file.name}…`);
      const plainBytes = new Uint8Array(await file.arrayBuffer());
      const { iv, keyRaw, cipher } = await aesEncrypt(plainBytes);

      localStorage.setItem(`dios:key:${addr}:${file.name}`, b64(keyRaw));
      localStorage.setItem(`dios:iv:${addr}:${file.name}`, b64(iv));

      setLog("Encoding + generating commitments…");
      const provider = await createDefaultErasureCodingProvider();
      const commitments = await generateCommitments(provider, Buffer.from(cipher));

      setLog("Registering on-chain (wallet popup)…");
      const payload = ShelbyBlobClient.createRegisterBlobPayload({
        account: addr,
        blobName: file.name,
        blobMerkleRoot: commitments.blob_merkle_root,
        numChunksets: expectedTotalChunksets(commitments.raw_data_size),
        expirationMicros,
        blobSize: commitments.raw_data_size,
      });

      const tx = await signAndSubmitTransaction({ data: payload });
      setLog(`Tx submitted: ${tx.hash}. Waiting…`);
      await aptosClient.waitForTransaction({ transactionHash: tx.hash });

      setLog("Uploading encrypted bytes to Shelby RPC…");
      await shelbyClient.rpc.putBlob({ account: addr, blobName: file.name, blobData: cipher });

      const cid = `${addr}/${file.name}`;
      setFiles((prev) => [
        { name: file.name, owner: addr, size: file.size, type: file.type || "unknown", expiresAt, uploadedAt, cid, localOnly: false, txHash: tx.hash },
        ...prev,
      ]);
      setLog(`Uploaded ✅ CID: ${cid}`);
    } catch (e) {
      setLog(`Upload failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function onInput(e) {
    const file = e.target.files?.[0];
    if (file) await handleFile(file);
    e.target.value = "";
  }

  async function onDrop(e) {
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  }

  function copyText(t) {
    navigator.clipboard.writeText(t);
    setLog("Copied ✅");
  }

  async function downloadAndDecrypt(file) {
    try {
      setLog("Downloading from Shelby…");
      const resp = await fetch(`/api/shelbynet/shelby/v1/blobs/${file.owner}/${encodeURIComponent(file.name)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const cipherBytes = new Uint8Array(await blob.arrayBuffer());

      const keyB64 = localStorage.getItem(`dios:key:${file.owner}:${file.name}`);
      const ivB64 = localStorage.getItem(`dios:iv:${file.owner}:${file.name}`);
      if (!keyB64 || !ivB64) throw new Error("Missing decryption key (expired/destroyed?)");

      const plain = await aesDecrypt(cipherBytes, fromB64(keyB64), fromB64(ivB64));
      const outBlob = new Blob([plain]);

      const a = document.createElement("a");
      a.href = URL.createObjectURL(outBlob);
      a.download = file.name;
      a.click();
      setLog("Downloaded + decrypted ✅");
    } catch (e) {
      setLog(`Download/decrypt failed: ${e?.message || e}`);
    }
  }

  function progress(file) {
    const total = Math.max(1, file.expiresAt - file.uploadedAt);
    const left = Math.max(0, file.expiresAt - Date.now());
    return Math.max(0, Math.min(1, left / total));
  }
  function remaining(file) { return fmt(file.expiresAt - Date.now()); }

  // -------- Key sharing --------

  async function generateShareToken() {
    if (!connected || !addr) return setLog("Connect wallet first.");
    if (!signMessage) return setLog("This wallet does not support signMessage.");
    try {
      setLog("Wallet popup: generating Share Token…");
      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const nonceHex = Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join("");
      const message = `DIOS Share Token v1\naddress:${addr}\nnonce:${nonceHex}`;
      const res = await signMessage({ message, nonce: nonceHex });
      // store as a compact JSON the sender can use
      const token = JSON.stringify({
        v: 1,
        address: addr,
        nonce: nonceHex,
        message,
        signature: res.signature || res, // different wallets return different shapes
      });
      setMyShareToken(token);
      setLog("Share Token generated ✅ Copy and send it to the sender.");
    } catch (e) {
      setLog(`Token generation failed: ${e?.message || e}`);
    }
  }

  async function createSharePackage() {
    if (!addr) return setLog("Connect wallet first.");
    if (!recipientAddr || !recipientToken || !shareFileName) return setLog("Enter recipient address + recipient Share Token + file name.");
    if (!signAndSubmitTransaction) return setLog("Wallet does not support signAndSubmitTransaction.");
    try {
      const found = files.find((f) => f.name === shareFileName && f.owner === addr);
      if (!found) return setLog("File not found in your My Files list.");
      const keyB64 = localStorage.getItem(`dios:key:${addr}:${shareFileName}`);
      const ivB64 = localStorage.getItem(`dios:iv:${addr}:${shareFileName}`);
      if (!keyB64 || !ivB64) return setLog("Missing file key (maybe expired/destroyed).");

      const tokenObj = JSON.parse(recipientToken);
      const sig = tokenObj.signature;
      if (!sig) return setLog("Recipient token missing signature.");
      if ((tokenObj.address || "").toLowerCase() !== recipientAddr.toLowerCase()) {
        return setLog("Recipient address does not match the token address.");
      }

      setBusy(true);
      setLog("Wrapping file key for recipient…");
      const wrapped = await wrapKeyMaterial({ keyB64, ivB64 }, sig);

      const pkg = {
        v: 1,
        type: "dios_keyshare",
        from: addr,
        to: recipientAddr,
        fileOwner: addr,
        fileName: shareFileName,
        fileCid: `${addr}/${shareFileName}`,
        wrapped,
        createdAt: Date.now(),
        // package expires when file expires (recipient still needs the key before file expiry)
        expiresAt: found.expiresAt,
      };

      const pkgBytes = new TextEncoder().encode(JSON.stringify(pkg));
      const provider = await createDefaultErasureCodingProvider();
      const commitments = await generateCommitments(provider, Buffer.from(pkgBytes));

      const blobName = randomShareName(addr, shareFileName);
      const expirationMicros = (found.expiresAt) * 1000;

      setLog("Registering Share Package on-chain (wallet popup)…");
      const payload = ShelbyBlobClient.createRegisterBlobPayload({
        account: addr,
        blobName,
        blobMerkleRoot: commitments.blob_merkle_root,
        numChunksets: expectedTotalChunksets(commitments.raw_data_size),
        expirationMicros,
        blobSize: commitments.raw_data_size,
      });

      const tx = await signAndSubmitTransaction({ data: payload });
      await aptosClient.waitForTransaction({ transactionHash: tx.hash });

      setLog("Uploading Share Package to Shelby…");
      await shelbyClient.rpc.putBlob({ account: addr, blobName, blobData: pkgBytes });

      const cid = `${addr}/${blobName}`;
      setSharePackageCid(cid);
      copyText(cid);
      setLog("Share Package created ✅ CID copied. Send CID to the recipient.");
    } catch (e) {
      setLog(`Create share failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function redeemSharePackage() {
    if (!addr) return setLog("Connect wallet first (recipient).");
    if (!redeemCid || !myShareToken) return setLog("Paste Share Package CID + your Share Token.");
    try {
      const [owner, blobName] = redeemCid.split("/", 2);
      if (!owner || !blobName) return setLog("Invalid CID format. Expected: 0x.../blobName");

      setLog("Downloading Share Package…");
      const resp = await fetch(`/api/shelbynet/shelby/v1/blobs/${owner}/${encodeURIComponent(blobName)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const pkg = await resp.json();

      const tokenObj = JSON.parse(myShareToken);
      const sig = tokenObj.signature;
      if (!sig) return setLog("Your token is missing signature.");

      if ((pkg.to || "").toLowerCase() !== addr.toLowerCase()) {
        return setLog("This Share Package is not addressed to your wallet.");
      }

      setLog("Decrypting key material…");
      const { keyB64, ivB64 } = await unwrapKeyMaterial(pkg.wrapped, sig);

      // Store key under original file owner/name so download+decrypt works
      localStorage.setItem(`dios:key:${pkg.fileOwner}:${pkg.fileName}`, keyB64);
      localStorage.setItem(`dios:iv:${pkg.fileOwner}:${pkg.fileName}`, ivB64);

      setSharedWithMe((prev) => [
        {
          name: pkg.fileName,
          owner: pkg.fileOwner,
          size: 0,
          type: "shared",
          expiresAt: pkg.expiresAt,
          uploadedAt: pkg.createdAt,
          cid: pkg.fileCid,
          localOnly: false,
          sharedBy: pkg.from,
          sharePkgCid: redeemCid,
        },
        ...prev,
      ]);

      setLog("Imported ✅ You can now Download + Decrypt the shared file.");
    } catch (e) {
      setLog(`Redeem failed: ${e?.message || e}`);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>DROP IT ON SHELBY (DIOS)</h1>
        <p className={styles.byline}>By Angelmykl</p>
        <p className={styles.welcome}>“Welcome to DIOS. Drag it. Drop it. Shelby stores it”</p>

        <div className={styles.topbar}>
          {!connected ? (
            <button className="primary" onClick={openWalletPicker} type="button">Connect Wallet</button>
          ) : (
            <button className="primary" onClick={disconnect} type="button">Disconnect</button>
          )}
          {addr && <small>Connected: {addr.slice(0,6)}…{addr.slice(-4)} {activeWallet ? `(${activeWallet})` : ""}</small>}
        </div>

        {log && <small>{log}</small>}
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <div
            className={`${styles.drop} ${dropActive ? styles.dropActive : ""}`}
            onDragEnter={(e) => { e.preventDefault(); setDropActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDropActive(false); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            <h3 style={{margin:"0 0 .25rem 0"}}>Drag & Drop any file</h3>
            <small>Or click “Select file” • Wallet popup happens on upload.</small>

            <div className={styles.row}>
              <div>
                <small>Storage duration</small>
                <div className={styles.durationGrid}>
                  {DURATIONS.map((d) => (
                    <button
                      key={d.key}
                      className={`${styles.durBtn} ${durationKey === d.key ? styles.durBtnActive : ""}`}
                      onClick={() => setDurationKey(d.key)}
                      type="button"
                      disabled={busy}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.split}>
                <label>
                  <small>After expiration</small>
                  <div style={{display:"flex",gap:".5rem",marginTop:".4rem"}}>
                    <button className={afterDestroyKey ? "primary" : "ghost"} onClick={() => setAfterDestroyKey(v => !v)} type="button" disabled={busy}>
                      {afterDestroyKey ? "✓ Destroy key" : "Destroy key"}
                    </button>
                  </div>
                </label>
                <div>
                  <small>Browse</small>
                  <button className="primary" style={{width:"100%",marginTop:".4rem"}} onClick={pickFile} type="button" disabled={busy}>
                    {busy ? "Uploading…" : "Select file"}
                  </button>
                  <input ref={inputRef} type="file" style={{display:"none"}} onChange={onInput} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <h3 style={{marginTop:0}}>Share a file (real key sharing)</h3>

          <small>
            Recipient first: click <b>Generate Share Token</b> (wallet signs), then send token to sender.
            Sender creates a Share Package and sends back the Share CID.
          </small>

          <div className={styles.row}>
            <button className="ghost" onClick={generateShareToken} type="button" disabled={!connected || busy}>
              Generate Share Token (recipient)
            </button>
            <label>
              <small>My Share Token (copy/send)</small>
              <textarea value={myShareToken} onChange={(e) => setMyShareToken(e.target.value)} placeholder='{"v":1,"address":"0x...","nonce":"...","signature":"..."}' />
            </label>

            <hr className="sep" />

            <label>
              <small>Recipient wallet address</small>
              <input value={recipientAddr} onChange={(e) => setRecipientAddr(e.target.value)} placeholder="0x..." />
            </label>
            <label>
              <small>Recipient Share Token (paste)</small>
              <textarea value={recipientToken} onChange={(e) => setRecipientToken(e.target.value)} placeholder='Paste recipient token JSON here…' />
            </label>
            <label>
              <small>File name to share (from your list)</small>
              <input value={shareFileName} onChange={(e) => setShareFileName(e.target.value)} placeholder="example.pdf" />
            </label>

            <button className="primary" onClick={createSharePackage} type="button" disabled={busy}>
              Create Share Package (sender)
            </button>

            {sharePackageCid && (
              <small>
                Share CID: <span style={{color:"var(--pink)"}}>{sharePackageCid}</span>{" "}
                <button className="ghost" onClick={() => copyText(sharePackageCid)} type="button">Copy</button>
              </small>
            )}

            <hr className="sep" />

            <label>
              <small>Redeem Share Package CID (recipient)</small>
              <input value={redeemCid} onChange={(e) => setRedeemCid(e.target.value)} placeholder="0x.../dios_share_....json" />
            </label>
            <button className="primary" onClick={redeemSharePackage} type="button" disabled={busy}>
              Import shared file (recipient)
            </button>
          </div>
        </div>
      </div>

      <div className={styles.split} style={{marginTop:"1rem"}}>
        <div className={styles.card}>
          <h3 style={{marginTop:0}}>My Files</h3>
          {files.length === 0 ? (
            <small>No files yet — drop one above.</small>
          ) : (
            <div className={styles.fileList}>
              {files.map((f) => (
                <div className={styles.fileCard} key={`${f.owner}:${f.name}`}>
                  <div style={{flex:1}}>
                    <div className={styles.fileTop}>
                      <div>
                        <div className={styles.fileName}>{f.name}</div>
                        <div className={styles.meta}>
                          <span className={styles.chip}>{f.type}</span>
                          <span className={styles.chip}>{bytesLabel(f.size)}</span>
                          <span className={styles.chip}>on-shelby</span>
                        </div>
                        <div className={styles.cidRow} style={{marginTop:".35rem"}}>
                          <span className={styles.cidText}>CID: {f.cid}</span>
                          <button className="ghost" onClick={() => copyText(f.cid)} type="button">📋 Copy</button>
                        </div>
                        <div><small>⏳ Expires in: {remaining(f)}</small></div>
                      </div>
                    </div>
                    <div className={styles.progressWrap}>
                      <div className={styles.progress} style={{width: `${progress(f) * 100}%`}} />
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <button onClick={() => downloadAndDecrypt(f)} type="button">⬇ Download + Decrypt</button>
                    <button className="ghost" onClick={() => setShareFileName(f.name)} type="button">🔁 Share</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.card}>
          <h3 style={{marginTop:0}}>Shared with me</h3>
          {sharedWithMe.length === 0 ? (
            <small>Nothing shared with you yet. Import a Share CID above.</small>
          ) : (
            <div className={styles.fileList}>
              {sharedWithMe.map((f) => (
                <div className={styles.fileCard} key={`shared:${f.sharedBy}:${f.name}`}>
                  <div style={{flex:1}}>
                    <div className={styles.fileName}>{f.name}</div>
                    <div className={styles.meta}>
                      <span className={styles.chip}>shared</span>
                      <span className={styles.chip}>on-shelby</span>
                    </div>
                    <small>Shared by: {f.sharedBy?.slice(0,6)}…{f.sharedBy?.slice(-4)}</small><br/>
                    <small>⏳ Expires in: {remaining(f)}</small>
                    <div className={styles.progressWrap} style={{marginTop:".5rem"}}>
                      <div className={styles.progress} style={{width: `${progress(f) * 100}%`}} />
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <button onClick={() => downloadAndDecrypt(f)} type="button">⬇ Download + Decrypt</button>
                    <button className="ghost" onClick={() => copyText(f.cid)} type="button">Copy CID</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <a href="https://docs.shelby.xyz/apis/faucet/shelbyusd" target="_blank" rel="noreferrer">Claim Faucet</a>
        <a href="https://explorer.shelby.xyz/shelbynet/" target="_blank" rel="noreferrer">Shelby Explorer</a>
      </div>

      {walletModal && (
        <div className={styles.overlay} onClick={() => setWalletModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 style={{margin:0}}>Select an Aptos wallet</h3>
              <button className="ghost" onClick={() => setWalletModal(false)} type="button">Close</button>
            </div>
            <small>{detectedWallets.length ? "Choose a wallet to connect." : "No wallet detected. Install one and refresh."}</small>

            <div className={styles.walletList}>
              {detectedWallets.map((w) => (
                <button key={w.name} className={`ghost ${styles.walletBtn}`} onClick={() => connectWallet(w.name)} type="button">
                  <span className={styles.walletLeft}>
                    <span className={styles.icon}>{w.icon ? <img src={w.icon} alt="" /> : "W"}</span>
                    <span>{w.name}</span>
                  </span>
                  <span>Connect</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
