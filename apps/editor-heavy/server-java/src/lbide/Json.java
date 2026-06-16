package lbide;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal dependency-free JSON parser/serializer for the bridge protocol.
 * parse() yields Map/List/String/Double/Boolean/null; stringify() does the inverse.
 * Sufficient for the small control messages exchanged here (not a general library).
 */
final class Json {
    private final String s;
    private int i;
    private int depth;
    private static final int MAX_DEPTH = 64; // guard against stack-overflow from deeply nested input
    private Json(String s) { this.s = s; }

    static Object parse(String s) {
        Json j = new Json(s);
        j.ws();
        Object v = j.value();
        j.ws();
        return v;
    }

    // checked single-char read (throws instead of StringIndexOutOfBounds on truncated input)
    private char next() { if (i >= s.length()) throw new RuntimeException("unexpected end of JSON"); return s.charAt(i++); }

    @SuppressWarnings("unchecked")
    static Map<String, Object> obj(Object o) { return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>(); }
    static String str(Object o) { return o == null ? null : String.valueOf(o); }
    static boolean bool(Object o) { return Boolean.TRUE.equals(o); }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private Object value() {
        if (i >= s.length()) throw new RuntimeException("unexpected end of JSON");
        char c = s.charAt(i);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': i += 4; return Boolean.TRUE;
            case 'f': i += 5; return Boolean.FALSE;
            case 'n': i += 4; return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        if (++depth > MAX_DEPTH) throw new RuntimeException("JSON nesting too deep");
        try {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; ws();
            if (next() == '}') { return m; }
            i--; // not '}', step back and parse entries
            while (true) {
                ws();
                String k = string();
                ws(); next(); /* : */ ws();
                m.put(k, value());
                ws();
                char c = next();
                if (c == '}') break;
            }
            return m;
        } finally { depth--; }
    }

    private List<Object> array() {
        if (++depth > MAX_DEPTH) throw new RuntimeException("JSON nesting too deep");
        try {
            List<Object> a = new ArrayList<>();
            i++; ws();
            if (next() == ']') { return a; }
            i--; // not ']', step back and parse elements
            while (true) {
                ws();
                a.add(value());
                ws();
                char c = next();
                if (c == ']') break;
            }
            return a;
        } finally { depth--; }
    }

    private String string() {
        StringBuilder b = new StringBuilder();
        next(); /* opening quote */
        while (true) {
            char c = next();
            if (c == '"') break;
            if (c == '\\') {
                char e = next();
                switch (e) {
                    case 'n': b.append('\n'); break;
                    case 't': b.append('\t'); break;
                    case 'r': b.append('\r'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case '/': b.append('/'); break;
                    case '\\': b.append('\\'); break;
                    case '"': b.append('"'); break;
                    case 'u': if (i + 4 > s.length()) throw new RuntimeException("bad \\u escape"); b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        if (i == start) throw new RuntimeException("invalid JSON value");
        return Double.parseDouble(s.substring(start, i));
    }

    static String stringify(Object o) {
        StringBuilder b = new StringBuilder();
        write(b, o);
        return b.toString();
    }

    private static void write(StringBuilder b, Object o) {
        if (o == null) { b.append("null"); return; }
        if (o instanceof String) { writeStr(b, (String) o); return; }
        // integral doubles → no ".0" (parse widens every number to Double; keep ints as ints on the wire)
        if (o instanceof Double) { double d = (Double) o; if (d == Math.rint(d) && !Double.isInfinite(d)) b.append(Long.toString((long) d)); else b.append(Double.toString(d)); return; }
        if (o instanceof Boolean || o instanceof Number) { b.append(o.toString()); return; }
        if (o instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                if (e.getValue() == null) continue;
                if (!first) b.append(',');
                first = false;
                writeStr(b, String.valueOf(e.getKey()));
                b.append(':');
                write(b, e.getValue());
            }
            b.append('}');
            return;
        }
        if (o instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object e : (List<?>) o) { if (!first) b.append(','); first = false; write(b, e); }
            b.append(']');
            return;
        }
        writeStr(b, o.toString());
    }

    private static void writeStr(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
    }
}
