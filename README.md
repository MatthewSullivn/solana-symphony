# Solana Symphony

**Listen to the Solana blockchain.** A live mainnet visualizer that turns the chain into generative music, plus a player that turns any wallet's history into a song.

## Live chain
- **Every block is a note.** Solana produces a slot roughly every 400ms, so the network's real speed is the tempo.
- **Every validator has its own melody.** Each leader produces 4 slots in a row; its address deterministically picks a pitch, timbre and 4-note motif. Leader rotation lands on a kick drum, the downbeat of each bar.
- **Transactions are rhythm.** Live SPL token transactions tick as hi-hats; failed ones snap as snares. Network TPS opens the filter on a bass pad.
- **Skipped slots are dissonance.** Slots missing from the finalized chain play as a dark, clashing thud.

## Hear your wallet
Paste any address. Its last 30 successful transactions replay as a melody on a timeline: money in plays high (green), money out plays low (red), swaps chirp both ways (purple), bigger dollar amounts ring louder. Every token is priced live in USD.

## Run
```bash
pnpm install
pnpm dev
```
Click **Start listening** (browsers require a click before audio can play).

## Stack
- [`@solana/kit`](https://github.com/anza-xyz/kit): websocket slot subscription, leader schedule, blocks, signatures, transactions
- Web Audio API: every sound is synthesized, no samples
- RPC via PublicNode (browser-friendly CORS), token prices via the Jupiter price API
- Vite + TypeScript, no backend, no wallet connection needed (read-only)
