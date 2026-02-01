# DROP IT ON SHELBY (DIOS)
“Welcome to DIOS. Drag it. Drop it. Shelby stores it”

## Real Shelby uploads + key sharing
- Encrypts files in your browser (AES-GCM)
- Registers upload on-chain (wallet popup)
- Uploads encrypted bytes to Shelby RPC (Shelbynet)
- Shares decryption keys using a **wallet-signed Share Token** (no backend)

## Key sharing model (practical)
1) Recipient clicks **Generate Share Token** (wallet signs a message) and sends token to sender.
2) Sender pastes token, creates a **Share Package** stored on Shelby.
3) Recipient imports the Share Package + token to decrypt the file key and download/decrypt the file.

## Vercel Environment Variables
Set these in Vercel → Project → Settings → Environment Variables:
- `SHELBYNET_API_KEY` (server-side; used by /api/shelbynet proxy)

## Links
- Explorer: https://explorer.shelby.xyz/shelbynet/
- Faucet: https://docs.shelby.xyz/apis/faucet/shelbyusd
