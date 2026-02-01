import "../styles/globals.css";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";

// Patch global fetch in the browser to route ShelbyNet API calls through our same-origin proxy.
// This avoids CORS issues when libraries try to call https://api.shelbynet.shelby.xyz directly.
if (typeof window !== "undefined" && !window.__shelbyFetchPatched) {
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (typeof url === "string" && url.startsWith("https://api.shelbynet.shelby.xyz/")) {
        const u = new URL(url);
        const proxied = `/api/shelbynet${u.pathname}${u.search}`;
        if (typeof input === "string") return _origFetch(proxied, init);
        return _origFetch(new Request(proxied, input), init);
      }
    } catch {}
    return _origFetch(input, init);
  };
  window.__shelbyFetchPatched = true;
}



export default function App({ Component, pageProps }) {
  return (
    <AptosWalletAdapterProvider
      autoConnect={true}
      dappConfig={{
        network: Network.SHELBYNET,
      }}
      onError={(e) => console.log("Wallet adapter error:", e)}
    >
      <Component {...pageProps} />
    </AptosWalletAdapterProvider>
  );
}
