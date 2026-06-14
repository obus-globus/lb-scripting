// setup-references.mjs — bootstrap a local `references/` folder for source
// navigation while writing scripts.
//
// What it does:
//   1. clones the LiquidBounce source into  references/liquidbounce  (shallow),
//   2. runs LiquidBounce's own Gradle build to **decompile Minecraft** (Loom's
//      `genSources` task), so you get readable MC + LB sources.
//
// Why: `@wunk/lb-script-api-types` tells you the *shape* of a class; the
// decompiled sources tell you its *behavior*. With this, "go to definition" on a
// `Java.type("net.minecraft.client.Minecraft")` handle lands in real source.
//
// This is HEAVY and entirely OPT-IN (it is NOT part of `npm install`): a full
// clone + decompile downloads hundreds of MB and takes several minutes. The
// `references/` folder is gitignored — decompiled Minecraft is for local
// reference only, never commit it.
//
// Usage:
//   npm run setup:references                 # clone default branch + decompile
//   LB_REF=<branch|tag|sha> npm run setup:references   # pin to a specific LB ref
//   node scripts/setup-references.mjs --ref <branch|tag|sha>
//   node scripts/setup-references.mjs --no-decompile    # clone only, skip genSources
//
// Pick an `LB_REF` matching your installed @wunk/lb-script-api-types line (e.g.
// the LB release whose mod_version is on the 0.38 line for the 0.38.x types).
//
// Requirements: git, and a JDK matching LiquidBounce's toolchain (currently
// JDK 25). Set JAVA_HOME to a suitable JDK if the one on PATH isn't right.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REF_DIR = join(projectRoot, "references");
const LB_DIR = join(REF_DIR, "liquidbounce");
const LB_REPO = "https://github.com/ccbluex/liquidbounce.git";

const argv = process.argv.slice(2);
function argVal(name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const REF = process.env.LB_REF || argVal("--ref");          // optional: pin a branch/tag/sha
const NO_DECOMPILE = argv.includes("--no-decompile");
const isWin = process.platform === "win32";

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }
function step(msg) { console.log(`\n▶ ${msg}`); }

function run(cmd, args, opts = {}) {
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
    if (r.error) die(`failed to launch \`${cmd}\`: ${r.error.message}`);
    return r.status ?? 1;
}

function have(cmd) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    return !r.error && (r.status === 0 || r.status === null);
}

// Best-effort JDK resolution. Prefer JAVA_HOME if it looks like a JDK; otherwise
// fall back to the `java` on PATH (and, on Linux, scan /usr/lib/jvm for a JDK
// matching the toolchain version). We don't hard-fail on a version mismatch —
// Gradle's toolchain may still resolve a suitable JDK — but we warn loudly.
const TOOLCHAIN_JDK = "25";   // LiquidBounce build toolchain (gradle/libs.versions.toml: jdk)

