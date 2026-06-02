/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show } from "solid-js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BalanceInfo {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

interface BalanceResponse {
  is_available: boolean
  balance_infos: BalanceInfo[]
}

interface BalanceData {
  isLoading: boolean
  error: string | null
  noKey: boolean
  isAvailable: boolean
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
  lastUpdate: string | null
}

// ---------------------------------------------------------------------------
// API key retrieval
// ---------------------------------------------------------------------------

interface AuthStore {
  [provider: string]: { type: string; key: string }
}

declare const process: { env: Record<string, string | undefined> } | undefined

function readApiKeyFromAuthStore(): string | null {
  try {
    const home = process?.env?.HOME ?? ""
    if (!home) return null
    const authPath = join(home, ".local", "share", "opencode", "auth.json")
    if (!existsSync(authPath)) return null
    const raw = readFileSync(authPath, "utf-8")
    const store: AuthStore = JSON.parse(raw)
    return store.deepseek?.key ?? null
  } catch {
    return null
  }
}

function readApiKeyFromEnv(): string | null {
  try {
    return process?.env?.DEEPSEEK_API_KEY ?? null
  } catch {
    return null
  }
}

function getDeepseekApiKey(): string | null {
  return readApiKeyFromAuthStore() ?? readApiKeyFromEnv()
}

// ---------------------------------------------------------------------------
// Balance API
// ---------------------------------------------------------------------------

async function fetchBalance(apiKey: string): Promise<BalanceResponse> {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<BalanceResponse>
}

function pickBalanceInfo(infos: BalanceInfo[]): BalanceInfo | null {
  if (infos.length === 0) return null
  const cny = infos.find((i) => i.currency === "CNY")
  return cny ?? infos[0]
}

// ---------------------------------------------------------------------------
// Color helpers (Morandi-style)
// ---------------------------------------------------------------------------

function rgb(raw: unknown): { r: number; g: number; b: number } | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale),
      }
    }
  }
  return null
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5
    ? delta / (max + min)
    : delta / (2 - max - min)
}

function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const nr = Math.round(c.r + (luma - c.r) * mid)
    const ng = Math.round(c.g + (luma - c.g) * mid)
    const nb = Math.round(c.b + (luma - c.b) * mid)
    if (saturation(nr, ng, nb) > maxSat) lo = mid
    else hi = mid
  }
  const nr = Math.round(c.r + (luma - c.r) * hi)
  const ng = Math.round(c.g + (luma - c.g) * hi)
  const nb = Math.round(c.b + (luma - c.b) * hi)
  return "#" + [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

const MAX_SAT = 0.28

const FALLBACK = {
  primary: "#8B9DAF",
  text:    "#C5C5BB",
  muted:   "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error:   "#B08A8A",
  border:  "#6B6B63",
} as const

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7F) return 1
  if (code < 0xA0) return 0
  if (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7A3) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x1F300 && code <= 0x1F64F) ||
    (code >= 0x20000 && code <= 0x3FFFD)
  ) return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false })
}

// ---------------------------------------------------------------------------
// Shared signals (created in tui() scope, passed to component)
// ---------------------------------------------------------------------------

