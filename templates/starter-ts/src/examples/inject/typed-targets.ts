// lb-inject × @wunk/lb-script-api-types — typed injection targets.
//
// THE POINT OF THIS FILE: lb-inject takes the target class+method as plain
// STRINGS — `Inject.inject("net.minecraft.client.Minecraft", "getFps", ...)`.
// A typo ("getFsp") or a method that doesn't exist on that class fails only at
// runtime, deep inside the agent. But we already ship a full type tree for
// every JVM class (the script-api-types package). This example builds a thin
// typed facade over `Inject` that uses those types to CHECK the method name at
// compile time — so a bad target is a red squiggle, not a runtime surprise.
//
// This is the "what does typing unlock" demo from the README's Ideas section.

import { Inject } from "lb-inject";
import type { Minecraft } from "@wunk/lb-script-api-types/types/net/minecraft/client/Minecraft";

// --- the typed facade -------------------------------------------------------
// MethodKeys<T> = the names of T's callable members. If T has none (or is
// loosely typed), MethodNames<T> degrades to `string`, so the facade never
// gets in your way for classes whose types are sparse.
type MethodKeys<T> = { [K in keyof T]-?: T[K] extends (...args: any[]) => any ? K : never }[keyof T] & string;
type MethodNames<T> = [MethodKeys<T>] extends [never] ? string : MethodKeys<T>;

/** Patch the HEAD of `T#method`, with `method` checked against T's real members. */
function injectHead<T>(fqcn: string, method: MethodNames<T>, hook: () => void) {
  return Inject.inject(fqcn, method, "HEAD", hook);
}

/** Patch the RETURN of `T#method`. */
function injectReturn<T>(fqcn: string, method: MethodNames<T>, hook: () => void) {
  return Inject.inject(fqcn, method, "RETURN", hook);
}

// --- usage ------------------------------------------------------------------
registerScript({ name: "TypedTargets", version: "1.0.0", authors: ["Obus"] });

let calls = 0;

// `"getFps"` autocompletes from Minecraft's typed members and is verified to
// exist. Pass `<Minecraft>` as the type arg; the facade constrains `method`.
injectHead<Minecraft>("net.minecraft.client.Minecraft", "getFps", () => { calls++; });

injectReturn<Minecraft>("net.minecraft.client.Minecraft", "tick", () => {
  if (calls > 0 && calls % 600 === 0) {
    Client.displayChatMessage(`§b[TypedTargets] getFps called ${calls}x`);
  }
});

// A method that doesn't exist on Minecraft is a COMPILE error — uncomment to see:
//   injectHead<Minecraft>("net.minecraft.client.Minecraft", "totallyNotAMethod", () => {});
// @ts-expect-error — "totallyNotAMethod" is not a member of Minecraft
const _badTarget: MethodNames<Minecraft> = "totallyNotAMethod";
void _badTarget;

Client.displayChatMessage("§a[TypedTargets] typed hooks installed");