function javaVersionOf(home) {
    const javaBin = join(home, "bin", isWin ? "java.exe" : "java");
    if (!existsSync(javaBin)) return null;
    const r = spawnSync(javaBin, ["-version"], { encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const m = out.match(/version "(\d+)/);
    return m ? { home, major: m[1] } : { home, major: "?" };
}

function resolveJdk() {
    if (process.env.JAVA_HOME) {
        const v = javaVersionOf(process.env.JAVA_HOME);
        if (v) return v;
        console.warn(`  ! JAVA_HOME=${process.env.JAVA_HOME} has no bin/java — ignoring it`);
    }
    // Linux: scan /usr/lib/jvm for *real* JDKs (a dir with bin/java — skips the
    // hidden *.jinfo metadata files), then prefer one matching the toolchain
    // major, else the first valid one.
    const jvmRoot = "/usr/lib/jvm";
    if (!isWin && existsSync(jvmRoot)) {
        const candidates = readdirSync(jvmRoot)
            .map((d) => javaVersionOf(join(jvmRoot, d)))     // null if no bin/java
            .filter(Boolean);
        const pick = candidates.find((v) => v.major === TOOLCHAIN_JDK) || candidates[0];
        if (pick) return pick;
    }
    // Fall back to whatever `java` is on PATH (let Gradle find it via PATH).
    if (have("java")) return { home: null, major: "?" };
    return null;
}

// ── prerequisites ──────────────────────────────────────────────────────────
step("Checking prerequisites");
if (!have("git")) die("git is required but was not found on PATH.");
console.log("  git ✓");

const jdk = resolveJdk();
if (!jdk) {
    die(`no JDK found. LiquidBounce needs JDK ${TOOLCHAIN_JDK}. Install it and/or set JAVA_HOME.`);
}
const gradleEnv = { ...process.env };
if (jdk.home) gradleEnv.JAVA_HOME = jdk.home;
console.log(`  JDK ✓  ${jdk.home ?? "(java on PATH)"}  [major ${jdk.major}]`);
if (jdk.major !== "?" && jdk.major !== TOOLCHAIN_JDK) {
    console.warn(`  ! this JDK is major ${jdk.major} but LiquidBounce's toolchain wants ${TOOLCHAIN_JDK}.`);
    console.warn(`    The build may fail or auto-provision a toolchain. Set JAVA_HOME to a JDK ${TOOLCHAIN_JDK} if so.`);
}

// ── clone ──────────────────────────────────────────────────────────────────
mkdirSync(REF_DIR, { recursive: true });

if (existsSync(join(LB_DIR, ".git"))) {
    step(`LiquidBounce already cloned at references/liquidbounce — skipping clone`);
    console.log("  (delete that folder and re-run to get a fresh checkout)");
} else {
    step(`Cloning LiquidBounce${REF ? ` @ ${REF}` : ""} into references/liquidbounce (shallow)`);
    const cloneArgs = ["clone", "--depth", "1"];
    if (REF) cloneArgs.push("--branch", REF);
    cloneArgs.push(LB_REPO, LB_DIR);
    if (run("git", cloneArgs) !== 0) {
        die(`git clone failed.${REF ? ` Is "${REF}" a valid branch/tag? (a raw commit sha needs a full clone — remove --depth)` : ""}`);
    }
}

// report what we got
try {
    const props = readFileSync(join(LB_DIR, "gradle.properties"), "utf8");
    const ver = props.match(/mod_version\s*=\s*(.+)/)?.[1]?.trim();
    const mc = props.match(/mod_mc_version\s*=\s*(.+)/)?.[1]?.trim();
    console.log(`  checked out LiquidBounce mod_version=${ver ?? "?"}  (MC ${mc ?? "?"})`);
} catch { /* not fatal */ }

if (NO_DECOMPILE) {
    step("Skipping decompile (--no-decompile). Clone is ready at references/liquidbounce");
    process.exit(0);
}

// ── decompile (Loom genSources) ────────────────────────────────────────────
step("Decompiling Minecraft via LiquidBounce's Gradle (Loom genSources) — this takes several minutes");
const gradlew = isWin ? "gradlew.bat" : "./gradlew";
const status = run(gradlew, ["genSources"], { cwd: LB_DIR, env: gradleEnv });
if (status !== 0) {
    die("genSources failed. Most common cause: wrong JDK — set JAVA_HOME to a JDK "
        + `${TOOLCHAIN_JDK} and re-run. You can also re-run just this step from references/liquidbounce.`);
}

step("Done");
console.log(`  Decompiled sources are attached to the LiquidBounce Gradle project at:
    references/liquidbounce

  Open that folder in your IDE (IntelliJ IDEA, or VS Code) and let it import the
  Gradle project — "go to definition" on a JVM class (e.g. the type behind a
  Java.type("net.minecraft.client.Minecraft")) will then land in real source.

  references/ is gitignored — decompiled Minecraft is local-only, don't commit it.`);
