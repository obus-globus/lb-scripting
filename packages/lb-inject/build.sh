#!/usr/bin/env bash
# Builds two jars in dist/:
#   nf-holder.jar       NfHolder only — loaded by the BOOTSTRAP classloader (via
#                       the agent jar's Boot-Class-Path) so it's visible to Knot/
#                       game/scripts and never double-loaded.
#   nf-inject-agent.jar NfInject (premain/agentmain + ASM injector) + NfAttacher,
#                       with ASM bundled. Manifest points Boot-Class-Path at
#                       nf-holder.jar (must sit next to it at runtime).
# Compiled with JDK 21 so the jars load on any Java 21+ runtime.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$here"

JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
JAVAC="$JAVA_HOME/bin/javac"; JAR="$JAVA_HOME/bin/jar"
ASM_JAR="${ASM_JAR:-$(find "$HOME/.gradle/caches" -name 'asm-9*.jar' ! -name '*sources*' 2>/dev/null | sort -V | tail -1)}"
[ -f "$ASM_JAR" ] || { echo "FAIL: no ASM jar found (set ASM_JAR=)" >&2; exit 1; }
echo "ASM: $ASM_JAR"

rm -rf build && mkdir -p build/holder build/agent dist

# 1. NfHolder -> nf-holder.jar (bootstrap holder, no deps)
"$JAVAC" --release 21 -d build/holder src/NfHolder.java
"$JAR" cf dist/nf-holder.jar -C build/holder NfHolder.class

# 2. NfInject + NfAttacher -> nf-inject-agent.jar. ASM is NOT bundled: Fabric
#    Loader already ships ASM on the classpath, and bundling it triggers Fabric's
#    "duplicate ASM classes" verifyClasspath check. We only compile against ASM.
"$JAVAC" --release 21 --add-modules jdk.attach -cp "$ASM_JAR:build/holder" -d build/agent src/NfInject.java src/NfAttacher.java
cat > build/MANIFEST.MF <<'EOF'
Manifest-Version: 1.0
Premain-Class: NfInject
Agent-Class: NfInject
Can-Retransform-Classes: true
Can-Redefine-Classes: true
Boot-Class-Path: nf-holder.jar
EOF
# include ALL compiled classes (NfInject + its anonymous inner classes NfInject$1.. + NfAttacher)
"$JAR" cfm dist/nf-inject-agent.jar build/MANIFEST.MF -C build/agent .
echo "built dist/nf-inject-agent.jar ($(du -h dist/nf-inject-agent.jar|cut -f1)) + dist/nf-holder.jar ($(du -h dist/nf-holder.jar|cut -f1))"