interface PanelSignals {
  refreshTrigger: () => number
  triggerRefresh: () => void
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

const MIN_PANEL_WIDTH = 22
const DEFAULT_PANEL_WIDTH = 26

function BalancePanel(props: {
  theme: TuiThemeCurrent
  api: TuiPluginApi
  sessionId: string
  signals: PanelSignals
}): JSX.Element {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(false)
  const [data, setData] = createSignal<BalanceData>({
    isLoading: true,
    error: null,
    noKey: false,
    isAvailable: false,
    currency: "",
    totalBalance: "",
    grantedBalance: "",
    toppedUpBalance: "",
    lastUpdate: null,
  })

  let boxEl: any

  const pal = createMemo(() => {
    const t = props.theme as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(t[k], MAX_SAT, fb)
    return {
      primary: sat("primary", FALLBACK.primary),
      text:    sat("text", FALLBACK.text),
      muted:   sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error:   sat("error", FALLBACK.error),
      border:  sat("border", FALLBACK.border),
    }
  })

  const gutter = 6

  const sep = createMemo(() => "\u2500".repeat(Math.max(1, panelWidth() - gutter)))

  async function doRefresh() {
    setData((d) => ({ ...d, isLoading: true, error: null }))
    try {
      const key = getDeepseekApiKey()
      if (!key) {
        setData({
          isLoading: false, error: null, noKey: true,
          isAvailable: false, currency: "", totalBalance: "",
          grantedBalance: "", toppedUpBalance: "", lastUpdate: null,
        })
        return
      }
      const resp = await fetchBalance(key)
      const info = pickBalanceInfo(resp.balance_infos)
      if (!info) {
        setData({
          isLoading: false, error: "No balance info returned", noKey: false,
          isAvailable: resp.is_available, currency: "", totalBalance: "",
          grantedBalance: "", toppedUpBalance: "", lastUpdate: fmtTime(new Date()),
        })
        return
      }
      setData({
        isLoading: false, error: null, noKey: false,
        isAvailable: resp.is_available,
        currency: info.currency,
        totalBalance: info.total_balance,
        grantedBalance: info.granted_balance,
        toppedUpBalance: info.topped_up_balance,
        lastUpdate: fmtTime(new Date()),
      })
    } catch (e: any) {
      setData({
        isLoading: false, error: e?.message ?? "Unknown error", noKey: false,
        isAvailable: false, currency: "", totalBalance: "",
        grantedBalance: "", toppedUpBalance: "", lastUpdate: null,
      })
    }
  }

  // ── auto-refresh: after each assistant completion ──
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let lastRefreshTime = 0
  const MIN_REFRESH_INTERVAL = 5000

  function onMessageOrPartUpdate() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const now = Date.now()
      if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) return
      try {
        const msgs = props.api.state.session.messages(props.sessionId) as any[]
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m.role === "assistant" && m.tokens && (m.tokens.input > 0 || m.tokens.output > 0)) {
            lastRefreshTime = now
            doRefresh()
            break
          }
        }
      } catch {}
    }, 2000)
  }

  onMount(() => {
    doRefresh()
    lastRefreshTime = Date.now()

    const unsubMsg = props.api.event.on("message.updated", onMessageOrPartUpdate)
    const unsubPart = props.api.event.on("message.part.updated", onMessageOrPartUpdate)

    onCleanup(() => {
      clearTimeout(debounceTimer)
      unsubMsg()
      unsubPart()
    })
  })

  // Watch the shared refresh trigger (from /balance command)
  createEffect(() => {
    void props.signals.refreshTrigger()
    doRefresh()
    lastRefreshTime = Date.now()
  })

  const currencySymbol = createMemo(() => {
    const c = data().currency
    if (c === "CNY") return "\u00a5"
    if (c === "USD") return "$"
    return c
  })

  function justify(label: string, value: string): string {
    const gauge = panelWidth() - gutter
    const used = visualWidth(label) + visualWidth(value)
    const gap = Math.max(1, gauge - used)
    return label + " ".repeat(gap) + value
  }

  return (
    <box
      border
      borderColor={pal().border}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="column"
      gap={0}
      ref={boxEl}
      onSizeChange={() => {
        const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      {/* collapsible header */}
      <text onMouseUp={() => setOpen((o) => !o)}>
        <span style={{ fg: pal().muted }}>{open() ? "\u25bc " : "\u25b6 "}</span>
        <span style={{ fg: pal().primary }}>
          <b>DeepSeek 余额</b>
        </span>
        <Show when={!open() && !data().isLoading && !data().error && !data().noKey && data().totalBalance}>
          <span>
            {" ".repeat(Math.max(1, panelWidth() - gutter - 2 - visualWidth("DeepSeek 余额") - visualWidth(currencySymbol() + data().totalBalance)))}
          </span>
          <span style={{ fg: pal().success }}>{currencySymbol()}{data().totalBalance}</span>
        </Show>
      </text>

      <Show when={open()}>
        <text fg={pal().muted}>{sep()}</text>

        <Show when={!data().isLoading} fallback={
          <text fg={pal().muted}>{"\u52a0\u8f7d\u4e2d..."}</text>
        }>
          <Show when={!data().noKey} fallback={
            <>
              <text>
                <span style={{ fg: pal().warning }}>\u26a0 </span>
                <span style={{ fg: pal().text }}>{"\u672a\u627e\u5230 API Key"}</span>
              </text>
              <text fg={pal().muted}>{"  \u8bf7\u8fd0\u884c /connect \u9009\u62e9 DeepSeek"}</text>
            </>
          }>
            <Show when={!data().error} fallback={
              <text>
                <span style={{ fg: pal().error }}>\u2716 </span>
                <span style={{ fg: pal().text }}>{data().error}</span>
              </text>
            }>
              {/* status + currency row */}
              <text>
                <span style={{ fg: data().isAvailable ? pal().success : pal().error }}>
                  {data().isAvailable ? "\u2705 " : "\u274c "}
                </span>
                <span style={{ fg: pal().muted }}>{"\u53ef\u7528"}</span>
                <span>
                  {" ".repeat(Math.max(1, panelWidth() - gutter - visualWidth("\u2705 \u53ef\u7528") - visualWidth(data().currency)))}
                </span>
                <span style={{ fg: pal().text }}>{data().currency}</span>
              </text>

              <text fg={pal().muted}>{sep()}</text>

              {/* total balance */}
              <text>
                <span style={{ fg: pal().success }}>
                  <b>{currencySymbol()}{data().totalBalance}</b>
                </span>
                <span>
                  {" ".repeat(Math.max(1, panelWidth() - gutter - visualWidth(currencySymbol() + data().totalBalance) - visualWidth("\u603b\u4f59\u989d")))}
                </span>
                <span style={{ fg: pal().muted }}>{"\u603b\u4f59\u989d"}</span>
              </text>

              <text fg={pal().muted}>{sep()}</text>

              <text fg={pal().muted}>
                {justify("\u8d60\u91d1\u4f59\u989d", currencySymbol() + data().grantedBalance)}
              </text>

              <text fg={pal().muted}>
                {justify("\u5145\u503c\u4f59\u989d", currencySymbol() + data().toppedUpBalance)}
              </text>

              <Show when={data().lastUpdate}>
                <text fg={pal().muted}>{sep()}</text>
                <text fg={pal().muted}>
                  {"\u4e0a\u6b21\u66f4\u65b0: "}{data().lastUpdate}
                </text>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function createSidebarSlot(api: TuiPluginApi, signals: PanelSignals): TuiSlotPlugin {
  return {
    order: 60,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }): JSX.Element {
        return (
          <BalancePanel
            theme={ctx.theme.current}
            api={api}
            sessionId={input.session_id}
            signals={signals}
          />
        )
      },
    },
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)

  const signals: PanelSignals = {
    refreshTrigger,
    triggerRefresh: () => setRefreshTrigger((v) => v + 1),
  }

  api.slots.register(createSidebarSlot(api, signals))

  api.command?.register(() => [
    {
      title: "Balance: Refresh",
      value: "balance.refresh",
      description: "Manually refresh the DeepSeek balance display",
      slash: { name: "balance" },
      onSelect: () => {
        signals.triggerRefresh()
        api.ui.toast({ message: "DeepSeek balance refreshed", duration: 3000 })
      },
    },
  ])
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-provider-balance",
  tui,
}

export default mod
