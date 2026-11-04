/**
 * Polymarket real-time trade feed (RTDS, wss://ws-live-data.polymarket.com, topic
 * "activity" / type "trades"). Every Polymarket trade arrives here ~25 ms after it
 * happens, while the Data API takes ~15 s to show it (measured Nov 2026). Trades by
 * followed wallets are handed to the engine right away; polling stays as a safety net.
 *
 * Notes from live testing:
 * - ~30 trades/s, ~25 KB/s. No keep-alive ping needed (and sending "PING" thinned the
 *   feed), so a silence watchdog reconnects instead.
 * - One order can produce several events with the same transaction/token/side; they are
 *   separate fills (different sizes) and must all be kept. See tradeId().
 */
import { z } from "zod";

import { tradeId } from "@/lib/polymarket/data";

import type { LeaderTrade } from "./engine";

export const RTDS_URL = "wss://ws-live-data.polymarket.com";

const Payload = z.object({
  proxyWallet: z.string(),
  // Some feed events arrive without a market or token id; the poll picks those up.
  asset: z.string().min(1),
  conditionId: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  price: z.number(),
  size: z.number(),
  timestamp: z.number(),
  transactionHash: z.string().nullish(),
  outcome: z.string().nullish(),
  title: z.string().nullish(),
  slug: z.string().nullish(),
  icon: z.string().nullish(),
});
const Message = z.object({ topic: z.string(), type: z.string(), payload: z.unknown() });

/** Parse one feed message into a trade; null for anything else. Pure (tested). */
export function parseFeedMessage(
  raw: string,
): (Omit<LeaderTrade, "id"> & { baseId: string }) | null {
  if (!raw || raw[0] !== "{") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const msg = Message.safeParse(json);
  if (!msg.success || msg.data.topic !== "activity" || msg.data.type !== "trades") return null;
  const p = Payload.safeParse(msg.data.payload);
  if (!p.success) return null;
  const t = p.data;
  return {
    baseId: tradeId({
      transaction_hash: t.transactionHash ?? null,
      token_id: t.asset,
      side: t.side,
      size: t.size,
    }),
    wallet: t.proxyWallet.toLowerCase(),
    ts: t.timestamp,
    conditionId: t.conditionId,
    tokenId: t.asset,
    side: t.side,
    price: t.price,
    size: t.size,
    usdc: t.price * t.size,
    outcome: t.outcome ?? null,
    title: t.title ?? null,
    slug: t.slug ?? null,
    icon: t.icon || null,
  };
}

export interface StreamStatus {
  connected: boolean;
  connectedSince: number | null;
  lastEventAt: number | null;
  /** Trades by followed wallets seen since the process started. */
  matched: number;
  reconnects: number;
}

export interface TradeStreamOptions {
  /** Called with a batch of followed-wallet trades (one leader order's fills together). */
  onTrades: (trades: LeaderTrade[]) => void;
  /** Wait this long after a followed trade for the rest of the order's fills. */
  batchMs?: number;
  /** Reconnect if nothing arrives for this long (the feed is never quiet that long). */
  silenceMs?: number;
  url?: string;
  log?: (msg: string) => void;
}

export class TradeStream {
  private ws: WebSocket | null = null;
  private followed = new Set<string>();
  private pending: LeaderTrade[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  /** Recently seen ids → count, to number identical fills (#2, #3) like tradeIds(). */
  private recent = new Map<string, { n: number; at: number }>();
  readonly status: StreamStatus = {
    connected: false,
    connectedSince: null,
    lastEventAt: null,
    matched: 0,
    reconnects: 0,
  };

  constructor(private readonly opts: TradeStreamOptions) {}

  setFollowed(wallets: Iterable<string>) {
    this.followed = new Set([...wallets].map((w) => w.toLowerCase()));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), 5_000);
    this.watchdog.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flush();
    this.ws?.close();
    this.ws = null;
    this.status.connected = false;
  }

  /** Feed one raw message (exposed for tests). */
  handleMessage(raw: string) {
    this.status.lastEventAt = Date.now();
    if (this.followed.size === 0) return;
    // Cheap pre-filter before JSON parsing: 30 msg/s, almost none are ours.
    const lower = raw.toLowerCase();
    let ours = false;
    for (const w of this.followed) {
      if (lower.includes(w)) {
        ours = true;
        break;
      }
    }
    if (!ours) return;
    const t = parseFeedMessage(raw);
    if (!t || !this.followed.has(t.wallet)) return;

    const now = Date.now();
    const prev = this.recent.get(t.baseId);
    const n = prev ? prev.n + 1 : 1;
    this.recent.set(t.baseId, { n, at: now });
    if (this.recent.size > 5_000) {
      for (const [k, v] of this.recent) if (now - v.at > 10 * 60_000) this.recent.delete(k);
    }
    const { baseId, ...rest } = t;
    this.pending.push({ ...rest, id: n === 1 ? baseId : `${baseId}#${n}` });
    this.status.matched++;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.opts.batchMs ?? 1_500);
    }
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.opts.onTrades(batch);
    } catch (err) {
      this.opts.log?.(`stream handler failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url ?? RTDS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.status.connected = true;
      this.status.connectedSince = Date.now();
      this.status.lastEventAt = Date.now();
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic: "activity", type: "trades" }],
        }),
      );
      this.opts.log?.("real-time feed connected");
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.handleMessage(e.data);
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.status.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.attempt++);
    this.status.reconnects++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private checkSilence() {
    const silence = this.opts.silenceMs ?? 30_000;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.status.lastEventAt && Date.now() - this.status.lastEventAt > silence) {
      this.opts.log?.("real-time feed went quiet; reconnecting");
      const ws = this.ws;
      this.ws = null;
      this.status.connected = false;
      ws.close();
      this.scheduleReconnect();
    }
  }
}
