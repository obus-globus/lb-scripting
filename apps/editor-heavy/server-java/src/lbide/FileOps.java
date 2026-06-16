package lbide;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Standalone ops backed by a projects directory (mirrors the in-client host's
 * lb-ide/projects/&lt;id&gt;.json). load/repl only record (no real client here);
 * the in-LB build replaces this with a ScriptManager-backed impl.
 */
final class FileOps implements Ops {
    private final Path projDir;
    private final Path scriptsDir;   // the LiquidBounce scripts/ folder (installed .js/.mjs)
    private final Path templatesDir; // lb-ide/templates/ (user + fetched template docs)
    private final java.util.function.Consumer<String> log;
    Map<String, Object> lastLoad;

    FileOps(Path projDir, Path scriptsDir, Path templatesDir, java.util.function.Consumer<String> log) {
        this.projDir = projDir;
        this.scriptsDir = scriptsDir;
        this.templatesDir = templatesDir;
        this.log = log;
        try { Files.createDirectories(projDir); Files.createDirectories(scriptsDir); Files.createDirectories(templatesDir); } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    private static String sanitizeId(Object id) {
        String s = id == null ? "" : String.valueOf(id).replaceAll("[^a-zA-Z0-9._-]", "");
        return s.matches("\\.+") ? "" : s; // reject empty / dot-only (no "."/".." artifacts)
    }

    @Override public Map<String, Object> ping() {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", true); r.put("root", projDir.toString());
        return r;
    }

    @Override public List<Object> projects() {
        List<Object> out = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(projDir, "*.json")) {
            for (Path p : ds) {
                try { out.add(Json.parse(Files.readString(p))); } catch (Exception ignored) { /* skip bad file */ }
            }
        } catch (IOException ignored) { /* empty */ }
        return out;
    }

    @Override public List<Object> scripts() {
        List<Object> out = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(scriptsDir, "*.{js,mjs}")) {
            for (Path p : ds) out.add(p.getFileName().toString());
        } catch (IOException ignored) { /* empty / no dir */ }
        return out;
    }

    @Override public Map<String, Object> script(String name) {
        Map<String, Object> r = new LinkedHashMap<>();
        // sanitize to a single safe filename segment (no traversal) — mirrors the in-client readScript.
        String fname = name == null ? "" : name.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (fname.isEmpty() || fname.matches("\\.+")) { r.put("ok", false); return r; }
        Path p = scriptsDir.resolve(fname);
        if (!Files.exists(p)) { r.put("ok", false); return r; }
        try { r.put("ok", true); r.put("name", name); r.put("content", Files.readString(p)); }
        catch (IOException e) { r.put("ok", false); r.put("error", e.getMessage()); }
        return r;
    }

    @Override public List<Object> templates() {
        List<Object> out = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(templatesDir, "*.json")) {
            for (Path p : ds) { try { out.add(Json.parse(Files.readString(p))); } catch (Exception ignored) { /* skip bad file */ } }
        } catch (IOException ignored) { /* empty */ }
        return out;
    }

    @Override public Map<String, Object> saveTemplate(Map<String, Object> tmpl) {
        String id = sanitizeId(tmpl.get("id"));
        Map<String, Object> r = new LinkedHashMap<>();
        if (id.isEmpty()) { r.put("ok", false); r.put("error", "bad template id"); return r; }
        try {
            Files.writeString(templatesDir.resolve(id + ".json"), Json.stringify(tmpl));
            log.accept("saveTemplate " + id);
            r.put("ok", true); r.put("id", id);
        } catch (IOException e) { r.put("ok", false); r.put("error", e.getMessage()); }
        return r;
    }

    @Override public Map<String, Object> deleteTemplate(String id) {
        String sid = sanitizeId(id);
        Map<String, Object> r = new LinkedHashMap<>();
        if (sid.isEmpty()) { r.put("ok", false); r.put("error", "bad template id"); return r; }
        try { boolean del = Files.deleteIfExists(templatesDir.resolve(sid + ".json")); log.accept("deleteTemplate " + sid); r.put("ok", true); r.put("deleted", del); }
        catch (IOException e) { r.put("ok", false); r.put("error", e.getMessage()); }
        return r;
    }

    @Override public Map<String, Object> save(Map<String, Object> project) {
        String id = sanitizeId(project.get("id"));
        Map<String, Object> r = new LinkedHashMap<>();
        if (id.isEmpty()) { r.put("ok", false); r.put("error", "bad project id"); return r; }
        try {
            Files.writeString(projDir.resolve(id + ".json"), Json.stringify(project));
            log.accept("save " + id + " (" + Json.obj(project.get("files")).size() + " files)");
            r.put("ok", true); r.put("id", id);
        } catch (IOException e) { r.put("ok", false); r.put("error", e.getMessage()); }
        return r;
    }

    @Override public Map<String, Object> load(String name, String mjs, boolean debug) {
        lastLoad = new LinkedHashMap<>();
        lastLoad.put("name", name);
        lastLoad.put("mjsLen", mjs == null ? 0 : mjs.length());
        log.accept("load " + name + " (" + (mjs == null ? 0 : mjs.length()) + "B)");
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", true); r.put("loaded", name); r.put("enabled", true);
        if (debug) r.put("debugPort", 9229);
        return r;
    }

    @Override public Map<String, Object> repl(String code) {
        log.accept("repl> " + code);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", true); r.put("result", "(eval stub)");
        return r;
    }
}
