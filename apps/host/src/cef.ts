/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// Open the IDE in a chrome-less, full-screen CEF view in-game, using the same
// browser backend LiquidBounce's ClickGUI uses. Adapted from lb-nodeflow's
// openEditorScreen (host.ts). All Java.type lookups are guarded so a changed or
// absent LB degrades to `false`. setScreen runs on the MC thread.

declare const Java: { type(name: string): unknown; extend(t: unknown): unknown };

let currentEditorScreen: unknown = null;

export function openEditorScreen(url: string, blur = true): boolean {
  try {
    const ScreenT = Java.type("net.minecraft.client.gui.screens.Screen") as unknown;
    const Component = Java.type("net.minecraft.network.chat.Component") as unknown as { literal(s: string): unknown };
    const BBM = Java.type("net.ccbluex.liquidbounce.integration.backend.BrowserBackendManager") as unknown as {
      INSTANCE: { getBackend(): { createBrowser(u: string, vp: unknown, s: unknown, prio: number, ia: unknown): { close(): void } } | null };
    };
    const BV = Java.type("net.ccbluex.liquidbounce.integration.backend.browser.BrowserViewport") as unknown as new (x: number, y: number, w: number, h: number, full: boolean) => unknown;
    const BS = Java.type("net.ccbluex.liquidbounce.integration.backend.browser.BrowserSettings") as unknown as new (fps: number, cb: () => void) => unknown;
    const backend = BBM?.INSTANCE?.getBackend?.();
    if (!ScreenT || !Component || !backend || !BV || !BS) return false;

    const Sub = Java.extend(ScreenT) as unknown as new (title: unknown, overrides: Record<string, unknown>) => unknown;
    const holder: { screen: unknown; browser: { close(): void } | null } = { screen: null, browser: null };
    const win = (mc as unknown as { getWindow(): { getWidth(): number; getHeight(): number } }).getWindow();
    const overrides: Record<string, unknown> = {
      init: () => {
        try {
          const vp = new BV(0, 0, win.getWidth(), win.getHeight(), true);
          const settings = new BS(0, () => { /* */ });
          const inputAcceptor = (): boolean => (mc as unknown as { screen: unknown }).screen === holder.screen;
          holder.browser = backend.createBrowser(url, vp, settings, 20, inputAcceptor);
        } catch { /* */ }
      },
      isPauseScreen: () => false,
      // a text editor needs Esc for its own UI (find widget); let the page keep it
      shouldCloseOnEsc: () => false,
      onClose: () => { try { holder.browser?.close(); } catch { /* */ } },
    };
    if (!blur) overrides.renderBackground = (): void => { /* skip blur/dim */ };
    holder.screen = new Sub(Component.literal("LB Script IDE"), overrides);

    currentEditorScreen = holder.screen;
    const m = mc as unknown as { setScreen(s: unknown): void; execute?(r: () => void): void };
    if (typeof m.execute === "function") m.execute(() => { try { m.setScreen(holder.screen); } catch { /* */ } });
    else m.setScreen(holder.screen);
    return true;
  } catch { return false; }
}

export function closeEditorScreen(): void {
  try {
    const m = mc as unknown as { screen: unknown; setScreen(s: unknown): void; execute?(r: () => void): void };
    const run = (): void => { try { if (m.screen === currentEditorScreen) m.setScreen(null); } catch { /* */ } };
    if (typeof m.execute === "function") m.execute(run); else run();
  } catch { /* */ }
}
