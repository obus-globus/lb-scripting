import com.sun.tools.attach.VirtualMachine;

/**
 * External attacher (runs as a separate process): attaches to the game JVM by
 * pid and loadAgent()s the injection jar so its agentmain hands over an
 * Instrumentation. Used only on the JDK path (the spawned `java` needs the
 * jdk.attach module). Bundled in nf-inject-agent.jar so no runtime compile is
 * needed: `java -cp nf-inject-agent.jar --add-modules jdk.attach NfAttacher <pid> <jar>`.
 */
public final class NfAttacher {
    public static void main(String[] args) throws Exception {
        VirtualMachine vm = VirtualMachine.attach(args[0]);
        try {
            vm.loadAgent(args[1]);
            System.out.println("loadAgent OK on pid " + args[0]);
        } finally {
            vm.detach();
        }
    }

    private NfAttacher() { }
}
