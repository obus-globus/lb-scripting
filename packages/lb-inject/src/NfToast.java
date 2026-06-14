import javax.swing.JDialog;
import javax.swing.JOptionPane;
import javax.swing.UIManager;

/**
 * Tiny stand-alone message box. NOT shipped inside the jars — its compiled
 * bytecode is embedded (base64) in the generated nf-inject JS by make-bundle.sh,
 * written to disk at runtime and launched as a separate process
 * ({@code java -cp <dir> NfToast <severity> <message>}). Running it out-of-process
 * gives it its own AWT event thread, so the dialog reliably shows regardless of
 * what Minecraft's render thread / GraalJS are doing — unlike an in-process modal
 * shown from the render thread, which is flaky.
 *
 *   args[0] = severity: ERROR | SUCCESS | INFO   (anything else -> INFO)
 *   args[1] = message (a single argument; may contain spaces / newlines)
 */
public final class NfToast {
    public static void main(String[] args) {
        try {
            String sev = args.length > 0 ? args[0] : "INFO";
            String msg = args.length > 1 ? args[1] : "";
            int type = "ERROR".equalsIgnoreCase(sev) ? JOptionPane.ERROR_MESSAGE
                                                      : JOptionPane.INFORMATION_MESSAGE;
            try { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()); } catch (Throwable ignored) { }

            String html = "<html><body style='width:430px;font-family:sans-serif'>"
                    + escape(msg).replace("\n", "<br>") + "</body></html>";

            JOptionPane pane = new JOptionPane(html, type);
            JDialog dlg = pane.createDialog(null, "nf-inject");
            dlg.setAlwaysOnTop(true);
            dlg.setLocationRelativeTo(null);   // centre on the screen
            dlg.setModal(true);
            dlg.setVisible(true);              // blocks until the user clicks OK
            dlg.dispose();
        } catch (Throwable t) {
            System.out.println("nf-inject: " + (args.length > 1 ? args[1] : ""));
        }
        System.exit(0);
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private NfToast() { }
}
