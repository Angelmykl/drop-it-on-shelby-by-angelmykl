import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { Buffer } from "buffer";
import styles from "../styles/Home.module.css";

import {
  createDefaultErasureCodingProvider,
  defaultErasureCodingConfig,
  expectedTotalChunksets,
  generateCommitments,
  ShelbyBlobClient,
  ShelbyClient,
} from "@shelby-protocol/sdk/browser";

const DURATIONS = [
  { key: "1m",   label: "1 min",   ms: 60_000 },
  { key: "1h",   label: "1 hour",  ms: 3_600_000 },
  { key: "24h",  label: "24 hrs",  ms: 86_400_000 },
  { key: "7d",   label: "7 days",  ms: 604_800_000 },
  { key: "30d",  label: "30 days", ms: 2_592_000_000 },
  { key: "365d", label: "1 year",  ms: 31_536_000_000 },
];

function fmt(ms) {
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb/1024).toFixed(1)} GB`;
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromB64(s) { return new Uint8Array(atob(s).split("").map(c => c.charCodeAt(0))); }
function shortAddr(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : ""; }
function merkleHex(r) {
  return (r instanceof Uint8Array || Buffer.isBuffer(r))
    ? "0x" + Buffer.from(r).toString("hex") : String(r);
}
function fileIcon(type) {
  if (!type) return "📄";
  if (type.startsWith("image")) return "🖼";
  if (type.startsWith("video")) return "🎬";
  if (type.startsWith("audio")) return "🎵";
  if (type.includes("pdf"))    return "📋";
  if (type.includes("zip")||type.includes("rar")) return "📦";
  if (type.includes("text"))   return "📝";
  return "📄";
}

// ── Helpers to read/write localStorage ────────────────────────────────────
function loadFromStorage(key, fallback = []) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function saveToStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function aesEncrypt(fileBytes) {
  const keyRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv     = crypto.getRandomValues(new Uint8Array(12));
  const key    = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, fileBytes);
  return { iv, keyRaw, cipher: new Uint8Array(cipher) };
}
async function aesDecrypt(cipher, keyRaw, iv) {
  const key   = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new Uint8Array(plain);
}
async function wrapKey(keyB64, ivB64) {
  const sk  = crypto.getRandomValues(new Uint8Array(32));
  const siv = crypto.getRandomValues(new Uint8Array(12));
  const wk  = await crypto.subtle.importKey("raw", sk, "AES-GCM", false, ["encrypt"]);
  const pl  = new TextEncoder().encode(JSON.stringify({ keyB64, ivB64 }));
  const ct  = await crypto.subtle.encrypt({ name: "AES-GCM", iv: siv }, wk, pl);
  return { sk: b64(sk), siv: b64(siv), ct: b64(new Uint8Array(ct)) };
}
async function unwrapKey({ sk, siv, ct }) {
  const wk  = await crypto.subtle.importKey("raw", fromB64(sk), "AES-GCM", false, ["decrypt"]);
  const pl  = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(siv) }, wk, fromB64(ct));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pl)));
}
function makeLink({ from, blob, sk, siv, ct }) {
  return btoa(JSON.stringify({ f:from, b:blob, k:sk, i:siv, c:ct }));
}
function parseLink(raw) {
  try {
    const o = JSON.parse(atob(raw.trim()));
    if (o.f && o.b && o.k && o.i && o.c) return { from:o.f, blob:o.b, sk:o.k, siv:o.i, ct:o.c };
  } catch {}
  return null;
}

const PREVIEW_COUNT = 2;

export default function Home() {
  const { connected, connect, disconnect, wallets, wallet, account,
          signAndSubmitTransaction, signMessage } = useWallet();

  const addr         = account?.address?.toString?.() || account?.address || "";
  const activeWallet = wallet?.name || "";

  // ── State — initialised DIRECTLY from localStorage (no race condition) ──
  const [theme,         setTheme]         = useState("dark");
  const [durationKey,   setDurationKey]   = useState("24h");
  const [destroyOnExp,  setDestroyOnExp]  = useState(true);
  const [files,         setFiles]         = useState([]);
  const [shared,        setShared]        = useState([]);
  const [showAllFiles,  setShowAllFiles]  = useState(false);
  const [showAllShared, setShowAllShared] = useState(false);
  const [shareModal,    setShareModal]    = useState(false);
  const [shareTarget,   setShareTarget]   = useState(null);
  const [toAddr,        setToAddr]        = useState("");
  const [shareStatus,   setShareStatus]   = useState("");
  const [lastLink,      setLastLink]      = useState(null);
  const [findLink,      setFindLink]      = useState("");
  const [log,           setLog]           = useState(null);
  const [dropActive,    setDropActive]    = useState(false);
  const [walletModal,   setWalletModal]   = useState(false);
  const [busy,          setBusy]          = useState(false);
  const [finding,       setFinding]       = useState(false);
  const [tick,          setTick]          = useState(0);

  const fileInput  = useRef(null);
  const durMs      = useMemo(() => DURATIONS.find(d => d.key === durationKey)?.ms ?? 86_400_000, [durationKey]);
  const walletList = useMemo(() => (wallets||[]).filter(w => w?.name), [wallets]);
  const shelby     = useMemo(() => new ShelbyClient({ network: Network.SHELBYNET }), []);
  const aptos      = useMemo(() => new Aptos(new AptosConfig({ network: Network.SHELBYNET })), []);

  // Load from localStorage after mount (client-only — avoids SSR hydration mismatch)
  useEffect(() => {
    const savedTheme = localStorage.getItem("dios:theme");
    if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
    const savedFiles  = loadFromStorage("dios:files");
    const savedShared = loadFromStorage("dios:shared");
    if (savedFiles.length)  setFiles(savedFiles);
    if (savedShared.length) setShared(savedShared);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveToStorage("dios:theme", theme);
  }, [theme]);

  // Ticker for countdown
  useEffect(() => { const t = setInterval(() => setTick(n => n+1), 1000); return () => clearInterval(t); }, []);

  // Expiry sweep — runs every second, saves updated list directly
  useEffect(() => {
    const now = Date.now();
    const sweep = (list, getOwner) => {
      const kept = list.filter(f => {
        const exp = f.expiresAt && now >= f.expiresAt;
        if (exp && destroyOnExp) {
          localStorage.removeItem(`dios:key:${getOwner(f)}:${f.name}`);
          localStorage.removeItem(`dios:iv:${getOwner(f)}:${f.name}`);
        }
        return !exp;
      });
      return kept;
    };
    setFiles(prev => {
      const kept = sweep(prev, f => f.owner);
      if (kept.length !== prev.length) saveToStorage("dios:files", kept);
      return kept.length !== prev.length ? kept : prev;
    });
    setShared(prev => {
      const kept = sweep(prev, f => f.owner);
      if (kept.length !== prev.length) saveToStorage("dios:shared", kept);
      return kept.length !== prev.length ? kept : prev;
    });
  }, [tick, destroyOnExp]);

  function setInfo(msg) { setLog({ msg, type: "info" }); }
  function setOk(msg)   { setLog({ msg, type: "ok" }); }
  function setErr(msg)  { setLog({ msg, type: "err" }); }

  // Wallet
  async function openWallet() {
    setLog(null); if (connected) return;
    if (walletList.length <= 1) {
      if (!walletList[0]) return setErr("No Aptos wallet found. Install Petra then refresh.");
      try { await connect(walletList[0].name); } catch(e) { setErr(`Connect failed: ${e?.message||e}`); }
      return;
    }
    setWalletModal(true);
  }
  async function doConnect(name) {
    try { await connect(name); setWalletModal(false); }
    catch(e) { setErr(`Connect failed: ${e?.message||e}`); }
  }

  // Upload — saves directly to localStorage after success
  async function handleFile(file) {
    if (!addr) return setErr("Connect your wallet first.");
    if (!signAndSubmitTransaction) return setErr("Wallet doesn't support signAndSubmitTransaction.");
    const expiresAt = Date.now() + durMs;
    setBusy(true);
    try {
      setInfo(`🔐 Encrypting "${file.name}"…`);
      const plain = new Uint8Array(await file.arrayBuffer());
      const { iv, keyRaw, cipher } = await aesEncrypt(plain);
      localStorage.setItem(`dios:key:${addr}:${file.name}`, b64(keyRaw));
      localStorage.setItem(`dios:iv:${addr}:${file.name}`,  b64(iv));

      setInfo("⚙ Generating commitments…");
      const prov = await createDefaultErasureCodingProvider();
      const comm = await generateCommitments(prov, Buffer.from(cipher));
      const ec   = defaultErasureCodingConfig();

      setInfo("🔗 Registering on-chain — approve wallet popup…");
      const payload = ShelbyBlobClient.createRegisterBlobPayload({
        blobName: file.name, blobMerkleRoot: merkleHex(comm.blob_merkle_root),
        numChunksets: expectedTotalChunksets(comm.raw_data_size),
        expirationMicros: Number(expiresAt) * 1000,
        blobSize: Number(comm.raw_data_size), encoding: ec.enumIndex,
      });
      const tx = await signAndSubmitTransaction({ data: payload });
      setInfo("⏳ Confirming transaction…");
      await aptos.waitForTransaction({ transactionHash: tx.hash });

      setInfo("📡 Uploading encrypted file to Shelby…");
      await shelby.rpc.putBlob({ account: addr, blobName: file.name, blobData: cipher });

      const newEntry = {
        name: file.name, owner: addr, size: file.size,
        type: file.type || "file", expiresAt, uploadedAt: Date.now(),
        cid: `${addr}/${file.name}`,
      };
      // Save directly — no useEffect dependency needed
      setFiles(prev => {
        const updated = [newEntry, ...prev];
        saveToStorage("dios:files", updated);
        return updated;
      });
      setShowAllFiles(false);
      setOk(`✅ "${file.name}" is now encrypted and stored on Shelby!`);
    } catch(e) { setErr(`Upload failed: ${e?.message||e}`); }
    finally { setBusy(false); }
  }

  async function onInput(e) { const f = e.target.files?.[0]; if (f) await handleFile(f); e.target.value = ""; }
  async function onDrop(e)  { e.preventDefault(); setDropActive(false); const f = e.dataTransfer.files?.[0]; if (f) await handleFile(f); }

  // Download own file
  async function download(file) {
    try {
      setInfo("📡 Fetching from Shelby…");
      const resp = await fetch(`/api/shelbynet/shelby/v1/blobs/${file.owner}/${encodeURIComponent(file.name)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct  = new Uint8Array(await (await resp.blob()).arrayBuffer());
      const key = localStorage.getItem(`dios:key:${file.owner}:${file.name}`);
      const iv  = localStorage.getItem(`dios:iv:${file.owner}:${file.name}`);
      if (!key || !iv) throw new Error("Decryption key not found — may have expired.");
      const plain = await aesDecrypt(ct, fromB64(key), fromB64(iv));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([plain])); a.download = file.name; a.click();
      setOk(`✅ "${file.name}" downloaded and decrypted!`);
    } catch(e) { setErr(`Download failed: ${e?.message||e}`); }
  }

  function pct(f)  { return Math.max(0, Math.min(1, (f.expiresAt - Date.now()) / Math.max(1, f.expiresAt - f.uploadedAt))); }
  function ttl(f)  { return fmt(f.expiresAt - Date.now()); }
  function copy(t) { navigator.clipboard.writeText(t); setOk("Copied to clipboard!"); }

  // Share
  function openShare(file) { setShareTarget(file); setToAddr(""); setShareStatus(""); setShareModal(true); setLog(null); }
  function closeShare()    { setShareModal(false); setShareTarget(null); setToAddr(""); setShareStatus(""); }

  async function doShare() {
    const to = toAddr.trim();
    if (!to)                                     return setShareStatus("⚠ Enter receiver's wallet address.");
    if (!to.startsWith("0x"))                    return setShareStatus("⚠ Address must start with 0x.");
    if (to.toLowerCase() === addr.toLowerCase()) return setShareStatus("⚠ Can't share a file with yourself.");
    const k = localStorage.getItem(`dios:key:${addr}:${shareTarget.name}`);
    const v = localStorage.getItem(`dios:iv:${addr}:${shareTarget.name}`);
    if (!k || !v) return setShareStatus("⚠ File key not found — it may have expired.");
    setBusy(true);
    try {
      setShareStatus("🔐 Encrypting file key for transfer…");
      const w = await wrapKey(k, v);
      const pkg = JSON.stringify({
        v: 3, type: "dios_share_pkg", from: addr, to,
        fileOwner: addr, fileName: shareTarget.name,
        cid: shareTarget.cid, expiresAt: shareTarget.expiresAt,
        wrapped: { siv: w.siv, ct: w.ct },
      });
      const pkgBytes = new TextEncoder().encode(pkg);
      const prov     = await createDefaultErasureCodingProvider();
      const comm     = await generateCommitments(prov, Buffer.from(pkgBytes));
      const ec       = defaultErasureCodingConfig();
      const blobName = `dios_share_to_${to.toLowerCase()}_${Date.now().toString(36)}.json`;

      setShareStatus("🔗 Registering on-chain — approve wallet popup…");
      const payload = ShelbyBlobClient.createRegisterBlobPayload({
        blobName, blobMerkleRoot: merkleHex(comm.blob_merkle_root),
        numChunksets: expectedTotalChunksets(comm.raw_data_size),
        expirationMicros: Number(shareTarget.expiresAt) * 1000,
        blobSize: Number(comm.raw_data_size), encoding: ec.enumIndex,
      });
      const tx = await signAndSubmitTransaction({ data: payload });
      setShareStatus("📡 Uploading share package to Shelby…");
      await aptos.waitForTransaction({ transactionHash: tx.hash });
      await shelby.rpc.putBlob({ account: addr, blobName, blobData: pkgBytes });

      const link = makeLink({ from: addr, blob: blobName, sk: w.sk, siv: w.siv, ct: w.ct });
      navigator.clipboard.writeText(link);
      setLastLink({ link, fileName: shareTarget.name, to });
      closeShare();
      setOk(`✅ Share Link generated and copied — send it to ${shortAddr(to)}!`);
    } catch(e) { setShareStatus(`❌ ${e?.message||e}`); }
    finally { setBusy(false); }
  }

  // Find shared file — saves directly to localStorage
  async function doFind() {
    if (!findLink.trim()) return setErr("Paste a Share Link first.");
    if (!addr) return setErr("Connect your wallet first.");
    const decoded = parseLink(findLink);
    if (!decoded) return setErr("Invalid Share Link — could not decode.");
    setFinding(true);
    try {
      setInfo("📡 Fetching share package from Shelby…");
      const r = await fetch(`/api/shelbynet/shelby/v1/blobs/${decoded.from}/${encodeURIComponent(decoded.blob)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const pkg = await r.json();
      if (pkg.type !== "dios_share_pkg") throw new Error("Not a valid DIOS share package.");
      if (pkg.expiresAt && Date.now() >= pkg.expiresAt) throw new Error("This share has expired.");
      if ((pkg.to||"").toLowerCase() !== addr.toLowerCase())
        throw new Error(`This share is for ${shortAddr(pkg.to)}, not your wallet (${shortAddr(addr)}).`);

      const { keyB64, ivB64 } = await unwrapKey({ sk: decoded.sk, siv: decoded.siv, ct: decoded.ct });
      localStorage.setItem(`dios:key:${pkg.fileOwner}:${pkg.fileName}`, keyB64);
      localStorage.setItem(`dios:iv:${pkg.fileOwner}:${pkg.fileName}`, ivB64);

      const newEntry = {
        name: pkg.fileName, owner: pkg.fileOwner, sharedBy: pkg.from,
        cid: pkg.cid, expiresAt: pkg.expiresAt, uploadedAt: Date.now(), size: 0, type: "shared",
      };
      setShared(prev => {
        if (prev.some(f => f.name === pkg.fileName && f.owner === pkg.fileOwner)) return prev;
        const updated = [newEntry, ...prev];
        saveToStorage("dios:shared", updated);
        return updated;
      });
      setFindLink("");
      setShowAllShared(false);
      setOk(`✅ "${pkg.fileName}" unlocked — sign with your wallet to download.`);
    } catch(e) { setErr(`${e?.message||e}`); }
    finally { setFinding(false); }
  }

  // Sign & Download shared
  async function downloadShared(file) {
    try {
      const key = localStorage.getItem(`dios:key:${file.owner}:${file.name}`);
      const iv  = localStorage.getItem(`dios:iv:${file.owner}:${file.name}`);
      if (!key || !iv) return setErr("Key not found — re-paste the Share Link.");

      setInfo("✍ Sign with your wallet to confirm ownership…");
      await signMessage({ message: `DIOS Download Verification\nFile: ${file.cid}\nRecipient: ${addr}`, nonce: Date.now().toString(16) });

      setInfo("📡 Downloading encrypted file…");
      const resp = await fetch(`/api/shelbynet/shelby/v1/blobs/${file.owner}/${encodeURIComponent(file.name)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct    = new Uint8Array(await (await resp.blob()).arrayBuffer());
      const plain = await aesDecrypt(ct, fromB64(key), fromB64(iv));
      const a     = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([plain])); a.download = file.name; a.click();
      setOk(`✅ "${file.name}" downloaded — wallet ownership verified!`);
    } catch(e) { setErr(`Download failed: ${e?.message||e}`); }
  }

  const logStyle = {
    ok:   { bg: "rgba(0,229,160,.08)",  border: "rgba(0,229,160,.3)",  color: "var(--green)" },
    err:  { bg: "rgba(255,85,102,.08)", border: "rgba(255,85,102,.3)", color: "var(--red)" },
    info: { bg: "var(--accent-dim)",    border: "var(--border)",       color: "var(--muted)" },
  };

  const myFiles       = files.filter(f => f.owner === addr);
  const visibleFiles  = showAllFiles  ? myFiles  : myFiles.slice(0, PREVIEW_COUNT);
  const visibleShared = showAllShared ? shared : shared.slice(0, PREVIEW_COUNT);

  return (
    <>
      <Head>
        <title>DIOS — Drop It On Shelby</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="description" content="Decentralized encrypted file storage and sharing on ShelbyNet. By Angelmykl." />
        <meta name="theme-color" content="#06040f" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Space+Mono:wght@400;700&family=Syne:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      {/* Theme toggle */}
      <button
        className={`${styles.themeToggle} ${theme === "dark" ? styles.themeToggleDark : styles.themeToggleLight}`}
        onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        <span style={{ fontSize:".7rem", userSelect:"none" }}>{theme === "dark" ? "🌙" : "☀️"}</span>
        <span className={styles.themeToggleKnob} />
        <span style={{ fontSize:".7rem", userSelect:"none" }}>{theme === "dark" ? "☀️" : "🌙"}</span>
      </button>

      <div className={styles.container}>

        {/* Header */}
        <div className={styles.header}>
          <h1 className={styles.title}>Drop It On Shelby</h1>
          <p className={styles.byline}>by Angelmykl · Powered by ShelbyNet</p>
          <p className={styles.welcome}>"Drag it. Drop it. Shelby stores it — encrypted, decentralized, yours forever."</p>
          <div className={styles.topbar}>
            {connected ? (
              <>
                <span className={styles.chip}>
                  <span style={{ width:7,height:7,borderRadius:"50%",background:"var(--green)",boxShadow:"0 0 6px var(--green)",display:"inline-block",flexShrink:0 }} />
                  {shortAddr(addr)}
                </span>
                <span className={styles.chip}>{activeWallet}</span>
                <button className="ghost" onClick={disconnect} type="button">Disconnect</button>
              </>
            ) : (
              <button onClick={openWallet} type="button" style={{ padding:".75rem 2rem", fontSize:".9rem" }}>
                Connect Wallet
              </button>
            )}
          </div>
        </div>

        {/* Log bar */}
        {log && (
          <div style={{
            background:logStyle[log.type].bg, border:`1px solid ${logStyle[log.type].border}`,
            borderRadius:14, padding:".7rem 1rem", margin:"0 0 1.25rem",
            fontSize:".84rem", color:logStyle[log.type].color, wordBreak:"break-word",
            display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:"1rem",
            animation:"slideUp .2s ease",
          }}>
            <span>{log.msg}</span>
            <button className="ghost" onClick={() => setLog(null)} type="button"
              style={{ fontSize:".7rem", padding:".2rem .5rem", minHeight:"auto", flexShrink:0 }}>✕</button>
          </div>
        )}

        {/* Share Link card */}
        {lastLink && (
          <div style={{
            background:"rgba(0,229,160,.06)", border:"1px solid rgba(0,229,160,.25)",
            borderRadius:16, padding:"1rem 1.25rem", margin:"0 0 1.25rem",
            animation:"slideUp .25s ease",
          }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:".6rem" }}>
              <span style={{ fontSize:".84rem", fontWeight:700, color:"var(--green)" }}>
                ✅ "{lastLink.fileName}" shared with {shortAddr(lastLink.to)}
              </span>
              <button className="ghost" onClick={() => setLastLink(null)} type="button"
                style={{ fontSize:".7rem", padding:".2rem .5rem", minHeight:"auto" }}>✕</button>
            </div>
            <p style={{ fontSize:".75rem", color:"var(--muted)", marginBottom:".6rem", lineHeight:1.5 }}>
              Send this Share Link to the receiver — they paste it in "Shared with Me" to unlock the file.
            </p>
            <div style={{ display:"flex", gap:".5rem" }}>
              <input readOnly value={lastLink.link}
                style={{ flex:1, padding:".5rem .75rem", fontSize:".7rem", borderRadius:10, minWidth:0 }} />
              <button className="ghost" onClick={() => copy(lastLink.link)} type="button">Copy</button>
            </div>
          </div>
        )}

        <div className={styles.grid}>

          {/* LEFT: Upload + My Files */}
          <div>
            <div className={styles.card}>
              <div className={styles.cardTitle}>📤 Upload</div>

              <div className={styles.durationGrid}>
                {DURATIONS.map(d => (
                  <button key={d.key} type="button"
                    className={`${styles.durBtn} ${durationKey === d.key ? styles.durBtnActive : ""}`}
                    onClick={() => setDurationKey(d.key)}>
                    {d.label}
                  </button>
                ))}
              </div>
              <p style={{ fontSize:".74rem", color:"var(--accent)", marginBottom:".65rem", marginLeft:".25rem", fontWeight:600 }}>
                ⏱ Files will expire after: <strong>{DURATIONS.find(d => d.key === durationKey)?.label}</strong>
              </p>

              <label className={styles.toggle}>
                <input type="checkbox" checked={destroyOnExp} onChange={e => setDestroyOnExp(e.target.checked)} />
                Destroy local decryption key after expiry
              </label>

              <div className={`${styles.drop} ${dropActive ? styles.dropActive : ""}`}
                onDragOver={e => { e.preventDefault(); setDropActive(true); }}
                onDragLeave={() => setDropActive(false)}
                onDrop={onDrop} onClick={() => fileInput.current?.click()}>
                <span className={styles.dropIcon}>{busy ? "⏳" : "🗂"}</span>
                <div className={styles.dropMain}>{busy ? "Working…" : "Drop your file here"}</div>
                <div className={styles.dropSub}>{busy ? "Please wait" : "or tap to browse — AES-256 encrypted before upload"}</div>
              </div>
              <input ref={fileInput} type="file" style={{ display:"none" }} onChange={onInput} />

              {connected && myFiles.length > 0 && (
                <>
                  <div className={styles.sep} />
                  <div className={styles.cardTitle}>🗃 My Files
                    <span style={{ fontSize:".65rem", color:"var(--muted)", fontFamily:"Syne,sans-serif", letterSpacing:".05em", textTransform:"none", fontWeight:500 }}>
                      {myFiles.length} file{myFiles.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className={styles.fileList}>
                    {visibleFiles.map(f => (
                      <div className={styles.fileCard} key={`${f.owner}:${f.name}`}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div className={styles.fileName}>{fileIcon(f.type)} {f.name}</div>
                          <div className={styles.meta}>
                            <span className={styles.chip}>{bytesLabel(f.size)}</span>
                            <span className={styles.chip} style={{ color:"var(--cyan)", borderColor:"rgba(0,212,255,.3)" }}>on-shelby</span>
                            <span className={styles.chip}>⏳ {ttl(f)}</span>
                          </div>
                          <div className={styles.progressWrap}>
                            <div className={styles.progress} style={{ width:`${pct(f)*100}%` }} />
                          </div>
                        </div>
                        <div className={styles.actions}>
                          <button onClick={() => download(f)} type="button">⬇ Download</button>
                          <button className="ghost" onClick={() => openShare(f)} type="button">🔗 Share</button>
                          <button className="ghost" onClick={() => copy(f.cid)} type="button">CID</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {myFiles.length > PREVIEW_COUNT && (
                    <button className={`ghost ${styles.showMoreBtn}`}
                      onClick={() => setShowAllFiles(s => !s)} type="button">
                      {showAllFiles ? "▲ Show less" : `▼ Show ${myFiles.length - PREVIEW_COUNT} more file${myFiles.length - PREVIEW_COUNT !== 1 ? "s" : ""}`}
                    </button>
                  )}
                </>
              )}
              {myFiles.length === 0 && (
                <p style={{ textAlign:"center", color:"var(--muted)", fontSize:".82rem", marginTop:"1rem" }}>
                  No files yet — drop one above ↑
                </p>
              )}
            </div>
          </div>

          {/* RIGHT: Shared with Me */}
          <div>
            <div className={styles.card} style={{ height:"100%" }}>
              <div className={styles.cardTitle}>📥 Shared with Me</div>
              {!connected ? (
                <div style={{ textAlign:"center", padding:"2rem 1rem" }}>
                  <div style={{ fontSize:"2.5rem", marginBottom:".75rem" }}>🔐</div>
                  <p style={{ color:"var(--muted)", fontSize:".88rem", marginBottom:"1.25rem", lineHeight:1.6 }}>
                    Connect your wallet to receive encrypted files shared with your address.
                  </p>
                  <button onClick={openWallet} type="button">Connect Wallet</button>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom:"1.25rem" }}>
                    <p style={{ fontSize:".78rem", color:"var(--muted)", marginBottom:".6rem", lineHeight:1.6 }}>
                      Paste a Share Link from the sender. Your wallet signature is required to download.
                    </p>
                    <div style={{ display:"flex", gap:".5rem" }}>
                      <input type="text" value={findLink}
                        onChange={e => setFindLink(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && !finding && findLink.trim() && doFind()}
                        placeholder="Paste Share Link…"
                        style={{ flex:1, padding:".6rem .85rem", fontSize:".75rem", minWidth:0 }}
                      />
                      <button onClick={doFind} disabled={finding || !findLink.trim()} type="button" style={{ flexShrink:0 }}>
                        {finding ? "⏳" : "Find"}
                      </button>
                    </div>
                  </div>
                  {shared.length > 0 && (
                    <>
                      <div className={styles.sep} />
                      <div className={styles.fileList}>
                        {visibleShared.map(f => (
                          <div className={styles.fileCard} key={`shared:${f.owner}:${f.name}`}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <div className={styles.fileName}>{fileIcon(f.type)} {f.name}</div>
                              <div className={styles.meta}>
                                <span className={styles.chip} style={{ color:"var(--cyan)", borderColor:"rgba(0,212,255,.3)" }}>received</span>
                                <span className={styles.chip}>from {shortAddr(f.sharedBy)}</span>
                                <span className={styles.chip}>⏳ {ttl(f)}</span>
                              </div>
                              <div className={styles.progressWrap}>
                                <div className={styles.progress} style={{ width:`${pct(f)*100}%`, background:"linear-gradient(90deg,var(--cyan),#0099bb)" }} />
                              </div>
                            </div>
                            <div className={styles.actions}>
                              <button onClick={() => downloadShared(f)} type="button"
                                style={{ background:"linear-gradient(135deg,#00d4ff,#0099bb)" }}>
                                🔑 Sign &amp; Download
                              </button>
                              <button className="ghost" onClick={() => copy(f.cid)} type="button">CID</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {shared.length > PREVIEW_COUNT && (
                        <button className={`ghost ${styles.showMoreBtn}`}
                          onClick={() => setShowAllShared(s => !s)} type="button">
                          {showAllShared ? "▲ Show less" : `▼ Show ${shared.length - PREVIEW_COUNT} more file${shared.length - PREVIEW_COUNT !== 1 ? "s" : ""}`}
                        </button>
                      )}
                    </>
                  )}
                  {shared.length === 0 && (
                    <div style={{ textAlign:"center", padding:"1.5rem 1rem", color:"var(--muted)" }}>
                      <div style={{ fontSize:"2rem", marginBottom:".5rem", opacity:.4 }}>📭</div>
                      <p style={{ fontSize:".82rem" }}>No shared files yet — paste a Share Link above.</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <span style={{ color:"var(--muted)", fontSize:".72rem" }}>
            DIOS v1 · AES-256-GCM encrypted · Built on ShelbyNet
          </span>
          <div style={{ display:"flex", gap:"1.5rem" }}>
            <a href="https://docs.shelby.xyz/apis/faucet/shelbyusd" target="_blank" rel="noreferrer">Faucet</a>
            <a href="https://explorer.shelby.xyz/shelbynet/" target="_blank" rel="noreferrer">Explorer</a>
          </div>
        </div>
      </div>

      {/* Wallet modal */}
      {walletModal && (
        <div className={styles.overlay} onClick={() => setWalletModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Select Wallet</h3>
              <button className="ghost" onClick={() => setWalletModal(false)} type="button"
                style={{ minHeight:"auto", padding:".3rem .6rem" }}>✕</button>
            </div>
            <p style={{ fontSize:".8rem", color:"var(--muted)", marginBottom:".5rem" }}>
              {walletList.length ? "Choose a wallet to connect to DIOS." : "No wallet detected. Install Petra then refresh."}
            </p>
            <div className={styles.walletList}>
              {walletList.map(w => (
                <button key={w.name} className={`ghost ${styles.walletBtn}`}
                  onClick={() => doConnect(w.name)} type="button">
                  <span className={styles.walletLeft}>
                    <span className={styles.icon}>{w.icon ? <img src={w.icon} alt="" /> : "W"}</span>
                    <span style={{ fontWeight:600 }}>{w.name}</span>
                  </span>
                  <span style={{ fontSize:".78rem", color:"var(--accent)" }}>Connect →</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {shareModal && shareTarget && (
        <div className={styles.overlay} onClick={closeShare}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Share File</h3>
              <button className="ghost" onClick={closeShare} type="button"
                style={{ minHeight:"auto", padding:".3rem .6rem" }}>✕</button>
            </div>
            <div style={{
              background:"var(--accent-dim)", border:"1px solid var(--border)",
              borderRadius:12, padding:".75rem 1rem", marginBottom:"1.25rem",
              display:"flex", alignItems:"center", gap:".75rem",
            }}>
              <span style={{ fontSize:"2rem", flexShrink:0 }}>{fileIcon(shareTarget.type)}</span>
              <div style={{ minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:".88rem", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                  {shareTarget.name}
                </div>
                <div style={{ fontSize:".73rem", color:"var(--muted)", marginTop:".15rem" }}>
                  {bytesLabel(shareTarget.size)} · expires in {ttl(shareTarget)}
                </div>
              </div>
            </div>
            <p style={{ fontSize:".82rem", color:"var(--muted)", marginBottom:"1rem", lineHeight:1.6 }}>
              Enter the receiver's wallet address. A Share Link will be generated — they need both the link and their wallet to decrypt.
            </p>
            <label style={{ display:"block", fontSize:".72rem", color:"var(--muted)", marginBottom:".4rem", letterSpacing:".1em", textTransform:"uppercase" }}>
              Receiver Wallet Address
            </label>
            <input type="text" value={toAddr} onChange={e => setToAddr(e.target.value)}
              placeholder="0x…"
              style={{ width:"100%", padding:".65rem .9rem", fontSize:".82rem", marginBottom:".9rem" }}
            />
            <button onClick={doShare} disabled={busy || !toAddr.trim()} type="button"
              style={{ width:"100%", fontSize:".88rem", padding:".8rem" }}>
              {busy ? "Sharing…" : "🔗 Generate Share Link"}
            </button>
            {shareStatus && (
              <div style={{
                marginTop:".85rem", padding:".65rem .9rem", borderRadius:10,
                fontSize:".82rem", wordBreak:"break-word", lineHeight:1.5,
                background: shareStatus.startsWith("❌")||shareStatus.startsWith("⚠") ? "rgba(255,85,102,.08)" : "var(--accent-dim)",
                border: shareStatus.startsWith("❌")||shareStatus.startsWith("⚠") ? "1px solid rgba(255,85,102,.3)" : "1px solid var(--border)",
                color: shareStatus.startsWith("❌")||shareStatus.startsWith("⚠") ? "var(--red)" : "var(--muted)",
              }}>
                {shareStatus}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}