import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.function.Function;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/**
 * Generic, precompiled injection agent for LiquidBounce GraalJS scripts.
 *
 * Two ways it gets an {@link Instrumentation}, both routed through {@link #init}:
 *   - launch-time:  java -javaagent:nf-inject-agent.jar      -> premain(..)
 *   - runtime:      VirtualMachine.attach(pid).loadAgent(jar) -> agentmain(..)
 *
 * On init it publishes, on {@link NfHolder} (bootstrap-loaded via this jar's
 * {@code Boot-Class-Path: nf-holder.jar}, so it's visible to the script AND to
 * the Knot-loaded target, with no System-properties pollution):
 *   NfHolder.inst      the Instrumentation
 *   NfHolder.injector  Function apply([inst, classInternal, method, position,
 *                        hookId, targetOwner|null, targetName|null]) -> transformer
 *   NfHolder.remover   Function apply([inst, transformer, classInternal]) -> "removed"
 *
 * The script registers its hook Runnable in NfHolder.hooks[id]; the injected
 * bytecode is just {@code INVOKESTATIC NfHolder.fire(id)}. ASM is bundled here.
 * Positions: HEAD, RETURN, BEFORE_INVOKE, AFTER_INVOKE, BEFORE_FIELD, AFTER_FIELD.
 */
public final class NfInject {

    public static void premain(String args, Instrumentation inst) { init(inst); }
    public static void agentmain(String args, Instrumentation inst) { init(inst); }

    private static void init(Instrumentation inst) {
        NfHolder.inst = inst;
        NfHolder.injector = NfInject::inject;
        NfHolder.remover = NfInject::remove;
    }

    private static Object inject(Object[] a) {
        final Instrumentation inst = (Instrumentation) a[0];
        final String clazz = (String) a[1];          // internal: net/minecraft/client/Minecraft
        final String method = (String) a[2];
        final String pos = (String) a[3];
        final int id = ((Number) a[4]).intValue();
        final String tOwner = (String) a[5];
        final String tName = (String) a[6];

        ClassFileTransformer tr = new ClassFileTransformer() {
            @Override
            public byte[] transform(ClassLoader loader, String cn, Class<?> cbr, ProtectionDomain pd, byte[] buf) {
                if (cn == null || !cn.equals(clazz)) return null;
                ClassReader cr = new ClassReader(buf);
                ClassWriter cw = new ClassWriter(cr, ClassWriter.COMPUTE_MAXS);
                cr.accept(new ClassVisitor(Opcodes.ASM9, cw) {
                    @Override
                    public MethodVisitor visitMethod(int ac, String n, String d, String s, String[] e) {
                        MethodVisitor mv = super.visitMethod(ac, n, d, s, e);
                        if (mv == null || !n.equals(method)) return mv;
                        return new MethodVisitor(Opcodes.ASM9, mv) {
                            private void fire() {
                                super.visitLdcInsn(Integer.valueOf(id));
                                super.visitMethodInsn(Opcodes.INVOKESTATIC, "NfHolder", "fire", "(I)V", false);
                            }
                            @Override public void visitCode() {
                                super.visitCode();
                                if (pos.equals("HEAD")) fire();
                            }
                            @Override public void visitInsn(int op) {
                                if (op >= Opcodes.IRETURN && op <= Opcodes.RETURN && pos.equals("RETURN")) fire();
                                super.visitInsn(op);
                            }
                            @Override public void visitMethodInsn(int op, String o, String nm, String dd, boolean itf) {
                                boolean m = tOwner != null && o.equals(tOwner) && nm.equals(tName);
                                if (m && pos.equals("BEFORE_INVOKE")) fire();
                                super.visitMethodInsn(op, o, nm, dd, itf);
                                if (m && pos.equals("AFTER_INVOKE")) fire();
                            }
                            @Override public void visitFieldInsn(int op, String o, String nm, String dd) {
                                boolean m = tOwner != null && o.equals(tOwner) && nm.equals(tName);
                                if (m && pos.equals("BEFORE_FIELD")) fire();
                                super.visitFieldInsn(op, o, nm, dd);
                                if (m && pos.equals("AFTER_FIELD")) fire();
                            }
                        };
                    }
                }, 0);
                return cw.toByteArray();
            }
        };
        inst.addTransformer(tr, true);
        try {
            inst.retransformClasses(Class.forName(clazz.replace('/', '.'), false, Thread.currentThread().getContextClassLoader()));
        } catch (Throwable ex) {
            inst.removeTransformer(tr);
            throw new RuntimeException(String.valueOf(ex));
        }
        return tr;
    }

    private static Object remove(Object[] a) {
        Instrumentation inst = (Instrumentation) a[0];
        inst.removeTransformer((ClassFileTransformer) a[1]);
        try {
            inst.retransformClasses(Class.forName(((String) a[2]).replace('/', '.'), false, Thread.currentThread().getContextClassLoader()));
        } catch (Throwable ignored) { }
        return "removed";
    }

    private NfInject() { }
}
