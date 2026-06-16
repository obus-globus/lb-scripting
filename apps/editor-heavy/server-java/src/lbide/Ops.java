package lbide;

import java.util.List;
import java.util.Map;

/**
 * The ScriptManager bridge operations, transport-agnostic. The standalone server
 * uses {@link FileOps}; the in-LB-client build plugs in an impl that calls
 * net.ccbluex.liquidbounce.script.ScriptManager on the Minecraft thread.
 * Security (Origin check, token, the userGesture requirement for load/repl) is
 * enforced by the server before these are invoked.
 */
interface Ops {
    Map<String, Object> ping();                                   // {ok, root}
    List<Object> projects();                                      // full project objects
    List<Object> scripts();                                       // installed script filenames (scripts/ folder)
    Map<String, Object> script(String name);                      // {ok, name, content} | {ok:false}
    List<Object> templates();                                     // user/fetched template docs (lb-ide/templates/)
    Map<String, Object> template(String id);                      // one template doc | {ok:false}
    Map<String, Object> saveTemplate(Map<String, Object> tmpl);   // {ok, id}
    Map<String, Object> deleteTemplate(String id);                // {ok, deleted}
    Map<String, Object> save(Map<String, Object> project);        // {ok, id}
    Map<String, Object> load(String name, String mjs, boolean debug); // {ok, loaded, enabled, debugPort?}
    Map<String, Object> repl(String code);                        // {ok, result}
}
