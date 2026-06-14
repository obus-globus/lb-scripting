import java.lang.instrument.Instrumentation;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Shared state holder, loaded by the BOOTSTRAP classloader (via the agent jar's
 * {@code Boot-Class-Path: nf-holder.jar} manifest entry). Bootstrap classes are
 * visible to every classloader — Fabric's isolating Knot loader, the game
 * classes, and GraalJS scripts — so:
 *   - the script can reach the injector/Instrumentation via Java.type("NfHolder"),
 *   - the injected bytecode can call {@link #fire(int)} (a system- or agent-loaded
 *     dispatcher class would NOT be visible to the Knot-loaded target → the prior
 *     NoClassDefFoundError),
 * all WITHOUT putting non-String objects into System.getProperties() (which breaks
 * code that treats system properties as String→String, e.g. Gradle).
 */
public final class NfHolder {
    public static volatile Instrumentation inst;
    public static volatile Function<Object[], Object> injector;
    public static volatile Function<Object[], Object> remover;
    public static final Map<Integer, Runnable> hooks = new ConcurrentHashMap<>();

    /** Injected at the patch site as {@code INVOKESTATIC NfHolder.fire(<id>)}. */
    public static void fire(int id) {
        Runnable r = hooks.get(Integer.valueOf(id));
        if (r != null) {
            try { r.run(); } catch (Throwable ignored) { }
        }
    }

    private NfHolder() { }
}
